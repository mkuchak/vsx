import { lstat, readdir } from "node:fs/promises"
import { watch as fsWatch } from "node:fs"
import { join, resolve, sep } from "node:path"
import { GitService } from "./git"

export type RepoInfo = {
  root: string
  gitDir: string
  commonDir: string
  service: GitService
}

const SKIP_DIRS = new Set(["node_modules"])
const WATCH_DEBOUNCE_MS = 150

async function spawnGit(cwd: string, args: string[]): Promise<string | null> {
  const spawn = () =>
    Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
  let proc: ReturnType<typeof spawn>
  try {
    proc = spawn()
  } catch {
    // Bun.spawn throws ENOENT (attributed to `git`) both when git is missing
    // AND when `cwd` vanished between discovery and spawn — e.g. a watcher
    // refresh racing a directory delete. Every discoverRepositories call site
    // is fire-and-forget (`void …`), so a throw here becomes an unhandled
    // rejection; "couldn't run git" must resolve like "git failed": null.
    return null
  }
  const [out, , code] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ])
  if (code !== 0) return null
  return out
}

async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    // A repo candidate has a `.git` entry that is either a directory (normal
    // repo) or a regular file (linked worktree / submodule pointer).
    const st = await lstat(join(dir, ".git"))
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

async function resolveRepo(candidateDir: string): Promise<RepoInfo | null> {
  // Let git canonicalize the toplevel; never parse a `gitdir:` pointer file.
  const topOut = await spawnGit(candidateDir, ["rev-parse", "--show-toplevel"])
  if (topOut === null) return null
  const root = topOut.trim()
  if (!root) return null

  const dirsOut = await spawnGit(root, [
    "rev-parse",
    "--git-dir",
    "--git-common-dir",
  ])
  if (dirsOut === null) return null
  const lines = dirsOut.split("\n").filter((l) => l.length > 0)
  if (lines.length < 2) return null

  // git may print these relative to the cwd (the repo root); make them absolute.
  const gitDir = resolve(root, lines[0].trim())
  const commonDir = resolve(root, lines[1].trim())

  return { root, gitDir, commonDir, service: new GitService(root) }
}

export async function discoverRepositories(
  workspaceRoot: string,
  opts?: { maxDepth?: number },
): Promise<RepoInfo[]> {
  const maxDepth = opts?.maxDepth ?? 2
  const repos: RepoInfo[] = []
  const seenRoots = new Set<string>()

  const queue: { dir: string; depth: number }[] = [
    { dir: resolve(workspaceRoot), depth: 0 },
  ]

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!

    if (await hasGitEntry(dir)) {
      const info = await resolveRepo(dir)
      if (info && !seenRoots.has(info.root)) {
        seenRoots.add(info.root)
        repos.push(info)
      }
    }

    if (depth >= maxDepth) continue

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === ".git") continue
      if (SKIP_DIRS.has(e.name)) continue
      const child = join(dir, e.name)
      try {
        // Skip symlinked directories to avoid infinite BFS loops.
        const st = await lstat(child)
        if (st.isSymbolicLink()) continue
      } catch {
        continue
      }
      queue.push({ dir: child, depth: depth + 1 })
    }
  }

  return repos
}

function isAncestorOrEqual(ancestor: string, target: string): boolean {
  if (target === ancestor) return true
  const withSep = ancestor.endsWith(sep) ? ancestor : ancestor + sep
  return target.startsWith(withSep)
}

export function activeRepoFor(
  filePath: string,
  repos: RepoInfo[],
): RepoInfo | null {
  const target = resolve(filePath)
  let best: RepoInfo | null = null
  for (const repo of repos) {
    if (!isAncestorOrEqual(repo.root, target)) continue
    // Deepest (longest) matching root wins for nested repos.
    if (best === null || repo.root.length > best.root.length) best = repo
  }
  return best
}

type StaleCb = (repoRoot: string) => void

// How often the visibility-gated poll re-emits staleness for every repo. The
// working tree is no longer fs.watch'd (a recursive watch under Bun/Linux walks
// the whole tree and exhausts the inotify budget), so an EXTERNAL edit — one made
// by another editor or a script — is invisible to the git-internal watches. This
// poll bounds how long such a change stays unseen WHILE the SCM view is open to
// ~10s. It only emits staleness (subscribers re-run `git status` themselves); it
// never spawns git of its own, and it does not run when no SCM view is showing.
const STATUS_POLL_MS = 10_000

export class GitWatcher {
  private subscribers = new Set<StaleCb>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private watchers: ReturnType<typeof fsWatch>[] = []
  private readonly repos: RepoInfo[]
  private readonly pollMs: number
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(
    repos: RepoInfo[],
    // `statusPollMs` is injectable so tests can drive the visibility-gated poll on
    // a few-ms interval without sleeping a real STATUS_POLL_MS; production always
    // uses the default.
    opts?: { statusPollMs?: number },
  ) {
    this.repos = repos
    this.pollMs = opts?.statusPollMs ?? STATUS_POLL_MS
    for (const repo of repos) this.setupRepo(repo)
  }

  private setupRepo(repo: RepoInfo): void {
    const mark = () => this.markStale(repo.root)

    // No working-tree watch: working-tree changes surface via vsx's own saves
    // (notifyPathTouched) and the visibility-gated status poll instead. Only the
    // cheap git-internal watches below remain — staging/commit/branch stay instant.

    // git-dir: HEAD (branch switch) and index (staging) live here — for a
    // worktree these are worktree-private. This watch is already scoped to just
    // gitDir's own top level (non-recursive), and everything that lives there
    // (HEAD, index, index.lock, COMMIT_EDITMSG, ...) is git-internal state, so
    // there's no name to filter on: any event here means "re-check status".
    // Deliberately not filtering by filename — git stages via a lockfile-then-
    // rename (index.lock -> index), and Node/Bun's fs.watch can
    // non-deterministically report only one side of that rename (sometimes
    // neither the source nor the destination name reliably), so a name-based
    // accept check would intermittently miss a real staging change.
    this.watchDir(repo.gitDir, false, () => true, mark)

    // common-dir HEAD: covers repos sharing the main checkout's HEAD.
    this.watchDir(repo.commonDir, false, (name) => name === "HEAD", mark)

    // common-dir refs/: watching the SHARED refs is what lets a worktree pick
    // up branch/ref changes made from other worktrees or the main checkout.
    // This is the ONE deliberately-recursive watch left in the codebase: refs/
    // is tiny (a handful of loose-ref files plus packed-refs), so recursively
    // watching it costs a trivial number of inotify watches — unlike a working
    // tree, it can never blow the budget, which is why the working-tree recursive
    // watch was removed while this one stays.
    this.watchDir(join(repo.commonDir, "refs"), true, () => true, mark)
  }

  private watchDir(
    dir: string,
    recursive: boolean,
    accept: (filename: string) => boolean,
    mark: () => void,
  ): void {
    let watcher: ReturnType<typeof fsWatch>
    try {
      watcher = fsWatch(dir, { recursive }, (_event, filename) => {
        if (filename == null) {
          mark()
          return
        }
        const name = filename.toString()
        const base = name.split(sep).pop() ?? name
        if (accept(recursive ? name : base)) mark()
      })
    } catch {
      return
    }
    watcher.on("error", () => {})
    this.watchers.push(watcher)
  }

  private markStale(repoRoot: string): void {
    if (this.disposed) return
    const existing = this.timers.get(repoRoot)
    if (existing) clearTimeout(existing)
    this.timers.set(
      repoRoot,
      setTimeout(() => {
        this.timers.delete(repoRoot)
        for (const cb of this.subscribers) cb(repoRoot)
      }, WATCH_DEBOUNCE_MS),
    )
  }

  onStatusStale(cb: StaleCb): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  /**
   * Save trigger: mark the repo containing `path` stale, on the same debounced
   * path the git-internal watches use. This is how vsx's OWN saves refresh
   * status/branch now that the working tree isn't watched — the deepest repo
   * containing the file wins (nested repos), and a path outside every repo no-ops.
   */
  notifyPathTouched(path: string): void {
    if (this.disposed) return
    const repo = activeRepoFor(path, this.repos)
    if (repo) this.markStale(repo.root)
  }

  /**
   * Start/stop the external-edit staleness poll. Driven by SCM-view visibility:
   * while a status consumer is on screen the poll marks every repo stale every
   * {@link STATUS_POLL_MS}; when hidden the timer is torn down so nothing runs in
   * the background. The StatusBar also consumes staleness (branch/status), but it
   * is refreshed by save triggers and the git-internal watches — polling for it
   * alone was ruled out, so the poll is gated purely on the SCM view.
   */
  setStatusPollActive(active: boolean): void {
    if (this.disposed) return
    if (active) {
      if (this.pollTimer) return
      this.pollTimer = setInterval(() => {
        for (const repo of this.repos) this.markStale(repo.root)
      }, this.pollMs)
    } else if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.subscribers.clear()
  }
}
