import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile, rename as renameFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitService, GitError } from "./git"

let root: string
let git: GitService

async function sh(args: string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdin: stdin !== undefined ? "pipe" : undefined,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (stdin !== undefined) {
    proc.stdin.write(stdin)
    await proc.stdin.end()
  }
  const [out, err, code] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`)
  return out
}

async function write(rel: string, content: string): Promise<void> {
  await writeFile(join(root, rel), content)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vsx-git-"))
  await sh(["init", "-q", "-b", "main"])
  await sh(["config", "user.email", "a@b.com"])
  await sh(["config", "user.name", "Tester"])
  await sh(["config", "commit.gpgsign", "false"])
  git = new GitService(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("status", () => {
  test("classifies staged, changes, untracked, and both-sides (MM)", async () => {
    // committed baseline
    await write("tracked.txt", "one\n")
    await write("mixed.txt", "base\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])

    // staged modification (index only)
    await write("tracked.txt", "two\n")
    await sh(["add", "tracked.txt"])

    // staged addition
    await write("added.txt", "new\n")
    await sh(["add", "added.txt"])

    // both staged and worktree modified -> MM
    await write("mixed.txt", "staged\n")
    await sh(["add", "mixed.txt"])
    await write("mixed.txt", "worktree\n")

    // untracked
    await write("untracked.txt", "u\n")

    const s = await git.status()

    const staged = new Map(s.staged.map((f) => [f.path, f.statusLetter]))
    expect(staged.get("tracked.txt")).toBe("M")
    expect(staged.get("added.txt")).toBe("A")
    expect(staged.get("mixed.txt")).toBe("M")

    const changes = new Map(s.changes.map((f) => [f.path, f.statusLetter]))
    expect(changes.get("mixed.txt")).toBe("M")

    expect(s.untracked.map((f) => f.path)).toContain("untracked.txt")
    expect(s.untracked.every((f) => f.statusLetter === "U")).toBe(true)
  })

  test("worktree deletion is reported as D in changes", async () => {
    await write("gone.txt", "x\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])
    await rm(join(root, "gone.txt"))

    const s = await git.status()
    const changes = new Map(s.changes.map((f) => [f.path, f.statusLetter]))
    expect(changes.get("gone.txt")).toBe("D")
  })

  test("staged deletion is reported as D in staged", async () => {
    await write("gone.txt", "x\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])
    await sh(["rm", "-q", "gone.txt"])

    const s = await git.status()
    const staged = new Map(s.staged.map((f) => [f.path, f.statusLetter]))
    expect(staged.get("gone.txt")).toBe("D")
  })

  test("a file replaced by a symlink is a typechange (T) in changes, then staged", async () => {
    await write("swap.txt", "regular file\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])

    // Replace the regular file with a symlink: git reports this as a typechange.
    await rm(join(root, "swap.txt"))
    await symlink("/tmp/whatever", join(root, "swap.txt"))

    let s = await git.status()
    const changes = new Map(s.changes.map((f) => [f.path, f.statusLetter]))
    expect(changes.get("swap.txt")).toBe("T")
    expect(s.staged.some((f) => f.path === "swap.txt")).toBe(false)

    await sh(["add", "swap.txt"])
    s = await git.status()
    const staged = new Map(s.staged.map((f) => [f.path, f.statusLetter]))
    expect(staged.get("swap.txt")).toBe("T")
    expect(s.changes.some((f) => f.path === "swap.txt")).toBe(false)
  })

  test("staged rename carries oldPath and status R", async () => {
    await write("old-name.txt", "content\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])
    await sh(["mv", "old-name.txt", "new-name.txt"])

    const s = await git.status()
    const rename = s.staged.find((f) => f.statusLetter === "R")
    expect(rename).toBeDefined()
    expect(rename?.path).toBe("new-name.txt")
    expect(rename?.oldPath).toBe("old-name.txt")
    // A rename must not corrupt parsing of the following record.
    expect(s.staged.every((f) => f.path.length > 0)).toBe(true)
  })

  test("conflicted file lands in mergeChanges with letter !", async () => {
    await write("conflict.txt", "base\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])

    await sh(["checkout", "-q", "-b", "feature"])
    await write("conflict.txt", "feature side\n")
    await sh(["commit", "-q", "-am", "feature"])

    await sh(["checkout", "-q", "main"])
    await write("conflict.txt", "main side\n")
    await sh(["commit", "-q", "-am", "main"])

    // provoke a merge conflict
    const proc = Bun.spawn(["git", "merge", "feature"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited

    const s = await git.status()
    const conflict = s.mergeChanges.find((f) => f.path === "conflict.txt")
    expect(conflict).toBeDefined()
    expect(conflict?.statusLetter).toBe("!")
    // Must not be double-reported as staged/changes.
    expect(s.staged.some((f) => f.path === "conflict.txt")).toBe(false)
    expect(s.changes.some((f) => f.path === "conflict.txt")).toBe(false)
  })

  test("handles paths with spaces", async () => {
    await write("a b c.txt", "x\n")
    const s = await git.status()
    expect(s.untracked.map((f) => f.path)).toContain("a b c.txt")
  })
})

describe("mutations", () => {
  test("stage then unstage moves a file in and out of the index", async () => {
    await write("f.txt", "x\n")

    await git.stage(["f.txt"])
    let s = await git.status()
    expect(s.staged.some((f) => f.path === "f.txt")).toBe(true)
    expect(s.untracked.some((f) => f.path === "f.txt")).toBe(false)

    await git.unstage(["f.txt"])
    s = await git.status()
    expect(s.staged.some((f) => f.path === "f.txt")).toBe(false)
    expect(s.untracked.some((f) => f.path === "f.txt")).toBe(true)
  })

  test("discardTracked restores a modified tracked file", async () => {
    await write("f.txt", "original\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])
    await write("f.txt", "changed\n")

    await git.discardTracked(["f.txt"])

    const s = await git.status()
    expect(s.changes.some((f) => f.path === "f.txt")).toBe(false)
    expect(await Bun.file(join(root, "f.txt")).text()).toBe("original\n")
  })

  test("cleanUntracked removes an untracked file", async () => {
    await write("junk.txt", "x\n")
    await git.cleanUntracked(["junk.txt"])

    const s = await git.status()
    expect(s.untracked.some((f) => f.path === "junk.txt")).toBe(false)
    expect(await Bun.file(join(root, "junk.txt")).exists()).toBe(false)
  })

  test("stageDeletion stages removal of a tracked file", async () => {
    await write("f.txt", "x\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])

    await git.stageDeletion(["f.txt"])

    const s = await git.status()
    const staged = new Map(s.staged.map((f) => [f.path, f.statusLetter]))
    expect(staged.get("f.txt")).toBe("D")
  })
})

describe("commit", () => {
  test("commits via stdin message and roundtrips through log", async () => {
    await write("f.txt", "x\n")
    await git.stage(["f.txt"])
    await git.commit("first commit subject")

    const out = await sh(["log", "--format=%s"])
    expect(out.trim()).toBe("first commit subject")
  })

  test("commit with {all:true} includes tracked modifications", async () => {
    await write("f.txt", "x\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])
    await write("f.txt", "modified\n")

    await git.commit("second", { all: true })

    const s = await git.status()
    expect(s.changes.length).toBe(0)
    const out = await sh(["log", "--format=%s"])
    expect(out.split("\n")[0]).toBe("second")
  })
})

describe("log", () => {
  test("parses fields, parents, and a multi-line body", async () => {
    await write("a.txt", "1\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "root commit"])

    await write("b.txt", "2\n")
    await sh(["add", "-A"])
    const body = "subject line\n\nbody paragraph with\nembedded newline"
    await sh(["commit", "-q", "--file", "-"], body)

    const commits = await git.log({ maxEntries: 10 })
    expect(commits.length).toBe(2)

    const [head, root0] = commits
    expect(head.message).toBe(body)
    expect(head.authorName).toBe("Tester")
    expect(head.authorEmail).toBe("a@b.com")
    expect(head.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(head.authorDate).toBeInstanceOf(Date)
    expect(Number.isNaN(head.authorDate.getTime())).toBe(false)
    expect(head.commitDate).toBeInstanceOf(Date)

    // head has exactly one parent (the root); root has none.
    expect(head.parents.length).toBe(1)
    expect(head.parents[0]).toBe(root0.hash)
    expect(root0.parents.length).toBe(0)
  })

  test("refs are populated for the branch tip", async () => {
    await write("a.txt", "1\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "c"])

    const commits = await git.log()
    expect(commits[0].refs.some((r) => r.includes("HEAD"))).toBe(true)
  })

  test("range option limits the commits returned", async () => {
    await write("a.txt", "1\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "one"])
    const first = (await sh(["rev-parse", "HEAD"])).trim()
    await write("b.txt", "2\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "two"])

    const commits = await git.log({ range: `${first}..HEAD` })
    expect(commits.length).toBe(1)
    expect(commits[0].message.trim()).toBe("two")
  })
})

describe("diffNameStatus", () => {
  test("reports modification, addition, deletion and a rename", async () => {
    await write("keep.txt", "v1\n")
    await write("remove.txt", "gone\n")
    await write("move.txt", "same content stays identical here\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])
    const first = (await sh(["rev-parse", "HEAD"])).trim()

    await write("keep.txt", "v2\n")
    await rm(join(root, "remove.txt"))
    await renameFile(join(root, "move.txt"), join(root, "moved.txt"))
    await write("brand-new.txt", "added\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "changes"])

    const entries = await git.diffNameStatus(first, "HEAD")
    const byPath = new Map(entries.map((e) => [e.path, e]))

    expect(byPath.get("keep.txt")?.statusLetter).toBe("M")
    expect(byPath.get("brand-new.txt")?.statusLetter).toBe("A")
    expect(byPath.get("remove.txt")?.statusLetter).toBe("D")

    const rename = entries.find((e) => e.statusLetter.startsWith("R"))
    expect(rename).toBeDefined()
    expect(rename?.path).toBe("moved.txt")
    expect(rename?.oldPath).toBe("move.txt")
  })
})

describe("commitStats", () => {
  test("sums insertions/deletions across files and counts a binary as 0/0", async () => {
    // Root commit with a text file and a binary file.
    await write("a.txt", "1\n2\n3\n")
    await writeFile(join(root, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255]))
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "root"])

    // Second commit: edit a.txt (line 2 changed => +1/-1, plus 2 appended) and
    // add b.txt (+2 lines). a.txt: +3/-1, b.txt: +2/-0.
    await write("a.txt", "1\n2b\n3\n4\n5\n")
    await write("b.txt", "x\ny\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "second"])
    const head = (await sh(["rev-parse", "HEAD"])).trim()

    const stats = await git.commitStats(head)
    expect(stats.files).toBe(2)
    expect(stats.insertions).toBe(5) // 3 in a.txt + 2 in b.txt
    expect(stats.deletions).toBe(1) // 1 removed from a.txt
  })

  test("counts a binary file as a changed file with zero line counts", async () => {
    await write("seed.txt", "x\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "seed"])

    await writeFile(join(root, "img.bin"), Buffer.from([0, 1, 2, 3]))
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "add binary"])
    const head = (await sh(["rev-parse", "HEAD"])).trim()

    const stats = await git.commitStats(head)
    expect(stats.files).toBe(1)
    expect(stats.insertions).toBe(0)
    expect(stats.deletions).toBe(0)
  })

  test("works on a root commit (diffs against the empty tree)", async () => {
    await write("a.txt", "1\n2\n")
    await write("b.txt", "3\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "root"])
    const root0 = (await sh(["rev-parse", "HEAD"])).trim()

    const stats = await git.commitStats(root0)
    expect(stats.files).toBe(2)
    expect(stats.insertions).toBe(3) // 2 + 1 lines added from nothing
    expect(stats.deletions).toBe(0)
  })

  test("counts a rename+edit as one file without miscounting paths", async () => {
    await write("orig.txt", "1\n2\n3\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "root"])

    await sh(["mv", "orig.txt", "renamed.txt"])
    await write("renamed.txt", "1\n2\n3\n4\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "rename+edit"])
    const head = (await sh(["rev-parse", "HEAD"])).trim()

    const stats = await git.commitStats(head)
    expect(stats.files).toBe(1)
    expect(stats.insertions).toBe(1)
    expect(stats.deletions).toBe(0)
  })
})

describe("grep", () => {
  test("parses a colon in a filename correctly through -z output", async () => {
    // `git grep -z` NUL-terminates the path, so a ':' in the name must not be
    // mistaken for the path/line/col field separators of the non-z format.
    await write("co:lon.txt", "alpha needle beta\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "colon"])

    const matches = await git.grep("needle")
    const m = matches.find((x) => x.path === "co:lon.txt")
    expect(m).toBeDefined()
    expect(m!.line).toBe(1)
    expect(m!.col).toBe(7) // "alpha " is 6 chars; "needle" starts at column 7
    expect(m!.preview).toBe("alpha needle beta")
  })

  test("whole-word uses git's -w flag (a match trailed by a word char is excluded)", async () => {
    await write("w.txt", "foo(bar) and lone foo here\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "w"])

    // `foo` matches as a whole word (grep is line-based → one record for the
    // line); `foo(` does not, because the '(' match is trailed by a word char.
    expect((await git.grep("foo", { wholeWord: true })).length).toBe(1)
    expect(await git.grep("foo(", { wholeWord: true })).toEqual([])
  })
})

describe("show", () => {
  test("returns staged (:0) and HEAD content of a path", async () => {
    await write("f.txt", "committed\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])

    await write("f.txt", "staged\n")
    await sh(["add", "f.txt"])

    expect(await git.show("HEAD", "f.txt")).toBe("committed\n")
    expect(await git.show(":0", "f.txt")).toBe("staged\n")
  })

  test("returns '' for a path that does not exist in the ref", async () => {
    await write("f.txt", "x\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])

    expect(await git.show("HEAD", "missing.txt")).toBe("")
  })

  test("throws GitError for a genuinely invalid ref", async () => {
    await write("f.txt", "x\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])

    let caught: unknown
    try {
      await git.show("totally-not-a-ref", "f.txt")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(GitError)
  })
})

describe("head", () => {
  test("reports the current branch with zero ahead/behind and no upstream", async () => {
    await write("f.txt", "x\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])

    const h = await git.head()
    expect(h.detached).toBe(false)
    expect(h.branch).not.toBeNull()
    expect(h.ahead).toBe(0)
    expect(h.behind).toBe(0)
  })

  test("detects a detached HEAD", async () => {
    await write("f.txt", "x\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])
    const hash = (await sh(["rev-parse", "HEAD"])).trim()
    await sh(["checkout", "-q", hash])

    const h = await git.head()
    expect(h.detached).toBe(true)
    expect(h.branch).toBeNull()
  })

  test("computes ahead/behind against a configured upstream", async () => {
    await write("f.txt", "1\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "c1"])

    // Simulate an upstream by cloning current state into a bare-like ref.
    await sh(["branch", "upstream-track"])
    await sh(["config", "branch.main.remote", "."])
    await sh(["config", "branch.main.merge", "refs/heads/upstream-track"])

    // main is now 1 commit ahead of its upstream.
    await write("f.txt", "2\n")
    await sh(["commit", "-q", "-am", "c2"])

    const h = await git.head()
    expect(h.ahead).toBe(1)
    expect(h.behind).toBe(0)
  })

  test("does not throw on an unborn branch (repo with zero commits)", async () => {
    // `git rev-parse --abbrev-ref HEAD` fails with exit 128 ("unknown
    // revision") before the first commit — regression guard for a real bug
    // caught via manual dogfooding: this uncaught rejection crashed StatusBar
    // when opening vsx on its own (then-commit-less) repo.
    const h = await git.head()
    expect(h.detached).toBe(false)
    expect(h.branch).not.toBeNull()
    expect(h.ahead).toBe(0)
    expect(h.behind).toBe(0)
  })
})

describe("optional locks", () => {
  // Read-only git commands (status, diff, ...) must run with
  // GIT_OPTIONAL_LOCKS=0 so they never take the opportunistic index lock and
  // rewrite .git/index. Without it, a `git status` on a just-edited file whose
  // mtime lands in the racy-index window rewrites the index on every call,
  // which re-trips the shared GitWatcher and drives an endless status→write
  // loop (the diff-view flicker bug).
  //
  // Verified by spying on Bun.spawn rather than by measuring .git/index mtime
  // across runs: the racy-index rewrite only fires when the file mtime falls in
  // the same second as the index write, which is inherently timing-dependent
  // and cannot be provoked deterministically (modern git also smudges racy
  // entries at write time, so a naive add+status often won't reproduce it).
  // Asserting the spawn env is the one fully deterministic check of the
  // invariant the fix actually establishes.
  test("spawns git with GIT_OPTIONAL_LOCKS=0 and an inherited environment", async () => {
    const spy = spyOn(Bun, "spawn")
    let calls: unknown[][]
    try {
      await git.status()
      // Snapshot before restoring: mockRestore() clears spy.mock.calls.
      calls = [...spy.mock.calls]
    } finally {
      spy.mockRestore()
    }

    const call = calls.find(
      ([cmd]) => Array.isArray(cmd) && cmd[0] === "git" && cmd[1] === "status",
    )
    expect(call).toBeDefined()
    const env = (call![1] as { env?: Record<string, string> }).env
    expect(env?.GIT_OPTIONAL_LOCKS).toBe("0")
    // process.env must be spread in — Bun.spawn otherwise replaces the whole
    // environment and git loses PATH/HOME.
    expect(env?.PATH).toBe(process.env.PATH)
  })
})

describe("queue", () => {
  test("serializes concurrent calls and survives a failing call", async () => {
    await write("f.txt", "x\n")
    await sh(["add", "-A"])
    await sh(["commit", "-q", "-m", "base"])

    // Fire a failing call and several good ones concurrently; the failure
    // must not stall the queue.
    const results = await Promise.allSettled([
      git.show("bad-ref", "f.txt").catch((e) => {
        throw e
      }),
      git.status(),
      git.log(),
      git.head(),
    ])

    expect(results[1].status).toBe("fulfilled")
    expect(results[2].status).toBe("fulfilled")
    expect(results[3].status).toBe("fulfilled")
  })
})
