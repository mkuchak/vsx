import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { workbenchStore } from "../model/workbench"
import { StatusBar } from "./StatusBar"

let root: string
let testSetup: Awaited<ReturnType<typeof testRender>>

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vsx-statusbar-"))
  await git(root, ["init", "-q"])
  await git(root, ["config", "user.email", "a@b.com"])
  await git(root, ["config", "user.name", "Test"])
  await writeFile(join(root, "a.ts"), "const x = 1\n")
  await git(root, ["add", "."])
  await git(root, ["commit", "-q", "-m", "initial"])
  workbenchStore.reset()
})

afterEach(async () => {
  if (testSetup) testSetup.renderer.destroy()
  await rm(root, { recursive: true, force: true })
})

test("shows the current branch with no dirty count on a clean repo", async () => {
  testSetup = await testRender(<StatusBar workspaceRoot={root} cursor={null} />, {
    width: 80,
    height: 3,
  })
  await Bun.sleep(500)
  await testSetup.renderOnce()
  const frame = testSetup.captureCharFrame()
  expect(frame).toMatch(/main|master/)
  expect(frame).not.toContain("(")
})

test("shows a dirty count after an untracked file appears", async () => {
  await writeFile(join(root, "untracked.txt"), "x")
  testSetup = await testRender(<StatusBar workspaceRoot={root} cursor={null} />, {
    width: 80,
    height: 3,
  })
  await Bun.sleep(500)
  await testSetup.renderOnce()
  expect(testSetup.captureCharFrame()).toContain("(1)")
})

test("shows cursor position and language on the right", async () => {
  testSetup = await testRender(
    <StatusBar workspaceRoot={root} cursor={{ line: 3, column: 5 }} />,
    { width: 80, height: 3 },
  )
  await testSetup.renderOnce()
  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Ln 3, Col 5")
})

test("shows a transient message when provided", async () => {
  testSetup = await testRender(
    <StatusBar workspaceRoot={root} cursor={null} message="Saved" />,
    { width: 80, height: 3 },
  )
  await testSetup.renderOnce()
  expect(testSetup.captureCharFrame()).toContain("Saved")
})

test("shows 'no repository' when the workspace has no git repo", async () => {
  const bare = await mkdtemp(join(tmpdir(), "vsx-statusbar-norepo-"))
  try {
    testSetup = await testRender(<StatusBar workspaceRoot={bare} cursor={null} />, {
      width: 80,
      height: 3,
    })
    await Bun.sleep(500)
    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("no repository")
  } finally {
    await rm(bare, { recursive: true, force: true })
  }
})
