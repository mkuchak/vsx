import { readdir, stat } from "node:fs/promises"
import { watch as fsWatch } from "node:fs"
import { join, relative } from "node:path"

export type DirEntry = {
  name: string
  path: string
  isDir: boolean
}

export type EnumerateResult = {
  files: string[]
  truncated: boolean
}

export type FileChangeType = "created" | "changed" | "deleted"

export type FileChange = {
  type: FileChangeType
  path: string
}

const MAX_FILES = 50_000
// Wall-clock budget for the non-git fallback walk. vsx can be rooted at a huge
// tree (e.g. `vsx ~/.bashrc` roots at $HOME — 400k+ dirs); without a budget the
// DFS keeps descending until it hits MAX_FILES, walking hundreds of thousands of
// directories (sluggish for tens of seconds, hammering IO). The walk is async
// and non-blocking (it awaits readdir per directory, yielding to the event loop),
// so this budget is NOT about protecting the event loop — it caps time/IO spent
// enumerating an unbounded root so Quick Open and search degrade to a partial
// listing instead of grinding.
export const ENUMERATE_WALK_BUDGET_MS = 2000
const WATCH_DEBOUNCE_MS = 100
const ALWAYS_SKIP = new Set(["node_modules", ".git", "dist", "coverage"])

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  html: "html",
  css: "css",
  md: "markdown",
  sh: "bash",
}

export function detectLanguage(path: string): string | undefined {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return undefined
  const ext = path.slice(dot + 1).toLowerCase()
  return LANGUAGE_BY_EXT[ext]
}

export async function listDir(path: string): Promise<DirEntry[]> {
  const dirents = await readdir(path, { withFileTypes: true })
  const entries: DirEntry[] = dirents.map((d) => ({
    name: d.name,
    path: join(path, d.name),
    isDir: d.isDirectory(),
  }))
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "accent" })
  })
  return entries
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const st = await stat(join(root, ".git"))
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

async function enumerateWithGit(root: string): Promise<EnumerateResult> {
  const proc = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  )
  const [out, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ls-files exited with ${exitCode}`)

  const all = out.split("\0").filter((p) => p.length > 0)
  const truncated = all.length > MAX_FILES
  const files = truncated ? all.slice(0, MAX_FILES) : all
  return { files, truncated }
}

async function enumerateWithWalk(
  root: string,
  budgetMs: number,
): Promise<EnumerateResult> {
  const files: string[] = []
  let truncated = false
  const deadline = Date.now() + budgetMs

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    // Either limit alone truncates: the wall-clock deadline (see
    // ENUMERATE_WALK_BUDGET_MS — bounds an unbounded root) OR the file cap.
    // Checked per directory, so an enormous tree stops descending promptly.
    if (Date.now() >= deadline) {
      truncated = true
      return
    }
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (truncated) return
      if (d.isDirectory()) {
        if (ALWAYS_SKIP.has(d.name)) continue
        await walk(join(dir, d.name))
      } else if (d.isFile()) {
        if (files.length >= MAX_FILES) {
          truncated = true
          return
        }
        files.push(relative(root, join(dir, d.name)))
      }
    }
  }

  await walk(root)
  return { files, truncated }
}

export async function enumerateFiles(
  root: string,
  // Injectable so tests can force truncation with a tiny (0ms) budget without
  // building a 400k-dir fixture.
  opts: { walkBudgetMs?: number } = {},
): Promise<EnumerateResult> {
  if (await isGitRepo(root)) {
    try {
      return await enumerateWithGit(root)
    } catch {
      // fall through to manual walk
    }
  }
  return enumerateWithWalk(root, opts.walkBudgetMs ?? ENUMERATE_WALK_BUDGET_MS)
}

// Shared debounce + create/changed/deleted classification for all watchers.
// `record` takes an absolute path: fs.watch (non-recursive) emits basenames, so
// each caller joins the event name against its watched dir before feeding it here.
function createChangeCollector(cb: (changes: FileChange[]) => void) {
  const pending = new Map<string, FileChangeType>()
  // Paths the collector has observed to exist. macOS coalesces content edits
  // into `rename` events, so the raw event type can't distinguish created
  // from changed; membership in this set does.
  const known = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    timer = undefined
    if (pending.size === 0) return
    const batch: FileChange[] = Array.from(pending, ([path, type]) => ({
      type,
      path,
    }))
    pending.clear()
    cb(batch)
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(flush, WATCH_DEBOUNCE_MS)
  }

  const record = async (abs: string) => {
    let exists = false
    try {
      const st = await stat(abs)
      exists = st.isFile() || st.isDirectory()
    } catch {
      exists = false
    }

    const prev = pending.get(abs)
    if (!exists) {
      known.delete(abs)
      // A file created then deleted within the same window is a no-op.
      if (prev === "created") pending.delete(abs)
      else pending.set(abs, "deleted")
    } else if (!known.has(abs)) {
      known.add(abs)
      if (prev === undefined) pending.set(abs, "created")
    } else if (prev === undefined) {
      pending.set(abs, "changed")
    }
    schedule()
  }

  const dispose = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    pending.clear()
  }

  return { record, dispose }
}

export type DirWatcher = {
  add(dir: string): void
  remove(dir: string): void
  dispose(): void
}

// Non-recursive per-directory watch manager. Each `add` registers exactly one
// `fs.watch(dir)` WITHOUT `recursive: true`, which is load-bearing: under Bun on
// Linux `fs.watch(root, { recursive: true })` synchronously walks the entire
// subtree on the event-loop thread (tens of seconds on a home dir) and registers
// one inotify watch per directory, silently no-op'ing once max_user_watches is
// exhausted. Watching only the dirs the app cares about avoids all of that.
export function createDirWatcher(
  cb: (changes: FileChange[]) => void,
): DirWatcher {
  const collector = createChangeCollector(cb)
  const watchers = new Map<string, ReturnType<typeof fsWatch>>()

  const remove = (dir: string) => {
    const watcher = watchers.get(dir)
    if (!watcher) return
    watchers.delete(dir)
    watcher.close()
  }

  const add = (dir: string) => {
    if (watchers.has(dir)) return
    let watcher: ReturnType<typeof fsWatch>
    try {
      watcher = fsWatch(dir, (_event, filename) => {
        if (filename == null) return
        const name = filename.toString()
        if (ALWAYS_SKIP.has(name)) return
        void collector.record(join(dir, name))
      })
    } catch {
      // Best-effort: an unwatchable dir (ENOENT/EACCES throws synchronously)
      // is skipped rather than surfaced. See repos.ts's watcher philosophy.
      return
    }
    // A vanished watched dir surfaces as an 'error' event, which is fatal if
    // unhandled. Auto-remove silently so it can never crash the process.
    watcher.on("error", () => remove(dir))
    watchers.set(dir, watcher)
  }

  const dispose = () => {
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
    collector.dispose()
  }

  return { add, remove, dispose }
}
