# `fs.watch(dir, { recursive: true })` blocks the event loop during the initial crawl, and silently swallows per-child watch failures (Linux)

## Summary

On Linux, `fs.watch(dir, { recursive: true })` has two behaviors that together make it unusable on large directory trees, and neither is documented or surfaced:

1. **The initial tree crawl runs synchronously on the event-loop (JS) thread.** `fs.watch()` does not return until every subdirectory has been walked and registered with `inotify`, one `inotify_add_watch` syscall per directory. For a large tree this blocks the loop for hundreds of milliseconds to tens of seconds. This is a regression: the crawl was moved onto the JS thread by the `fs.watch` rewrite in #29952 (shipped in 1.3.14). Before that, the crawl ran on a background `WorkPool`.

2. **When registering a watch on a *child* directory fails mid-crawl, the failure is silently swallowed** — no throw, no `'error'` event. This includes `ENOSPC` once `fs.inotify.max_user_watches` is exhausted. The watcher reports success while covering only part of the tree, so file changes in the unwatched remainder are silently missed.

## Environment

- **Bun**: 1.3.14
- **OS**: Linux 6.8 (x86_64)
- `fs.inotify.max_user_watches` = `375552`

## Reproduction

A self-contained, dependency-free repro script is included below. It builds a synthetic tree in the OS temp dir, then measures (a) how long the `fs.watch()` call blocks, (b) the max event-loop gap observed by a fine interval ticker, and (c) the process's real inotify watch count (from `/proc/self/fdinfo/*`) vs. the number of directories.

```ts
#!/usr/bin/env bun
import { watch } from "node:fs"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const isLinux = process.platform === "linux"

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

function countInotifyWatches(): number {
  let count = 0
  for (const entry of readdirSync("/proc/self/fdinfo")) {
    try {
      const content = readFileSync(join("/proc/self/fdinfo", entry), "utf8")
      for (const line of content.split("\n")) if (line.startsWith("inotify")) count++
    } catch {}
  }
  return count
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const targetDirs = Number.parseInt(process.argv[2] ?? "30000", 10)
const root = mkdtempSync(join(tmpdir(), "bun-recursive-watch-"))
try {
  const actualDirs = buildTree(root, targetDirs)

  let lastTick = performance.now()
  let maxGap = 0
  const ticker = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - lastTick)
    lastTick = now
  }, 4)

  await sleep(80)
  lastTick = performance.now()
  maxGap = 0
  const before = isLinux ? countInotifyWatches() : 0

  const t0 = performance.now()
  const watcher = watch(root, { recursive: true }, () => {})
  const blockMs = performance.now() - t0

  await sleep(250)
  const added = (isLinux ? countInotifyWatches() : 0) - before

  console.log(`dirs=${actualDirs} blocked=${blockMs.toFixed(1)}ms maxGap=${maxGap.toFixed(1)}ms watches=${added}`)
  clearInterval(ticker)
  watcher.close()
} finally {
  rmSync(root, { recursive: true, force: true })
}
```

### Sample run

```
$ bun bun-recursive-watch-repro.ts 20000
------------------------------------------------------------
Bun recursive fs.watch() repro
------------------------------------------------------------
Bun version            : 1.3.14
Platform               : linux (x64)
Temp root              : /tmp/bun-recursive-watch-3twovL
Directories created    : 20,000
Tree build time        : 2228.7ms
------------------------------------------------------------
fs.watch() call blocked: 523.2ms   <- (a) synchronous crawl
Max event-loop gap     : 524.4ms   <- (b) loop frozen during crawl
------------------------------------------------------------
inotify watches added  : 20,001
Directories in tree    : 20,000
  One watch per directory (budget was sufficient). Re-run with a larger
  dirCount, or lower fs.inotify.max_user_watches, to force silent failures.
------------------------------------------------------------
```

The `fs.watch()` call blocks for essentially the entire crawl (523ms), and the max event-loop gap (524ms) confirms the loop is frozen for that whole window — no timer, I/O callback, or microtask runs. One inotify watch is registered per directory (plus the root).

## Measured data (from our investigation)

All numbers below are from the environment above, warm page cache:

| Tree size | `fs.watch()` blocking time | Notes |
| --- | --- | --- |
| 33,600 dirs | 728 ms | linear scaling |
| 100,900 dirs | 2,516 ms | ~25 µs/dir |
| ~400,000+ dirs (real home dir) | **40.7 s** single-call event-loop block | see below |

- **Behavior (1) is strictly linear** in directory count at roughly 25 µs/dir (warm cache) — the crawl is `O(dirs)` synchronous syscalls on the JS thread.
- **Behavior (2), demonstrated on a real 400k+-directory home directory:** with `max_user_watches = 375552` and ~249k watches already held elsewhere, a single recursive `fs.watch()` blocked the event loop for **40.7 s**, registered exactly the remaining budget (**126,466** watches), then **stopped silently — zero errors, zero events**. The tail of the tree was left completely unwatched with no indication to the application.
- **Watch-per-directory confirmed:** an app instance watching a 1,512-directory tree held exactly **1,512** inotify watches.

## Mechanism (with source references)

Call path for the synchronous crawl (Zig, 1.3.14):

- `fs.watch()` → `FSWatcher.init` — `src/bun.js/node/node_fs_watcher.zig:637`, runs on the **JS thread**.
- → `PathWatcher.watch` → `Platform.addWatch`, taken **under `manager.mutex`** — `src/watcher/path_watcher.zig:309-321`.
- → `Linux.addWatch` — `src/watcher/path_watcher.zig:469` → `walkAndAdd` → `walkSubtree` — `:363`.
- → `addOne` — `:481`, which issues **one `inotify_add_watch` per directory**.

The whole subtree walk therefore happens inline in the `fs.watch()` call, on the JS thread, while holding the process-global `manager.mutex`.

Silent child-failure swallow (behavior 2):

- `src/watcher/path_watcher.zig:491-493` — when `inotify_add_watch` fails for a subpath, the code does `if (subpath.len > 0) return .success;`. A failure on any **child** directory (including `ENOSPC` at watch-budget exhaustion) is reported as success and never propagated.

Both behaviors are **preserved 1:1 in the newer Rust port**: `src/watcher/path_watcher.rs:409` / `:507` / `:731`, and the child-error swallow at `:760-766`.

Note the regression origin: pre-1.3.14, the crawl ran on a background `WorkPool`, so it did not block the loop. PR #29952 (the `fs.watch` rewrite that also fixed #15939) moved it onto the JS thread.

## Comparison with Node.js

Node's Linux recursive watcher (`lib/internal/fs/recursive_watch.js`, since v20) uses the **same watch-per-directory model** — it also registers one `inotify` watch per subdirectory. The key difference is that Node crawls the tree with **async `fs`** APIs, so the event loop is **not blocked** during registration.

Node does `throw` `ENOSPC` when the **root** watch cannot be established, which at least surfaces the exhaustion case that Bun swallows. However, Node has the **same silent-child-failure exposure**: a mid-crawl failure on a nested directory is not reliably surfaced either.

## Asks

1. **Move the initial crawl off the JS thread.** Either restore the pre-1.3.14 `WorkPool` behavior, or perform the subtree walk with async iteration, so `fs.watch()` returns promptly and the event loop stays responsive on large trees.
2. **Surface child-registration failures at least once.** Instead of silently returning `.success` on a failed child `inotify_add_watch` (`path_watcher.zig:491-493` / `path_watcher.rs:760-766`), emit an `'error'` event or a one-time warning so applications can detect partial coverage — especially `ENOSPC` at `max_user_watches` exhaustion.

## Related issues

We reviewed the following; none covers either of these two behaviors (synchronous JS-thread crawl / silent child-failure swallow):

- #6955, #4854, #29677, #33396, #28038, #15939 (fixed by #29952), #23306, #24875
