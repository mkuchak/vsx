import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDirWatcher,
  detectLanguage,
  enumerateFiles,
  listDir,
  type FileChange,
} from "./workspace"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vsx-ws-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function initGitRepo(dir: string): Promise<void> {
  const proc = Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const code = await proc.exited
  expect(code).toBe(0)
}

describe("detectLanguage", () => {
  test("maps known extensions", () => {
    expect(detectLanguage("a/b/foo.ts")).toBe("typescript")
    expect(detectLanguage("foo.tsx")).toBe("typescript")
    expect(detectLanguage("foo.js")).toBe("javascript")
    expect(detectLanguage("foo.jsx")).toBe("javascript")
    expect(detectLanguage("foo.py")).toBe("python")
    expect(detectLanguage("foo.rs")).toBe("rust")
    expect(detectLanguage("foo.go")).toBe("go")
    expect(detectLanguage("foo.json")).toBe("json")
    expect(detectLanguage("foo.html")).toBe("html")
    expect(detectLanguage("foo.css")).toBe("css")
    expect(detectLanguage("foo.md")).toBe("markdown")
    expect(detectLanguage("foo.sh")).toBe("bash")
  })

  test("is case-insensitive on extension", () => {
    expect(detectLanguage("FOO.TS")).toBe("typescript")
  })

  test("returns undefined for unknown or extensionless", () => {
    expect(detectLanguage("foo.bin")).toBeUndefined()
    expect(detectLanguage("Makefile")).toBeUndefined()
    expect(detectLanguage("a.b/README")).toBeUndefined()
  })
})

describe("listDir", () => {
  test("sorts dirs first, then files, case-insensitive", async () => {
    await mkdir(join(root, "zeta"))
    await mkdir(join(root, "Alpha"))
    await writeFile(join(root, "banana.txt"), "x")
    await writeFile(join(root, "Apple.txt"), "x")

    const entries = await listDir(root)
    expect(entries.map((e) => e.name)).toEqual([
      "Alpha",
      "zeta",
      "Apple.txt",
      "banana.txt",
    ])
    expect(entries[0].isDir).toBe(true)
    expect(entries[0].path).toBe(join(root, "Alpha"))
    expect(entries[2].isDir).toBe(false)
  })
})

describe("enumerateFiles", () => {
  test("respects .gitignore and skips .git in a git repo", async () => {
    await initGitRepo(root)
    await writeFile(join(root, ".gitignore"), "ignored.txt\nbuild/\n")
    await writeFile(join(root, "keep.ts"), "x")
    await writeFile(join(root, "ignored.txt"), "x")
    await mkdir(join(root, "build"))
    await writeFile(join(root, "build", "out.js"), "x")

    const { files, truncated } = await enumerateFiles(root)
    expect(truncated).toBe(false)
    expect(files).toContain("keep.ts")
    expect(files).toContain(".gitignore")
    expect(files).not.toContain("ignored.txt")
    expect(files.some((f) => f.startsWith("build/"))).toBe(false)
    expect(files.some((f) => f.startsWith(".git/"))).toBe(false)
  })

  test("fallback walk skips node_modules/.git/dist/coverage in a non-git dir", async () => {
    await writeFile(join(root, "keep.ts"), "x")
    for (const skip of ["node_modules", ".git", "dist", "coverage"]) {
      await mkdir(join(root, skip))
      await writeFile(join(root, skip, "junk.js"), "x")
    }
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "index.ts"), "x")

    const { files, truncated } = await enumerateFiles(root)
    expect(truncated).toBe(false)
    expect(files).toContain("keep.ts")
    expect(files).toContain(join("src", "index.ts"))
    for (const skip of ["node_modules", ".git", "dist", "coverage"]) {
      expect(files.some((f) => f.startsWith(skip))).toBe(false)
    }
  })

  test("a generous budget returns a complete, non-truncated listing", async () => {
    for (let i = 0; i < 20; i++) await writeFile(join(root, `f${i}.txt`), "x")

    const { files, truncated } = await enumerateFiles(root, { walkBudgetMs: 60_000 })
    expect(truncated).toBe(false)
    expect(files.length).toBe(20)
  })

  test("an exhausted time budget truncates the walk (partial list)", async () => {
    // A tree deep/wide enough that a 0ms budget trips before it finishes: the
    // per-directory deadline check aborts descent, so the result is partial.
    for (let d = 0; d < 5; d++) {
      const sub = join(root, `dir${d}`)
      await mkdir(sub)
      for (let i = 0; i < 5; i++) await writeFile(join(sub, `f${i}.txt`), "x")
    }

    const { files, truncated } = await enumerateFiles(root, { walkBudgetMs: 0 })
    expect(truncated).toBe(true)
    // Partial: the deadline aborts before the whole 25-file tree is enumerated.
    expect(files.length).toBeLessThan(25)
  })
})

describe("createDirWatcher", () => {
  // Bounded poll: fs.watch delivery latency varies wildly under full-suite load,
  // so poll until the change lands or the generous deadline passes.
  const waitFor = (
    batches: FileChange[][],
    path: string,
    type: FileChange["type"],
    reTouch?: () => Promise<void>,
  ) => {
    const seen = () =>
      batches.flat().some((c) => c.path === path && c.type === type)
    return (async () => {
      const deadline = Date.now() + 6000
      while (!seen() && Date.now() < deadline) {
        if (reTouch) await reTouch()
        await Bun.sleep(100)
      }
      return seen()
    })()
  }

  test("classifies created, changed and deleted per watched dir", async () => {
    const a = join(root, "a")
    const b = join(root, "b")
    await mkdir(a)
    await mkdir(b)

    const batches: FileChange[][] = []
    const dw = createDirWatcher((changes) => batches.push(changes))
    dw.add(a)
    dw.add(b)

    const fileA = join(a, "one.txt")
    const fileB = join(b, "two.txt")

    await writeFile(fileA, "hello")
    await writeFile(fileB, "world")
    expect(await waitFor(batches, fileA, "created")).toBe(true)
    expect(await waitFor(batches, fileB, "created")).toBe(true)

    let n = 0
    expect(
      await waitFor(batches, fileA, "changed", () =>
        writeFile(fileA, `hello ${n++}`),
      ),
    ).toBe(true)

    await rm(fileA)
    expect(await waitFor(batches, fileA, "deleted")).toBe(true)

    dw.dispose()
  }, 20000)

  test("is non-recursive: events from unwatched child/sibling dirs do not fire", async () => {
    const watched = join(root, "watched")
    const child = join(watched, "child")
    const sibling = join(root, "sibling")
    await mkdir(watched)
    await mkdir(child)
    await mkdir(sibling)

    const batches: FileChange[][] = []
    const dw = createDirWatcher((changes) => batches.push(changes))
    dw.add(watched)

    // A direct child file must be observed, proving the watcher is live.
    const direct = join(watched, "direct.txt")
    await writeFile(direct, "x")
    expect(await waitFor(batches, direct, "created")).toBe(true)

    // Writes below the watched dir (nested) and beside it (sibling) must not.
    const nested = join(child, "deep.txt")
    const beside = join(sibling, "beside.txt")
    await writeFile(nested, "x")
    await writeFile(beside, "x")
    await Bun.sleep(300)

    const paths = batches.flat().map((c) => c.path)
    expect(paths).not.toContain(nested)
    expect(paths).not.toContain(beside)

    dw.dispose()
  }, 20000)

  test("add is idempotent", async () => {
    const dir = join(root, "dir")
    await mkdir(dir)

    const batches: FileChange[][] = []
    const dw = createDirWatcher((changes) => batches.push(changes))
    dw.add(dir)
    dw.add(dir)
    dw.add(dir)

    const file = join(dir, "f.txt")
    await writeFile(file, "x")
    expect(await waitFor(batches, file, "created")).toBe(true)

    // A duplicate add must not register a second watcher (no doubled events).
    const created = batches
      .flat()
      .filter((c) => c.path === file && c.type === "created")
    expect(created.length).toBe(1)

    dw.dispose()
  }, 20000)

  test("remove stops events for that dir", async () => {
    const dir = join(root, "dir")
    await mkdir(dir)

    const batches: FileChange[][] = []
    const dw = createDirWatcher((changes) => batches.push(changes))
    dw.add(dir)
    dw.remove(dir)

    await writeFile(join(dir, "f.txt"), "x")
    await Bun.sleep(300)

    expect(batches.flat().some((c) => c.path === join(dir, "f.txt"))).toBe(false)

    dw.remove(dir) // no-op on an unwatched dir
    dw.dispose()
  })

  test("dispose closes all watchers", async () => {
    const a = join(root, "a")
    const b = join(root, "b")
    await mkdir(a)
    await mkdir(b)

    const batches: FileChange[][] = []
    const dw = createDirWatcher((changes) => batches.push(changes))
    dw.add(a)
    dw.add(b)
    dw.dispose()

    await writeFile(join(a, "f.txt"), "x")
    await writeFile(join(b, "g.txt"), "x")
    await Bun.sleep(300)

    expect(batches.flat().length).toBe(0)
  })

  test("deleting a watched dir does not crash", async () => {
    const dir = join(root, "gone")
    await mkdir(dir)

    const batches: FileChange[][] = []
    const dw = createDirWatcher((changes) => batches.push(changes))
    dw.add(dir)

    await rm(dir, { recursive: true, force: true })
    // Give the FSWatcher's error/close path time to fire and auto-remove.
    await Bun.sleep(300)

    // Still usable afterwards.
    const other = join(root, "other")
    await mkdir(other)
    dw.add(other)
    const file = join(other, "f.txt")
    await writeFile(file, "x")
    expect(await waitFor(batches, file, "created")).toBe(true)

    dw.dispose()
  }, 20000)

  test("add on a nonexistent dir does not throw", () => {
    const dw = createDirWatcher(() => {})
    expect(() => dw.add(join(root, "does-not-exist"))).not.toThrow()
    dw.dispose()
  })
})
