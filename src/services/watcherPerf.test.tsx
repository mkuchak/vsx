import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { workbenchStore } from "../model/workbench"
import { destroyRendererAndWait } from "../testUtils/rendererTeardown"
import { App } from "../workbench/App"
import { startDocumentReloadWatcher } from "../workbench/watchers"
import { discoverRepositories, GitWatcher } from "./repos"
import { createDirWatcher, listDir } from "./workspace"

// Regression guard for the boot-time freeze (originally 40.7s on a 400k-dir
// $HOME): Bun's `fs.watch(root, { recursive: true })` synchronously walks the
// whole tree on the event-loop thread AND registers one inotify watch per dir.
// Every boot-time watch surface has since been migrated off it; this pins that
// booting against a huge tree neither stalls the loop nor registers O(tree)
// watches, so the recursive watch can never be reintroduced without going red.

const isLinux = process.platform === "linux"

// Count this process's live inotify watches by scanning /proc/self/fdinfo/*: each
// watched directory is one `inotify wd:…` line under its inotify instance's fd.
// (If a Bun/kernel build backs fs.watch without inotify this reads ~0 — the loop-
// gap assertion below is the primary guard; this one adds the O(tree) tripwire.)
function inotifyWatchCount(): number {
  let fds: string[]
  try {
    fds = readdirSync("/proc/self/fdinfo")
  } catch {
    return 0
  }
  let count = 0
  for (const fd of fds) {
    let content: string
    try {
      content = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")
    } catch {
      continue
    }
    for (const line of content.split("\n")) {
      if (line.startsWith("inotify")) count++
    }
  }
  return count
}

// Sample the event loop every 25ms while `action` runs and return the largest gap
// observed. A synchronous stall (the old recursive-walk bug) surfaces as a multi-
// hundred-ms spike; async work that yields per readdir keeps gaps near the cadence.
async function maxLoopGapDuring(action: () => Promise<void>): Promise<number> {
  let last = performance.now()
  let maxGap = 0
  const ticker = setInterval(() => {
    const now = performance.now()
    const gap = now - last
    if (gap > maxGap) maxGap = gap
    last = now
  }, 25)
  try {
    await action()
  } finally {
    clearInterval(ticker)
  }
  return maxGap
}

// ~20k directories, but only a handful sit within repo-discovery's depth cap so
// booting stays cheap — while a RECURSIVE watch on the root would still have to
// walk (and inotify-register) every one. Shape: 8×8 intermediate dirs, each with
// LEAF leaf dirs at depth 3 (below discovery's maxDepth 2, so never scanned).
const B1 = 8
const B2 = 8
const LEAF = 313 // 8*8*313 = 20032 leaves (+72 intermediate) ≈ 20k dirs
const EXPECTED_DIRS = B1 * B2 * LEAF + B1 * B2 + B1

// The migrated boot wiring adds only O(open tabs + git internals) watches; give
// generous headroom over that handful while staying far below the 20k a recursive
// root watch would register.
const MAX_BOOT_WATCHES = 100
// ~10x the warm per-20k-dir cost of the OLD bug, so the deleted code blows past it
// while the migrated wiring (tens of ms) sits comfortably under even on slow CI.
const MAX_LOOP_GAP_MS = 250
// Mounting the real <App> adds a fixed OpenTUI initial-render stall (~150-200ms,
// independent of tree size) on top of the watcher setup, so the assembled-boot
// path gets a looser ceiling. The recursive-watch bug would still pile another
// ~500ms+ tree walk on top of that, so this stays a live regression tripwire.
const MAX_APP_LOOP_GAP_MS = 600

let treeRoot: string

function buildTree(): void {
  for (let i = 0; i < B1; i++) {
    for (let j = 0; j < B2; j++) {
      const branch = join(treeRoot, `b${i}`, `s${j}`)
      mkdirSync(branch, { recursive: true })
      for (let k = 0; k < LEAF; k++) mkdirSync(join(branch, `l${k}`))
    }
  }
}

function git(args: string[]): void {
  Bun.spawnSync(["git", ...args], { cwd: treeRoot })
}

beforeAll(() => {
  treeRoot = mkdtempSync(join(tmpdir(), "vsx-watchperf-"))
  buildTree()
  // A real repo so the GitWatcher boot surface is exercised too. Empty dirs are
  // invisible to git, so one committed file gives the repo a HEAD without making
  // status/ls-files walk the 20k tree.
  git(["init", "-q", "-b", "main"])
  git(["config", "user.email", "a@b.com"])
  git(["config", "user.name", "Test"])
  writeFileSync(join(treeRoot, "README.md"), "vsx watch perf fixture\n")
  git(["add", "README.md"])
  git(["commit", "-q", "-m", "init"])
})

afterAll(() => {
  rmSync(treeRoot, { recursive: true, force: true })
})

afterEach(() => {
  workbenchStore.reset()
})

test("boot watch wiring stays off the event loop and inotify-bounded on a ~20k-dir tree", async () => {
  // Sanity: the fixture really is huge, so the bound below is meaningful.
  expect(EXPECTED_DIRS).toBeGreaterThan(19_000)

  const baseline = inotifyWatchCount()

  let stopDocWatch: (() => void) | undefined
  let dirWatcher: ReturnType<typeof createDirWatcher> | undefined
  let gitWatcher: GitWatcher | undefined

  try {
    const maxGap = await maxLoopGapDuring(async () => {
      // 1. Real document-reload wiring (watchers.tsx): watches parent dirs of
      //    open docs — none at boot, so it must not touch the tree at all.
      stopDocWatch = startDocumentReloadWatcher()

      // 2. FileTree-equivalent: the tree lists its root and watches exactly that
      //    one listed dir (non-recursive), never the subtree.
      dirWatcher = createDirWatcher(() => {})
      await listDir(treeRoot)
      dirWatcher.add(treeRoot)

      // 3. GitWatcher boot: discovery is depth-capped so it never scans the 20k
      //    leaves; only the cheap git-internal watches get registered.
      const repos = await discoverRepositories(treeRoot, { maxDepth: 0 })
      gitWatcher = new GitWatcher(repos)

      // Let any async settle land while the ticker keeps sampling.
      await Bun.sleep(200)
    })

    const afterCount = inotifyWatchCount()

    expect(maxGap).toBeLessThan(MAX_LOOP_GAP_MS)
    if (isLinux) {
      expect(afterCount - baseline).toBeLessThan(MAX_BOOT_WATCHES)
    }
  } finally {
    stopDocWatch?.()
    dirWatcher?.dispose()
    gitWatcher?.dispose()
  }
}, 20_000)

test("mounting the full workbench on a ~20k-dir tree does not block the event loop", async () => {
  const baseline = inotifyWatchCount()
  let setup: Awaited<ReturnType<typeof testRender>> | undefined

  try {
    const maxGap = await maxLoopGapDuring(async () => {
      setup = await testRender(<App workspaceRoot={treeRoot} />, {
        width: 100,
        height: 30,
      })
      // Let boot effects (repo discovery, FileTree listing, watcher mounts) run.
      await Bun.sleep(500)
      await setup.renderOnce()
    })

    const afterCount = inotifyWatchCount()

    expect(maxGap).toBeLessThan(MAX_APP_LOOP_GAP_MS)
    if (isLinux) {
      expect(afterCount - baseline).toBeLessThan(MAX_BOOT_WATCHES)
    }
  } finally {
    if (setup) await destroyRendererAndWait(setup.renderer)
  }
}, 20_000)
