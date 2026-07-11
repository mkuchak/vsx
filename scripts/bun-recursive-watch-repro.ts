#!/usr/bin/env bun
// Reproduces two behaviors of Bun's `fs.watch(dir, { recursive: true })` on Linux
// (verified on Bun 1.3.14), neither of which has an upstream issue:
//
//   1. The initial directory-tree crawl runs SYNCHRONOUSLY on the event-loop
//      thread. `fs.watch()` does not return until every subdirectory has been
//      registered, so the loop is frozen for the whole crawl. This regressed in
//      the fs.watch rewrite (oven-sh/bun#29952, shipped 1.3.14); pre-1.3.14 the
//      crawl ran on a background WorkPool.
//   2. When a per-directory `inotify_add_watch` fails on a CHILD directory
//      mid-crawl (including ENOSPC once fs.inotify.max_user_watches is exhausted),
//      the failure is silently swallowed: no throw, no 'error' event. The watcher
//      reports success while covering only part of the tree.
//
// This script builds a synthetic directory tree in the OS temp dir, then measures:
//   (a) how long the fs.watch() call blocks before returning,
//   (b) event-loop liveness via a fine interval ticker (max observed gap),
//   (c) the process's real inotify watch count (from /proc/self/fdinfo/*) vs. the
//       number of directories in the tree — on a watch-budget-constrained system
//       these diverge with no error, demonstrating behavior (2).
//
// Usage: bun scripts/bun-recursive-watch-repro.ts [dirCount]   (default 30000)
//
// It only touches a fresh temp directory and removes it on exit, even on error.

import { watch } from "node:fs"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DEFAULT_DIRS = 30_000
const isLinux = process.platform === "linux"

function parseDirCount(): number {
  const raw = process.argv[2]
  if (raw === undefined) return DEFAULT_DIRS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid dirCount "${raw}"; expected a positive integer.`)
    process.exit(1)
  }
  return n
}

// Build a two-level fan-out tree so no single directory holds an unrealistic
// number of children. Returns the actual number of directories created (the
// group dirs plus their leaf children), which is what a recursive watch registers.
function buildTree(root: string, targetDirs: number): number {
  const GROUP_SIZE = 256
  let created = 0
  let group = -1
  let groupDir = ""
  while (created < targetDirs) {
    if (created % GROUP_SIZE === 0) {
      group++
      groupDir = join(root, `g${group}`)
      mkdirSync(groupDir)
      created++
      if (created >= targetDirs) break
    }
    mkdirSync(join(groupDir, `d${created}`))
    created++
  }
  return created
}

// Count real inotify watches held by this process. Each inotify fd exposes one
// `inotify wd:...` line per active watch in /proc/self/fdinfo/<fd>.
function countInotifyWatches(): number {
  let count = 0
  const dir = "/proc/self/fdinfo"
  for (const entry of readdirSync(dir)) {
    try {
      const content = readFileSync(join(dir, entry), "utf8")
      for (const line of content.split("\n")) {
        if (line.startsWith("inotify")) count++
      }
    } catch {
      // fd may vanish between readdir and read; ignore.
    }
  }
  return count
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const fmtMs = (ms: number) => `${ms.toFixed(1)}ms`

async function main() {
  const targetDirs = parseDirCount()
  const root = mkdtempSync(join(tmpdir(), "bun-recursive-watch-"))

  let watcher: ReturnType<typeof watch> | undefined
  let ticker: ReturnType<typeof setInterval> | undefined

  try {
    // --- Build the synthetic tree -------------------------------------------
    const buildStart = performance.now()
    const actualDirs = buildTree(root, targetDirs)
    const buildMs = performance.now() - buildStart

    // --- Start a fine event-loop ticker -------------------------------------
    // The ticker fires every few ms and records the largest gap between fires.
    // While fs.watch() crawls synchronously the loop cannot service the timer,
    // so the max gap ends up ~= the blocking duration.
    const TICK_MS = 4
    let lastTick = performance.now()
    let maxGap = 0
    ticker = setInterval(() => {
      const now = performance.now()
      const gap = now - lastTick
      if (gap > maxGap) maxGap = gap
      lastTick = now
    }, TICK_MS)

    // Let the ticker settle so the baseline gap reflects an unblocked loop.
    await sleep(80)
    lastTick = performance.now()
    maxGap = 0

    const watchesBefore = isLinux ? countInotifyWatches() : 0

    // --- The measured call: this blocks until the whole crawl completes ------
    const watchStart = performance.now()
    watcher = watch(root, { recursive: true }, () => {})
    const blockMs = performance.now() - watchStart

    // Give the loop time to run so the ticker registers the gap it just missed.
    await sleep(250)

    const watchesAfter = isLinux ? countInotifyWatches() : 0
    const watchesAdded = watchesAfter - watchesBefore

    // --- Report --------------------------------------------------------------
    const line = "-".repeat(60)
    console.log(line)
    console.log("Bun recursive fs.watch() repro")
    console.log(line)
    console.log(`Bun version            : ${Bun.version}`)
    console.log(`Platform               : ${process.platform} (${process.arch})`)
    console.log(`Temp root              : ${root}`)
    console.log(`Directories created    : ${actualDirs.toLocaleString()}`)
    console.log(`Tree build time        : ${fmtMs(buildMs)}`)
    console.log(line)
    console.log(`fs.watch() call blocked: ${fmtMs(blockMs)}   <- (a) synchronous crawl`)
    console.log(`Max event-loop gap     : ${fmtMs(maxGap)}   <- (b) loop frozen during crawl`)

    if (isLinux) {
      console.log(line)
      console.log(`inotify watches added  : ${watchesAdded.toLocaleString()}`)
      console.log(`Directories in tree    : ${actualDirs.toLocaleString()}`)
      const diff = actualDirs - watchesAdded
      if (diff > 0) {
        console.log(
          `MISSING watches        : ${diff.toLocaleString()}   <- (c) child failures swallowed silently`,
        )
        console.log(
          "  The watcher registered fewer watches than there are directories, yet",
        )
        console.log(
          "  emitted no 'error' event. Part of the tree is silently unwatched.",
        )
      } else {
        console.log(
          "  One watch per directory (budget was sufficient). Re-run with a larger",
        )
        console.log(
          "  dirCount, or lower fs.inotify.max_user_watches, to force silent failures.",
        )
      }
    } else {
      console.log(line)
      console.log("inotify watch count    : skipped (non-Linux platform)")
    }
    console.log(line)
  } finally {
    if (ticker) clearInterval(ticker)
    if (watcher) watcher.close()
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
