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

export type CommitStats = {
  files: number
  insertions: number
  deletions: number
}

export type GrepMatch = {
  /** Path relative to the repo root, as `git grep` emits it. */
  path: string
  line: number
  /** 1-based BYTE column of the first match (git `--column`); callers that need a
   * char column must normalize against the preview (see search.ts). */
  col: number
  preview: string
}

export type GrepOptions = {
  matchCase?: boolean
  wholeWord?: boolean
  regex?: boolean
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
      // GIT_OPTIONAL_LOCKS=0 forbids read-only commands (status, diff) from
      // taking the opportunistic index lock and rewriting .git/index. Without
      // it, `git status` on a just-edited file whose mtime lands in the same
      // second as the last index write hits git's racy-index path and REWRITES
      // the index every invocation. That write trips the shared GitWatcher
      // (repos.ts), which re-runs status, which rewrites again — a self-
      // sustaining ~150ms loop that makes the diff view flicker forever.
      // Mandatory writers (add/commit/reset) ignore this flag and still lock.
      // Bun.spawn replaces the environment wholesale when `env` is set, so
      // process.env must be spread in (git needs PATH, HOME for config, etc.).
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
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

  async commitStats(hash: string): Promise<CommitStats> {
    // `git show --numstat` diffs a commit against its first parent — and against
    // the empty tree for a root commit — so no explicit parent handling is
    // needed. `-z` emits one NUL-terminated `added\tdeleted\tpath` record per
    // file; a rename instead emits `added\tdeleted\t` then oldpath and newpath
    // as two further NUL fields. Binary files show "-" for both counts.
    const { stdout } = await this.git(["show", "-z", "--numstat", "--format=", hash])
    const fields = stdout.split("\0")

    let files = 0
    let insertions = 0
    let deletions = 0
    let i = 0
    while (i < fields.length) {
      const field = fields[i]
      if (!field) {
        i += 1
        continue
      }
      const tab1 = field.indexOf("\t")
      const tab2 = field.indexOf("\t", tab1 + 1)
      if (tab1 === -1 || tab2 === -1) {
        i += 1
        continue
      }
      const added = field.slice(0, tab1)
      const deleted = field.slice(tab1 + 1, tab2)
      const path = field.slice(tab2 + 1)
      insertions += added === "-" ? 0 : Number(added) || 0
      deletions += deleted === "-" ? 0 : Number(deleted) || 0
      files += 1
      // An empty path means a rename/copy: skip its oldpath+newpath NUL fields.
      i += path === "" ? 3 : 1
    }

    return { files, insertions, deletions }
  }

  async grep(query: string, opts: GrepOptions = {}): Promise<GrepMatch[]> {
    // `-I` skips binaries, `-z` NUL-delimits the path (unquoted), `--column`
    // gives the 1-based column of the first match, `--untracked` matches
    // VSCode by also searching untracked-not-ignored files.
    const args = ["grep", "-n", "-I", "--column", "-z", "--untracked"]
    if (!opts.matchCase) args.push("-i")
    // git's regex engine has no \b; -w is its dedicated whole-word matcher and
    // works with both fixed (-F) and extended-regex (-E) patterns.
    if (opts.wholeWord) args.push("-w")
    args.push(opts.regex ? "-E" : "-F", "-e", query)
    args.push("--", ".")

    try {
      const { stdout } = await this.git(args)
      return parseGrepZ(stdout)
    } catch (e) {
      // `git grep` exits 1 with no output when nothing matched — not an error.
      if (e instanceof GitError && e.code === 1 && e.stderr.trim() === "") return []
      throw e
    }
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

// `git grep -n --column -z` emits one record per matching line as
// `path\0line\0col\0text\n`. The path is unquoted (raw bytes) thanks to -z, and
// the matched line text (never binary, since -I) runs to the trailing newline.
function parseGrepZ(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = []
  let i = 0
  while (i < stdout.length) {
    const p1 = stdout.indexOf("\0", i)
    if (p1 < 0) break
    const p2 = stdout.indexOf("\0", p1 + 1)
    if (p2 < 0) break
    const p3 = stdout.indexOf("\0", p2 + 1)
    if (p3 < 0) break
    let nl = stdout.indexOf("\n", p3 + 1)
    if (nl < 0) nl = stdout.length

    const path = stdout.slice(i, p1)
    const line = Number(stdout.slice(p1 + 1, p2))
    const col = Number(stdout.slice(p2 + 1, p3))
    const preview = stdout.slice(p3 + 1, nl).replace(/\r$/, "")
    if (path && Number.isFinite(line) && Number.isFinite(col)) {
      matches.push({ path, line, col, preview })
    }
    i = nl + 1
  }
  return matches
}

function isPathMissing(stderr: string): boolean {
  return (
    /does not exist/.test(stderr) ||
    /exists on disk, but not in/.test(stderr) ||
    // `git show :0:<path>` on an unmerged (conflicted) path has no stage-0
    // entry and fails with "...is in the index, but not at stage 0" — treat
    // that as missing so the merge-conflict diff falls back to HEAD.
    /is in the index, but not at stage/.test(stderr)
  )
}
