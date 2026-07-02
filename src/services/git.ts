export type StatusLetter = "M" | "T" | "A" | "D" | "R" | "C" | "U" | "!"

export type FileStatus = {
  path: string
  statusLetter: StatusLetter
  oldPath?: string
}

export type StatusResult = {
  mergeChanges: FileStatus[]
  staged: FileStatus[]
  changes: FileStatus[]
  untracked: FileStatus[]
}

export type CommitInfo = {
  hash: string
  authorName: string
  authorEmail: string
  authorDate: Date
  commitDate: Date
  parents: string[]
  refs: string[]
  message: string
}

export type DiffEntry = {
  path: string
  statusLetter: string
  oldPath?: string
}

export type HeadInfo = {
  branch: string | null
  detached: boolean
  ahead: number
  behind: number
}

export class GitError extends Error {
  constructor(
    public code: number,
    public stderr: string,
    public args: string[],
  ) {
    super(`git ${args.join(" ")} exited with ${code}: ${stderr.trim()}`)
    this.name = "GitError"
  }
}

const MAX_PATHS_PER_CALL = 2000

// Combinations where both index (X) and worktree (Y) sides signal an unmerged
// path. These must be routed to mergeChanges, never to staged/changes.
const CONFLICT_CODES = new Set([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
])

const STAGED_LETTERS = new Set(["M", "T", "A", "D", "R", "C"])

export class GitService {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private repoRoot: string) {}

  private async run(
    args: string[],
    opts?: { stdin?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.repoRoot,
      stdin: opts?.stdin !== undefined ? "pipe" : undefined,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (opts?.stdin !== undefined) {
      proc.stdin.write(opts.stdin)
      await proc.stdin.end()
    }
    const [stdout, stderr, code] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ])
    if (code !== 0) throw new GitError(code, stderr, args)
    return { stdout, stderr }
  }

  // Serialize every git invocation for this repo behind a single-flight FIFO
  // queue so only one git process runs at a time. A failing call must not stall
  // the chain, so the tail is always reset to a settled promise.
  private git(
    args: string[],
    opts?: { stdin?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    const result = this.queue.then(
      () => this.run(args, opts),
      () => this.run(args, opts),
    )
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private *chunkPaths(paths: string[]): Generator<string[]> {
    for (let i = 0; i < paths.length; i += MAX_PATHS_PER_CALL) {
      yield paths.slice(i, i + MAX_PATHS_PER_CALL)
    }
  }

  async status(): Promise<StatusResult> {
    const { stdout } = await this.git(["status", "-z", "-uall"])
    const fields = stdout.split("\0")

    const mergeChanges: FileStatus[] = []
    const staged: FileStatus[] = []
    const changes: FileStatus[] = []
    const untracked: FileStatus[] = []

    let i = 0
    while (i < fields.length) {
      const entry = fields[i]
      if (!entry) {
        i += 1
        continue
      }
      const x = entry[0]
      const y = entry[1]
      const path = entry.slice(3)

      // A rename/copy on either side consumes the following NUL field as the
      // original path (`XY <new>\0<old>` in `git status -z`).
      let oldPath: string | undefined
      if (x === "R" || x === "C" || y === "R" || y === "C") {
        oldPath = fields[i + 1]
        i += 2
      } else {
        i += 1
      }

      const code = x + y

      if (code === "??") {
        untracked.push({ path, statusLetter: "U" })
        continue
      }
      if (code === "!!") {
        // Ignored entry (only appears with --ignored); nothing to report.
        continue
      }
      if (CONFLICT_CODES.has(code)) {
        mergeChanges.push({ path, statusLetter: "!", oldPath })
        continue
      }

      if (STAGED_LETTERS.has(x)) {
        staged.push({ path, statusLetter: x as StatusLetter, oldPath })
      }
      if (y === "M") {
        changes.push({ path, statusLetter: "M" })
      } else if (y === "T") {
        changes.push({ path, statusLetter: "T" })
      } else if (y === "D") {
        changes.push({ path, statusLetter: "D" })
      }
    }

    return { mergeChanges, staged, changes, untracked }
  }

  async stage(paths: string[]): Promise<void> {
    for (const chunk of this.chunkPaths(paths)) {
      await this.git(["add", "-A", "--", ...chunk])
    }
  }

  async stageDeletion(paths: string[]): Promise<void> {
    for (const chunk of this.chunkPaths(paths)) {
      await this.git(["rm", "--", ...chunk])
    }
  }

  async unstage(paths: string[]): Promise<void> {
    for (const chunk of this.chunkPaths(paths)) {
      await this.git(["reset", "-q", "HEAD", "--", ...chunk])
    }
  }

  async discardTracked(paths: string[]): Promise<void> {
    for (const chunk of this.chunkPaths(paths)) {
      await this.git(["checkout", "-q", "--", ...chunk])
    }
  }

  async cleanUntracked(paths: string[]): Promise<void> {
    for (const chunk of this.chunkPaths(paths)) {
      await this.git(["clean", "-f", "-q", "--", ...chunk])
    }
  }

  async show(ref: string, path: string): Promise<string> {
    try {
      const { stdout } = await this.git(["show", "--textconv", `${ref}:${path}`])
      return stdout
    } catch (e) {
      if (e instanceof GitError && isPathMissing(e.stderr)) return ""
      throw e
    }
  }

  async commit(message: string, opts?: { all?: boolean }): Promise<void> {
    const args = ["commit", "--quiet", "--allow-empty-message", "--file", "-"]
    if (opts?.all) args.push("--all")
    await this.git(args, { stdin: message })
  }

  async log(opts?: {
    maxEntries?: number
    range?: string
  }): Promise<CommitInfo[]> {
    const args = [
      "log",
      "--format=%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B",
      "-z",
    ]
    if (opts?.range) args.push(opts.range)
    else args.push(`-n${opts?.maxEntries ?? 50}`)

    const { stdout } = await this.git(args)

    const commits: CommitInfo[] = []
    // The outer split MUST be on NUL: a commit body may contain embedded
    // newlines, so newlines cannot delimit records.
    for (const record of stdout.split("\0")) {
      if (!record) continue
      const lines = record.split("\n")
      const [hash, authorName, authorEmail, at, ct, parents, refs] = lines
      const message = lines.slice(7).join("\n").replace(/\n+$/, "")
      commits.push({
        hash,
        authorName,
        authorEmail,
        authorDate: new Date(Number(at) * 1000),
        commitDate: new Date(Number(ct) * 1000),
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        refs: refs
          ? refs.split(",").map((r) => r.trim()).filter(Boolean)
          : [],
        message,
      })
    }
    return commits
  }

  async diffNameStatus(a: string, b: string): Promise<DiffEntry[]> {
    const { stdout } = await this.git([
      "diff",
      "--name-status",
      "-z",
      "--diff-filter=ADMR",
      `${a}..${b}`,
    ])
    const fields = stdout.split("\0")

    const entries: DiffEntry[] = []
    let i = 0
    while (i < fields.length) {
      const status = fields[i]
      if (!status) {
        i += 1
        continue
      }
      const letter = status[0]
      // `git diff --name-status -z` emits renames/copies as
      // `<status>\0<oldpath>\0<newpath>` (source first, destination second).
      if (letter === "R" || letter === "C") {
        const oldPath = fields[i + 1]
        const path = fields[i + 2]
        entries.push({ path, statusLetter: status, oldPath })
        i += 3
      } else {
        const path = fields[i + 1]
        entries.push({ path, statusLetter: status })
        i += 2
      }
    }
    return entries
  }

  async head(): Promise<HeadInfo> {
    let name: string
    try {
      const { stdout } = await this.git(["rev-parse", "--abbrev-ref", "HEAD"])
      name = stdout.trim()
    } catch (e) {
      if (!(e instanceof GitError)) throw e
      // `rev-parse --abbrev-ref HEAD` fails on an unborn branch (no commits
      // yet) — HEAD is a valid symbolic ref, it just doesn't resolve to an
      // object. `symbolic-ref` reads the ref name directly without requiring
      // it to resolve, so it succeeds here where rev-parse doesn't.
      try {
        const { stdout } = await this.git(["symbolic-ref", "--short", "HEAD"])
        name = stdout.trim()
      } catch (e2) {
        if (!(e2 instanceof GitError)) throw e2
        // Detached with no commits reachable, or some other unresolvable
        // state: report as detached with no branch name rather than throwing.
        name = "HEAD"
      }
    }
    const detached = name === "HEAD"
    const branch = detached ? null : name

    let ahead = 0
    let behind = 0
    try {
      const { stdout } = await this.git([
        "rev-list",
        "--left-right",
        "--count",
        "@{upstream}...HEAD",
      ])
      const [behindStr, aheadStr] = stdout.trim().split(/\s+/)
      behind = Number(behindStr) || 0
      ahead = Number(aheadStr) || 0
    } catch (e) {
      if (!(e instanceof GitError)) throw e
      // No upstream configured (or no commits yet): report zeros.
    }

    return { branch, detached, ahead, behind }
  }
}

function isPathMissing(stderr: string): boolean {
  return (
    /does not exist/.test(stderr) ||
    /exists on disk, but not in/.test(stderr)
  )
}
