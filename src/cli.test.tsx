import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { resolveWorkspaceArg } from "./cli"
import { documentRegistry } from "./model/documents"
import { workbenchStore } from "./model/workbench"
import { App } from "./workbench/App"

// `process.argv` shape: [binary, script, ...userArgs], so the first two entries
// are always ignored by resolveWorkspaceArg.
const argv = (...userArgs: string[]) => ["bun", "src/main.tsx", ...userArgs]

test("no positional arg returns the cwd unchanged", () => {
  const result = resolveWorkspaceArg(argv(), "/some/cwd")
  expect(result).toEqual({ root: "/some/cwd" })
})

test("a relative arg is resolved against cwd to an absolute path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vsx-cli-"))
  try {
    const parent = resolve(dir, "..")
    const rel = basename(dir)
    const result = resolveWorkspaceArg(argv(rel), parent)
    expect(result).toEqual({ root: dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a nonexistent path returns an error result", () => {
  const missing = join(tmpdir(), "vsx-does-not-exist-xyz-123")
  const result = resolveWorkspaceArg(argv(missing), tmpdir())
  expect(result).toEqual({ error: `vsx: not a directory: ${missing}` })
})

test("a path that is a file (not a directory) returns an error result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vsx-cli-"))
  try {
    const file = join(dir, "hello.ts")
    await writeFile(file, "x")
    const result = resolveWorkspaceArg(argv(file), tmpdir())
    expect(result).toEqual({ error: `vsx: not a directory: ${file}` })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a symlink pointing at a real directory resolves successfully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vsx-cli-"))
  try {
    const target = join(dir, "real")
    const link = join(dir, "link")
    await writeFile(join(dir, "keep"), "x")
    const { mkdir } = await import("node:fs/promises")
    await mkdir(target)
    await symlink(target, link)
    const result = resolveWorkspaceArg(argv(link), tmpdir())
    expect(result).toEqual({ root: link })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("leading-flag args are skipped in favor of the first positional", () => {
  const result = resolveWorkspaceArg(argv("--foo", "-x"), "/some/cwd")
  expect(result).toEqual({ root: "/some/cwd" })
})

// Integration: a resolved root that is NOT process.cwd() must drive the whole
// workbench correctly — FileTree lists the root's contents and opening a file
// through the model loads it. This exercises the #29 absolute-path invariant
// across a non-cwd workspace root, the way `vsx <dir>` launches it.
test("App renders and opens files under a non-cwd workspace root", async () => {
  const root = await mkdtemp(join(tmpdir(), "vsx-cli-app-"))
  const git = async (args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
    await proc.exited
  }
  let testSetup: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    await git(["init", "-q"])
    await git(["config", "user.email", "a@b.com"])
    await git(["config", "user.name", "Test"])
    await writeFile(join(root, "hello.ts"), "const greeting = 'hi'\n")
    await git(["add", "."])
    await git(["commit", "-q", "-m", "initial"])
    workbenchStore.reset()

    expect(root).not.toBe(process.cwd())
    const resolved = resolveWorkspaceArg(argv(root), process.cwd())
    expect(resolved).toEqual({ root })

    testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
    await Bun.sleep(400)
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("hello.ts")

    workbenchStore.openFile(join(root, "hello.ts"), { preview: true })
    await Bun.sleep(200)
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("greeting")
    expect(documentRegistry.get(join(root, "hello.ts"))?.language).toBe("typescript")
  } finally {
    if (testSetup) testSetup.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
})
