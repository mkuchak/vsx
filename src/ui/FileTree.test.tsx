import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { workbenchStore } from "../model/workbench"
import * as workspace from "../services/workspace"
import { FileTree } from "./FileTree"

let testSetup: Awaited<ReturnType<typeof testRender>>
let dir: string
let listDirSpy: ReturnType<typeof spyOn<typeof workspace, "listDir">>
let dirWatcherSpy: ReturnType<typeof spyOn<typeof workspace, "createDirWatcher">> | undefined

// Replaces the real per-directory fs.watch manager with an inert one, for
// tests asserting lazy-load counts / expand-state that must not race a real
// filesystem event refreshing a dir out from under them.
function stubDirWatcher() {
  dirWatcherSpy = spyOn(workspace, "createDirWatcher").mockReturnValue({
    add: () => {},
    remove: () => {},
    dispose: () => {},
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vsx-filetree-"))
  await mkdir(join(dir, "src"))
  await writeFile(join(dir, "src", "index.ts"), "export {}\n")
  await writeFile(join(dir, "src", "util.ts"), "export {}\n")
  await writeFile(join(dir, "package.json"), "{}\n")
  await writeFile(join(dir, "README.md"), "# hi\n")
  listDirSpy = spyOn(workspace, "listDir")
  dirWatcherSpy = undefined
})

afterEach(async () => {
  listDirSpy.mockRestore()
  dirWatcherSpy?.mockRestore()
  if (testSetup) testSetup.renderer.destroy()
  workbenchStore.reset()
  await rm(dir, { recursive: true, force: true })
})

function render(props?: Partial<Parameters<typeof FileTree>[0]>) {
  const onOpenFile = props?.onOpenFile ?? (() => {})
  return testRender(
    <box width={40} height={12}>
      <FileTree root={dir} focused onOpenFile={onOpenFile} {...props} />
    </box>,
    { width: 40, height: 12 },
  )
}

async function waitForText(text: string, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await testSetup.flush()
    if (testSetup.captureCharFrame().includes(text)) return
    await Bun.sleep(30)
  }
  throw new Error(`timed out waiting for "${text}"\n${testSetup.captureCharFrame()}`)
}

// Lets React commit state AND run passive effects (which refresh useKeyboard's
// handler ref) between simulated keypresses; a bare flush() does not run them.
async function settle() {
  for (let i = 0; i < 5; i++) {
    await testSetup.flush()
    await Bun.sleep(10)
  }
}

function callsFor(path: string) {
  return listDirSpy.mock.calls.filter((c) => c[0] === path).length
}

test("renders root children collapsed", async () => {
  testSetup = await render()
  await waitForText("package.json")

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("src")
  expect(frame).toContain("package.json")
  expect(frame).toContain("README.md")
  // src is a collapsed directory, its children must not be visible
  expect(frame).not.toContain("index.ts")
  expect(frame).toContain("▸")
  expect(frame).toMatchSnapshot()
})

test("expands a directory and lazily loads its children exactly once", async () => {
  // Stub the filesystem watcher: this test asserts the lazy-load count for
  // expand/collapse/re-expand, which is orthogonal to watcher-driven refreshes.
  // Under load, a late FSEvent for the pre-created src/* files lands after src
  // is cached and fires refresh(srcPath), fetching a second time — making the
  // count 2 through no fault of the lazy-load path. Real watch behavior is
  // covered by "watcher refresh picks up a file created under the root".
  stubDirWatcher()
  testSetup = await render()
  await waitForText("src")

  const srcPath = join(dir, "src")
  expect(callsFor(srcPath)).toBe(0)

  // src is selected (index 0); Right expands it.
  testSetup.mockInput.pressArrow("right")
  await waitForText("index.ts")

  expect(testSetup.captureCharFrame()).toContain("util.ts")
  expect(testSetup.captureCharFrame()).toContain("▾")
  expect(callsFor(srcPath)).toBe(1)

  // Collapse then re-expand: children must not be re-fetched.
  testSetup.mockInput.pressArrow("left")
  await settle()
  expect(testSetup.captureCharFrame()).not.toContain("index.ts")

  testSetup.mockInput.pressArrow("right")
  await waitForText("index.ts")
  expect(callsFor(srcPath)).toBe(1)

  expect(testSetup.captureCharFrame()).toMatchSnapshot()
})

test("arrow navigation + Enter opens the selected file with preview", async () => {
  const opened: Array<{ path: string; opts: { preview: boolean } }> = []
  testSetup = await render({
    onOpenFile: (path, opts) => opened.push({ path, opts }),
  })
  await waitForText("package.json")

  // rows: [src(dir), package.json, README.md]. Move to package.json.
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  expect(opened).toEqual([
    { path: join(dir, "package.json"), opts: { preview: true } },
  ])
})

test("Enter on a collapsed directory expands it", async () => {
  testSetup = await render()
  await waitForText("src")

  testSetup.mockInput.pressEnter()
  await waitForText("index.ts")

  expect(testSetup.captureCharFrame()).toContain("index.ts")
})

test("watcher refresh picks up a file created under the root", async () => {
  testSetup = await render()
  await waitForText("package.json")
  expect(testSetup.captureCharFrame()).not.toContain("fresh.ts")

  await writeFile(join(dir, "fresh.ts"), "export {}\n")

  await waitForText("fresh.ts")
  expect(testSetup.captureCharFrame()).toContain("fresh.ts")
})

test("expanding a dir installs a watch that refreshes it on external change", async () => {
  // Proves we watch listed SUBdirectories, not just the root: a file created
  // under an expanded dir must show up, which only works if load() installed a
  // per-dir watch on it.
  testSetup = await render()
  await waitForText("src")

  testSetup.mockInput.pressEnter() // expand src
  await waitForText("index.ts")
  expect(testSetup.captureCharFrame()).not.toContain("added.ts")

  await writeFile(join(dir, "src", "added.ts"), "export {}\n")
  await waitForText("added.ts")
  expect(testSetup.captureCharFrame()).toContain("added.ts")
})

test("changes in a never-expanded subtree trigger no listing or refresh", async () => {
  // Create nested content BEFORE mount so no event fires for it, then mutate it
  // while src stays collapsed. Since src was never listed, no watch was ever
  // installed under it, so the deep change must produce neither a listing of src
  // nor any visible row.
  await mkdir(join(dir, "src", "nested"))
  testSetup = await render()
  await waitForText("src")

  const srcPath = join(dir, "src")
  expect(callsFor(srcPath)).toBe(0)

  await writeFile(join(dir, "src", "nested", "deep.ts"), "export {}\n")
  await settle()
  await Bun.sleep(200) // exceed the watch debounce so any stray event would land
  await settle()

  expect(callsFor(srcPath)).toBe(0)
  expect(testSetup.captureCharFrame()).not.toContain("deep.ts")
})

test("unmount disposes all directory watches (no stray refresh after)", async () => {
  let disposed = 0
  const realCreate = workspace.createDirWatcher
  dirWatcherSpy = spyOn(workspace, "createDirWatcher").mockImplementation((cb) => {
    const inner = realCreate(cb)
    return {
      add: (d) => inner.add(d),
      remove: (d) => inner.remove(d),
      dispose: () => {
        disposed++
        inner.dispose()
      },
    }
  })

  testSetup = await render()
  await waitForText("package.json")

  testSetup.renderer.destroy()
  await Bun.sleep(50)
  expect(disposed).toBe(1)

  // Swap in an inert render so afterEach's destroy() has a live target and no
  // second FileTree mounts to muddy the assertion below.
  testSetup = await testRender(<box />, { width: 40, height: 12 })
  const before = listDirSpy.mock.calls.length
  await writeFile(join(dir, "after-unmount.ts"), "export {}\n")
  await Bun.sleep(200)
  expect(listDirSpy.mock.calls.length).toBe(before)
})

test("expanded folders survive an unmount + remount (sidebar hide/show or tab switch)", async () => {
  // Stub the watcher: this test is about expand-state persistence across mounts,
  // orthogonal to watcher-driven refreshes (see the lazy-load test's rationale).
  stubDirWatcher()
  testSetup = await render()
  await waitForText("src")

  // src is selected (index 0); Enter expands it.
  testSetup.mockInput.pressEnter()
  await waitForText("index.ts")
  expect(testSetup.captureCharFrame()).toContain("▾")

  // Tear down this FileTree entirely — this is what App.tsx's sidebar does both
  // on Ctrl+B (unmount the whole sidebar) and on switching sidebarView away from
  // "explorer" and back (a ternary swap, not a CSS hide). The workbenchStore
  // singleton is untouched by this, unlike local component state.
  testSetup.renderer.destroy()

  testSetup = await render()
  // The remounted instance must show src already expanded, children and all —
  // not just the caret: this also exercises the mount-time fix that kicks off
  // load() for every already-expanded directory, since `cache` is NOT persisted
  // (only `expanded` is), so a fresh mount has no cached children yet.
  await waitForText("index.ts")
  expect(testSetup.captureCharFrame()).toContain("util.ts")
  expect(testSetup.captureCharFrame()).toContain("▾")
})

test("collapseAllExplorerPaths collapses an already-rendered tree reactively", async () => {
  stubDirWatcher()
  testSetup = await render()
  await waitForText("src")

  testSetup.mockInput.pressEnter()
  await waitForText("index.ts")

  workbenchStore.collapseAllExplorerPaths()
  await settle()

  expect(testSetup.captureCharFrame()).not.toContain("index.ts")
  expect(testSetup.captureCharFrame()).not.toContain("util.ts")
  expect(testSetup.captureCharFrame()).toContain("▸")
})
