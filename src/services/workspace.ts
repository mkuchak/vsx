import { readdir, stat } from "node:fs/promises"
import { watch as fsWatch } from "node:fs"
import { join, relative, sep } from "node:path"

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

export type WatchDisposer = () => void

const MAX_FILES = 50_000
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

async function enumerateWithWalk(root: string): Promise<EnumerateResult> {
  const files: string[] = []
  let truncated = false

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
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

export async function enumerateFiles(root: string): Promise<EnumerateResult> {
  if (await isGitRepo(root)) {
    try {
      return await enumerateWithGit(root)
    } catch {
      // fall through to manual walk
    }
  }
  return enumerateWithWalk(root)
}

export function watch(
  root: string,
  cb: (changes: FileChange[]) => void,
): WatchDisposer {
  const pending = new Map<string, FileChangeType>()
  // Paths the watcher has observed to exist. macOS coalesces content edits
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

  const record = async (filename: string) => {
    const abs = join(root, filename)
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

  const watcher = fsWatch(
    root,
    { recursive: true },
    (_event, filename) => {
      if (filename == null) return
      const name = filename.toString()
      const top = name.split(sep)[0]
      if (top && ALWAYS_SKIP.has(top)) return
      void record(name)
    },
  )

  return () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    pending.clear()
    watcher.close()
  }
}
