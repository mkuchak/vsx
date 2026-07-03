import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { searchWorkspace, type SearchResult } from "./search"

let root: string

/** Just over the Bun engine's 1MB per-file byte budget. */
const OVER_BUDGET = 1024 * 1024 + 10

async function sh(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [, err, code] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`)
}

async function write(rel: string, content: string): Promise<void> {
  await writeFile(join(root, rel), content)
}

function fileFor(result: SearchResult, name: string) {
  return result.files.find((f) => basename(f.path) === name)
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// Shared fixture content used by both the git and the Bun engines so the
// assertions can be compared for parity.
async function writeCommonFiles(): Promise<void> {
  await write("a.txt", "hello world\nHELLO again\nfoo hello bar\n")
  await write("sp ace.txt", "no match here\nhello spaced file\n")
  await write("special.txt", "literal a.b( here\n")
  await write("words.txt", "hello\nhelloworld\n")
  // Punctuation-edged content for whole-word parity (git grep -w) checks.
  await write("punct.txt", "x -> y arrow\nif a == b then\ncall foo(bar) here\n")
  // A non-ASCII line: git's byte --column (16) must be normalized to the char
  // column (13) so it agrees with the char-based Bun engine and gotoLine.
  await write("cafe.txt", "café résumé TODO here\n")
  // Exactly three matches of a unique token for exact-cap truncation checks.
  await write("cap.txt", "zzcap\nzzcap\nzzcap\n")
}

describe("searchWorkspace — git engine", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vsx-search-git-"))
    await sh(["init", "-q"])
    await sh(["config", "user.email", "a@b.com"])
    await sh(["config", "user.name", "Tester"])
    await sh(["config", "commit.gpgsign", "false"])

    await writeCommonFiles()
    await write(".gitignore", "ign.txt\n")
    await write("ign.txt", "ignored hello\n")
    // A committed binary file (embedded NUL) must be skipped by `git grep -I`.
    await writeFile(join(root, "bin.dat"), Buffer.from([104, 105, 0, 104, 101, 108, 108, 111]))
    await sh(["add", "a.txt", "sp ace.txt", "special.txt", "words.txt", "punct.txt", "cap.txt", ".gitignore", "bin.dat"])
    await sh(["commit", "-qm", "init"])
    // An untracked-but-not-ignored file: VSCode (and our --untracked) matches it.
    await write("untr.txt", "untracked hello\n")
  })

  test("finds matches with correct line, col, and preview", async () => {
    const res = await searchWorkspace(root, "hello")
    const a = fileFor(res, "a.txt")
    expect(a).toBeDefined()
    expect(a!.path.startsWith("/")).toBe(true) // absolute
    expect(a!.matches.map((m) => m.line)).toEqual([1, 2, 3])
    expect(a!.matches[0]).toEqual({ line: 1, col: 1, length: 5, preview: "hello world" })
    expect(a!.matches[2]).toEqual({ line: 3, col: 5, length: 5, preview: "foo hello bar" })
  })

  test("matches an untracked file but not a gitignored one", async () => {
    const res = await searchWorkspace(root, "hello")
    expect(fileFor(res, "untr.txt")).toBeDefined()
    expect(fileFor(res, "ign.txt")).toBeUndefined()
  })

  test("skips binary files", async () => {
    const res = await searchWorkspace(root, "hello")
    expect(fileFor(res, "bin.dat")).toBeUndefined()
  })

  test("survives odd filenames (spaces) through -z parsing", async () => {
    const res = await searchWorkspace(root, "hello")
    const sp = fileFor(res, "sp ace.txt")
    expect(sp).toBeDefined()
    expect(sp!.matches[0]).toEqual({ line: 2, col: 1, length: 5, preview: "hello spaced file" })
  })

  test("case-sensitive toggle narrows to exact casing", async () => {
    const res = await searchWorkspace(root, "HELLO", { matchCase: true })
    const a = fileFor(res, "a.txt")
    expect(a).toBeDefined()
    expect(a!.matches).toEqual([{ line: 2, col: 1, length: 5, preview: "HELLO again" }])
    // Lowercase-only files drop out entirely.
    expect(fileFor(res, "words.txt")).toBeUndefined()
  })

  test("whole-word excludes substring hits", async () => {
    const res = await searchWorkspace(root, "hello", { wholeWord: true })
    const w = fileFor(res, "words.txt")
    expect(w).toBeDefined()
    expect(w!.matches).toEqual([{ line: 1, col: 1, length: 5, preview: "hello" }]) // not "helloworld"
  })

  test("regex mode honors pattern metacharacters", async () => {
    const res = await searchWorkspace(root, "h.l+o", { regex: true })
    expect(fileFor(res, "a.txt")).toBeDefined()
  })

  test("fixed-string mode treats regex specials literally", async () => {
    const res = await searchWorkspace(root, "a.b(", { regex: false })
    const s = fileFor(res, "special.txt")
    expect(s).toBeDefined()
    expect(s!.matches[0].preview).toBe("literal a.b( here")
    // The '.' is literal: a would-be wildcard hit must not appear elsewhere.
    expect(res.files.length).toBe(1)
  })

  test("no matches returns empty without throwing (git exit 1)", async () => {
    const res = await searchWorkspace(root, "zzz_no_such_token_zzz")
    expect(res.files).toEqual([])
    expect(res.truncated).toBe(false)
  })

  test("maxResults clips and flags truncation", async () => {
    const res = await searchWorkspace(root, "hello", { maxResults: 2 })
    const total = res.files.reduce((n, f) => n + f.matches.length, 0)
    expect(total).toBe(2)
    expect(res.truncated).toBe(true)
  })

  test("whole-word matches punctuation-edged queries (git grep -w parity)", async () => {
    const dot = await searchWorkspace(root, "a.b(", { wholeWord: true })
    expect(fileFor(dot, "special.txt")?.matches[0]).toEqual({
      line: 1, col: 9, length: 4, preview: "literal a.b( here",
    })
    const arrow = await searchWorkspace(root, "->", { wholeWord: true })
    expect(fileFor(arrow, "punct.txt")?.matches[0]).toEqual({
      line: 1, col: 3, length: 2, preview: "x -> y arrow",
    })
    const eq = await searchWorkspace(root, "==", { wholeWord: true })
    expect(fileFor(eq, "punct.txt")?.matches[0]).toEqual({
      line: 2, col: 6, length: 2, preview: "if a == b then",
    })
  })

  test("whole-word rejects a match trailed by a word char (foo( in foo(bar))", async () => {
    const res = await searchWorkspace(root, "foo(", { wholeWord: true })
    expect(res.files).toEqual([])
  })

  test("normalizes git's byte column to a char column on a non-ASCII line", async () => {
    const res = await searchWorkspace(root, "TODO")
    // git --column reports byte 16 here; "café résumé " is 12 chars → char col 13.
    expect(fileFor(res, "cafe.txt")?.matches[0]).toEqual({
      line: 1, col: 13, length: 4, preview: "café résumé TODO here",
    })
  })

  test("exact-cap is not truncation, but an extra match is", async () => {
    const exact = await searchWorkspace(root, "zzcap", { maxResults: 3 })
    expect(exact.files.reduce((n, f) => n + f.matches.length, 0)).toBe(3)
    expect(exact.truncated).toBe(false)

    const over = await searchWorkspace(root, "zzcap", { maxResults: 2 })
    expect(over.files.reduce((n, f) => n + f.matches.length, 0)).toBe(2)
    expect(over.truncated).toBe(true)
  })
})

describe("searchWorkspace — Bun scan engine (non-git root)", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vsx-search-bun-"))
    await writeCommonFiles()
    await mkdir(join(root, "node_modules", "dep"), { recursive: true })
    await write(join("node_modules", "dep", "index.js"), "module hello here\n")
    await writeFile(join(root, "bin.dat"), Buffer.from([104, 0, 104, 101, 108, 108, 111]))
    await write("big.txt", "x".repeat(OVER_BUDGET) + "\nhello at end\n")
  })

  test("finds matches with correct line, col, and preview", async () => {
    const res = await searchWorkspace(root, "hello")
    const a = fileFor(res, "a.txt")
    expect(a).toBeDefined()
    expect(a!.path.startsWith("/")).toBe(true)
    expect(a!.matches.map((m) => m.line)).toEqual([1, 2, 3])
    expect(a!.matches[2]).toEqual({ line: 3, col: 5, length: 5, preview: "foo hello bar" })
  })

  test("skips node_modules, binary files, and files over the byte budget", async () => {
    const res = await searchWorkspace(root, "hello")
    expect(fileFor(res, "index.js")).toBeUndefined() // node_modules pruned
    expect(fileFor(res, "bin.dat")).toBeUndefined() // binary sniffed out
    expect(fileFor(res, "big.txt")).toBeUndefined() // >1MB skipped
  })

  test("case, whole-word, regex, and fixed-string parity with the git engine", async () => {
    const cased = await searchWorkspace(root, "HELLO", { matchCase: true })
    expect(fileFor(cased, "a.txt")!.matches).toEqual([
      { line: 2, col: 1, length: 5, preview: "HELLO again" },
    ])

    const word = await searchWorkspace(root, "hello", { wholeWord: true })
    expect(fileFor(word, "words.txt")!.matches).toEqual([{ line: 1, col: 1, length: 5, preview: "hello" }])

    const rx = await searchWorkspace(root, "h.l+o", { regex: true })
    expect(fileFor(rx, "a.txt")).toBeDefined()

    const fixed = await searchWorkspace(root, "a.b(", { regex: false })
    expect(fileFor(fixed, "special.txt")!.matches[0].preview).toBe("literal a.b( here")
  })

  test("no matches returns empty without throwing", async () => {
    const res = await searchWorkspace(root, "zzz_no_such_token_zzz")
    expect(res.files).toEqual([])
    expect(res.truncated).toBe(false)
  })

  test("whole-word matches punctuation-edged queries (git grep -w parity)", async () => {
    const dot = await searchWorkspace(root, "a.b(", { wholeWord: true })
    expect(fileFor(dot, "special.txt")?.matches[0]).toEqual({
      line: 1, col: 9, length: 4, preview: "literal a.b( here",
    })
    const arrow = await searchWorkspace(root, "->", { wholeWord: true })
    expect(fileFor(arrow, "punct.txt")?.matches[0]).toEqual({
      line: 1, col: 3, length: 2, preview: "x -> y arrow",
    })
    const eq = await searchWorkspace(root, "==", { wholeWord: true })
    expect(fileFor(eq, "punct.txt")?.matches[0]).toEqual({
      line: 2, col: 6, length: 2, preview: "if a == b then",
    })
  })

  test("whole-word rejects a match trailed by a word char (foo( in foo(bar))", async () => {
    const res = await searchWorkspace(root, "foo(", { wholeWord: true })
    expect(fileFor(res, "punct.txt")).toBeUndefined()
  })

  test("reports the same char column as the git engine on a non-ASCII line", async () => {
    const res = await searchWorkspace(root, "TODO")
    // The Bun engine is natively char-based; parity with the git engine's
    // normalized col (13) is the whole point of the byte→char fix.
    expect(fileFor(res, "cafe.txt")?.matches[0]).toEqual({
      line: 1, col: 13, length: 4, preview: "café résumé TODO here",
    })
  })

  test("exact-cap is not truncation, but an extra match is", async () => {
    const exact = await searchWorkspace(root, "zzcap", { maxResults: 3 })
    expect(exact.files.reduce((n, f) => n + f.matches.length, 0)).toBe(3)
    expect(exact.truncated).toBe(false)

    const over = await searchWorkspace(root, "zzcap", { maxResults: 2 })
    expect(over.files.reduce((n, f) => n + f.matches.length, 0)).toBe(2)
    expect(over.truncated).toBe(true)
  })
})

describe("searchWorkspace — cancellation", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vsx-search-cancel-"))
    await write("a.txt", "hello\n")
    await write("b.txt", "hello\n")
    await write("c.txt", "hello\n")
  })

  test("a signal cancelled mid-run stops without rejecting", async () => {
    // A getter that flips true after the first check simulates cancellation
    // partway through the file loop.
    let checks = 0
    const signal = {
      get cancelled() {
        checks += 1
        return checks > 1
      },
    }
    const res = await searchWorkspace(root, "hello", { signal })
    // Resolved (no throw) and stopped early: fewer than all three files.
    expect(res.files.length).toBeLessThan(3)
  })

  test("an already-cancelled signal yields an empty result", async () => {
    const res = await searchWorkspace(root, "hello", { signal: { cancelled: true } })
    expect(res.files).toEqual([])
  })
})
