import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  detectLanguage,
  enumerateFiles,
  listDir,
  watch,
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
  const proc = Bun.spawn(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
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
})

describe("watch", () => {
  test("emits created, changed and deleted (debounced)", async () => {
    const batches: FileChange[][] = []
    const dispose = watch(root, (changes) => batches.push(changes))
    const target = join(root, "a.txt")
    const typesSeen = () =>
      batches.flat().filter((c) => c.path === target).map((c) => c.type)
    // Bounded poll instead of fixed sleeps: FSEvents delivery latency varies
    // wildly under full-suite load (this test flaked at 500ms/step), and waiting
    // for each event before the next mutation also stops the OS from coalescing
    // create+modify into a single event.
    const waitFor = async (type: FileChange["type"]) => {
      const deadline = Date.now() + 3000
      while (!typesSeen().includes(type) && Date.now() < deadline) {
        await Bun.sleep(50)
      }
    }

    await writeFile(target, "hello")
    await waitFor("created")

    await writeFile(target, "hello world")
    await waitFor("changed")

    await rm(target)
    await waitFor("deleted")

    dispose()

    const types = typesSeen()
    expect(types).toContain("created")
    expect(types).toContain("changed")
    expect(types).toContain("deleted")
  })

  test("disposer stops emitting", async () => {
    const batches: FileChange[][] = []
    const dispose = watch(root, (changes) => batches.push(changes))
    dispose()

    await writeFile(join(root, "b.txt"), "x")
    await Bun.sleep(200)

    expect(batches.flat().some((c) => c.path === join(root, "b.txt"))).toBe(false)
  })
})
