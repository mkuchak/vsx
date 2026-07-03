/**
 * Global, cross-project "most-accessed files" memory powering Quick Open. Files
 * you open often — in ANY project, including files outside the current
 * workspace — bubble to the top. Ranking is frecency (frequency + recency)
 * using zoxide's algorithm: an O(n), self-bounding score that ages older use
 * away without unbounded growth.
 *
 * The store is a ranking cache, never a source of truth: it soft-fails on every
 * OS surface. A corrupt file, a failed write, or a missing directory degrades to
 * an empty/stale ranking rather than throwing into the editor's render loop.
 *
 * Persistence lives under the XDG state dir (`$XDG_STATE_HOME/vsx` or
 * `~/.local/state/vsx`) — the terminal-tool convention shared by zoxide/atuin —
 * NOT `~/Library`, even on macOS. Writes are debounced and atomic (temp file +
 * rename). Concurrency is last-write-wins: two editor instances share one file
 * with no locking, so the last one to flush overwrites the other's ranking. For
 * a best-effort ranking cache this is an acceptable tradeoff versus lock files.
 */

import { readFileSync } from "node:fs"
import * as fsp from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** A single ranked file, keyed by ABSOLUTE path. */
export interface FileHistoryEntry {
  path: string
  score: number
  /** Epoch milliseconds of the most recent open. */
  lastAccess: number
}

export interface FileHistory {
  /**
   * Record an open of `path` (must be absolute). Bumps an existing entry's
   * score by 1 and its lastAccess, or creates a fresh entry at score 1, then
   * ages the whole store if the total score has grown past MAXAGE. Persists
   * (debounced).
   */
  record(path: string, now?: number): void
  /** Frecency of a single entry: score weighted by how recently it was opened. */
  frecency(entry: FileHistoryEntry, now?: number): number
  /** The `n` highest-frecency entries, most relevant first. */
  top(n: number, now?: number): FileHistoryEntry[]
  /** Remove an entry (e.g. user-initiated eviction from the picker). Persists. */
  evict(path: string): void
  /**
   * Drop entries whose path no longer exists AND was last opened over 90 days
   * ago. `exists` is injected so callers can also stat-filter at render time
   * separately. Persists if anything was removed.
   */
  pruneMissing(exists: (path: string) => Promise<boolean>, now?: number): Promise<void>
  /** Flush any pending debounced save immediately (for tests/shutdown). */
  flush(): Promise<void>
}

const FILE_NAME = "file-history.json"
const STORE_VERSION = 1
const SAVE_DEBOUNCE_MS = 500

// zoxide's aging bound: once the summed score crosses MAXAGE, every score is
// scaled back toward 0.9×MAXAGE and sub-1 entries are dropped. This keeps the
// store O(n) and stops any file from dominating forever.
const MAXAGE = 10_000

const HOUR = 3_600_000
const DAY = 86_400_000
const WEEK = 604_800_000
const NINETY_DAYS = 90 * DAY

/** `$XDG_STATE_HOME/vsx`, falling back to `~/.local/state/vsx`. */
function defaultBaseDir(): string {
  const xdg = process.env.XDG_STATE_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state")
  return join(base, "vsx")
}

/**
 * Load and validate the store from disk. Any failure — missing file, bad JSON,
 * wrong version, malformed entries — yields an empty store silently: a ranking
 * cache is never worth crashing (or blocking) the editor over.
 */
function load(filePath: string): Map<string, FileHistoryEntry> {
  const store = new Map<string, FileHistoryEntry>()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"))
  } catch {
    return store
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== STORE_VERSION ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    return store
  }
  for (const raw of (parsed as { entries: unknown[] }).entries) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as FileHistoryEntry).path === "string" &&
      typeof (raw as FileHistoryEntry).score === "number" &&
      typeof (raw as FileHistoryEntry).lastAccess === "number" &&
      Number.isFinite((raw as FileHistoryEntry).score) &&
      Number.isFinite((raw as FileHistoryEntry).lastAccess)
    ) {
      const e = raw as FileHistoryEntry
      store.set(e.path, { path: e.path, score: e.score, lastAccess: e.lastAccess })
    }
  }
  return store
}

export function createFileHistory(options: { baseDir?: string } = {}): FileHistory {
  const baseDir = options.baseDir ?? defaultBaseDir()
  const filePath = join(baseDir, FILE_NAME)
  const store = load(filePath)

  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // Serialize concurrent writes so a debounced flush and an explicit flush()
  // can't interleave temp-file renames; each save snapshots the store when it
  // runs, so the last one queued wins.
  let writeChain: Promise<void> = Promise.resolve()

  const save = (): Promise<void> => {
    dirty = false
    const data = JSON.stringify({ version: STORE_VERSION, entries: [...store.values()] })
    writeChain = writeChain.then(async () => {
      const tmp = join(baseDir, `${FILE_NAME}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
      try {
        await fsp.mkdir(baseDir, { recursive: true })
        await fsp.writeFile(tmp, data)
        await fsp.rename(tmp, filePath)
      } catch {
        // Best-effort: a cache write failure must never surface. Clean up the
        // temp file if the rename never happened.
        await fsp.rm(tmp, { force: true }).catch(() => {})
      }
    })
    return writeChain
  }

  const scheduleSave = () => {
    dirty = true
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void save()
    }, SAVE_DEBOUNCE_MS)
  }

  const frecency = (entry: FileHistoryEntry, now: number = Date.now()): number => {
    const age = now - entry.lastAccess
    if (age < HOUR) return entry.score * 4
    if (age < DAY) return entry.score * 2
    if (age < WEEK) return entry.score / 2
    return entry.score / 4
  }

  const age = () => {
    let total = 0
    for (const e of store.values()) total += e.score
    if (total <= MAXAGE) return
    const factor = (0.9 * MAXAGE) / total
    for (const e of store.values()) {
      e.score *= factor
      if (e.score < 1) store.delete(e.path)
    }
  }

  return {
    record(path, now = Date.now()) {
      const existing = store.get(path)
      if (existing) {
        existing.score += 1
        existing.lastAccess = now
      } else {
        store.set(path, { path, score: 1, lastAccess: now })
      }
      age()
      scheduleSave()
    },

    frecency,

    top(n, now = Date.now()) {
      return [...store.values()]
        .sort((a, b) => frecency(b, now) - frecency(a, now))
        .slice(0, n)
    },

    evict(path) {
      if (store.delete(path)) scheduleSave()
    },

    async pruneMissing(exists, now = Date.now()) {
      let removed = false
      for (const entry of [...store.values()]) {
        if (now - entry.lastAccess <= NINETY_DAYS) continue
        if (!(await exists(entry.path))) {
          store.delete(entry.path)
          removed = true
        }
      }
      if (removed) scheduleSave()
    },

    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (dirty) save()
      await writeChain
    },
  }
}
