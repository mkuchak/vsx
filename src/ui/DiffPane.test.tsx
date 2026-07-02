import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { documentRegistry } from "../model/documents"
import { workbenchStore, type DiffTab } from "../model/workbench"
import { GitService } from "../services/git"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { WatchersProvider } from "../workbench/watchers"
import { DiffPane, pickHunkTarget, resolveDiff, resolveDiffContent } from "./DiffPane"

let root: string
let git: GitService
let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

async function sh(args: string[], stdin?: string): Promise<void> {
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

/** Build a diff tab pointing at an ABSOLUTE file path under the repo. */
function diffTab(rel: string, diffKind: "staged" | "unstaged"): DiffTab {
  const filePath = join(root, rel)
  return {
    kind: "diff",
    path: `diff::${diffKind}::${root}::${filePath}`,
    filePath,
    diffKind,
    repoRoot: root,
    preview: false,
    pinned: false,
  }
}

beforeEach(async () => {
  workbenchStore.reset()
  root = await mkdtemp(join(tmpdir(), "vsx-diff-"))
  await sh(["init", "-q"])
  await sh(["config", "user.email", "a@b.com"])
  await sh(["config", "user.name", "Tester"])
  await sh(["config", "commit.gpgsign", "false"])
  git = new GitService(root)
})

afterEach(async () => {
  testSetup?.renderer.destroy()
  testSetup = undefined
  workbenchStore.reset()
  await Bun.sleep(30)
  await rm(root, { recursive: true, force: true })
  mock.restore()
})

async function renderActiveDiff(dims = { width: 80, height: 12 }) {
  testSetup = await testRender(
    <OverlayProvider>
      <box width={dims.width} height={dims.height}>
        <CommandsProvider>
          <DiffPane focused />
        </CommandsProvider>
      </box>
    </OverlayProvider>,
    dims,
  )
  return testSetup
}

/** Render the active diff under a real WatchersProvider so the shared git watcher drives refreshes. */
async function renderActiveDiffWithWatchers(dims = { width: 80, height: 12 }) {
  testSetup = await testRender(
    <OverlayProvider>
      <WatchersProvider workspaceRoot={root}>
        <box width={dims.width} height={dims.height}>
          <CommandsProvider>
            <DiffPane focused />
          </CommandsProvider>
        </box>
      </WatchersProvider>
    </OverlayProvider>,
    dims,
  )
  return testSetup
}

async function waitForText(text: string, timeoutMs = 4000) {
  const setup = testSetup!
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await setup.flush()
    if (setup.captureCharFrame().includes(text)) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for "${text}"\n${setup.captureCharFrame()}`)
}

describe("resolveDiff content resolution", () => {
  test("unstaged: old = index/HEAD, new = working tree", async () => {
    await write("a.txt", "alpha\nbeta\ngamma\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "alpha\nBETA_CHANGED\ngamma\n")

    const { oldCode, newCode } = await resolveDiff(git, diffTab("a.txt", "unstaged"))
    expect(oldCode).toBe("alpha\nbeta\ngamma\n")
    expect(newCode).toBe("alpha\nBETA_CHANGED\ngamma\n")
  })

  test("staged: old = HEAD, new = index blob", async () => {
    await write("a.txt", "one\ntwo\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "one\nTWO_STAGED\n")
    await sh(["add", "a.txt"])
    // Then dirty the working tree further — staged diff must ignore this.
    await write("a.txt", "one\nWORKTREE_ONLY\n")

    const { oldCode, newCode } = await resolveDiff(git, diffTab("a.txt", "staged"))
    expect(oldCode).toBe("one\ntwo\n")
    expect(newCode).toBe("one\nTWO_STAGED\n")
  })

  test("added file (staged, no HEAD entry) has empty old content", async () => {
    await write("seed.txt", "seed\n")
    await sh(["add", "seed.txt"])
    await sh(["commit", "-qm", "init"])
    await write("new.txt", "brand new\n")
    await sh(["add", "new.txt"])

    const { oldCode, newCode } = await resolveDiff(git, diffTab("new.txt", "staged"))
    expect(oldCode).toBe("")
    expect(newCode).toBe("brand new\n")
  })

  test("deleted file (working tree gone) has empty new content", async () => {
    await write("gone.txt", "to be removed\n")
    await sh(["add", "gone.txt"])
    await sh(["commit", "-qm", "init"])
    await unlink(join(root, "gone.txt"))

    const { oldCode, newCode } = await resolveDiff(git, diffTab("gone.txt", "unstaged"))
    expect(oldCode).toBe("to be removed\n")
    expect(newCode).toBe("")
  })

  test("unstaged new side reflects unsaved edits from an open Document", async () => {
    await write("live.txt", "saved line\n")
    await sh(["add", "live.txt"])
    await sh(["commit", "-qm", "init"])

    const filePath = join(root, "live.txt")
    const doc = await documentRegistry.openDocument(filePath)
    doc.setText("edited but unsaved\n", "edit")

    const { oldCode, newCode } = await resolveDiff(git, diffTab("live.txt", "unstaged"))
    expect(oldCode).toBe("saved line\n")
    expect(newCode).toBe("edited but unsaved\n") // in-memory edit, not the on-disk blob

    documentRegistry.releaseDocument(filePath)
  })

  test("SCM-opened diff sees a live edit from a FileTree open (path shapes converge)", async () => {
    await write("shared.txt", "on disk\n")
    await sh(["add", "shared.txt"])
    await sh(["commit", "-qm", "init"])

    // FileTree shape: opens the file by ABSOLUTE path.
    const fileTreePath = join(root, "shared.txt")
    const doc = await documentRegistry.openDocument(fileTreePath)
    doc.setText("live edit\n", "edit")

    // ScmPanel shape: git-status-relative path joined onto the repo root. It must
    // resolve to the SAME absolute registry key, so the diff reflects the live
    // buffer instead of stale disk content. `diffTab` performs the join(root, rel).
    const { newCode } = await resolveDiff(git, diffTab("shared.txt", "unstaged"))
    expect(newCode).toBe("live edit\n")

    documentRegistry.releaseDocument(fileTreePath)
  })
})

describe("resolveDiffContent for commitDiff tabs", () => {
  test("resolves old/new content from the two commit refs", async () => {
    await write("a.txt", "one\ntwo\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "first"])
    const parent = (await git.log({ maxEntries: 1 }))[0].hash
    await write("a.txt", "one\nTWO_CHANGED\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "second"])
    const commit = (await git.log({ maxEntries: 1 }))[0].hash

    const { oldCode, newCode } = await resolveDiffContent(git, {
      kind: "commitDiff",
      path: `commitDiff::${root}::${commit}::${join(root, "a.txt")}`,
      filePath: join(root, "a.txt"),
      repoRoot: root,
      oldRef: parent,
      newRef: commit,
      label: "a.txt (second)",
      preview: false,
      pinned: false,
    })
    expect(oldCode).toBe("one\ntwo\n")
    expect(newCode).toBe("one\nTWO_CHANGED\n")
  })

  test("root commit: empty-tree old ref yields empty old content", async () => {
    await write("root.txt", "born\n")
    await sh(["add", "root.txt"])
    await sh(["commit", "-qm", "root"])
    const commit = (await git.log({ maxEntries: 1 }))[0].hash

    const { oldCode, newCode } = await resolveDiffContent(git, {
      kind: "commitDiff",
      path: `commitDiff::${root}::${commit}::${join(root, "root.txt")}`,
      filePath: join(root, "root.txt"),
      repoRoot: root,
      oldRef: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      newRef: commit,
      label: "root.txt (root)",
      preview: false,
      pinned: false,
    })
    expect(oldCode).toBe("")
    expect(newCode).toBe("born\n")
  })
})

describe("DiffPane renders a commitDiff tab opened via openCommitDiff", () => {
  test("resolves and shows both sides of a commit-vs-parent diff", async () => {
    await write("a.txt", "alpha\nbeta\ngamma\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "first"])
    const parent = (await git.log({ maxEntries: 1 }))[0].hash
    await write("a.txt", "alpha\nBETACHANGED\ngamma\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "second"])
    const commit = (await git.log({ maxEntries: 1 }))[0].hash

    workbenchStore.openCommitDiff(
      join(root, "a.txt"),
      parent,
      commit,
      root,
      `a.txt (${commit.slice(0, 7)})`,
      { preview: false },
    )
    await renderActiveDiff()

    await waitForText("BETACHANGED") // after side
    const frame = testSetup!.captureCharFrame()
    expect(frame).toContain("beta") // before side
    expect(frame).toContain(commit.slice(0, 7)) // header label carries the short hash
  })
})

describe("DiffPane refreshes on external git changes via the shared watcher", () => {
  test("an unstaged diff re-resolves after an outside `git add` (old side catches up)", async () => {
    // discoverRepositories realpath-resolves the root, so the shared watcher emits
    // the realpath'd root; the tab's repoRoot must match for the refresh to fire.
    const realRoot = realpathSync(root)
    await write("a.txt", "alpha\nbeta\ngamma\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "alpha\nBETACHANGED\ngamma\n")

    workbenchStore.openDiff(join(realRoot, "a.txt"), "unstaged", realRoot, { preview: false })
    await renderActiveDiffWithWatchers()
    await waitForText("BETACHANGED") // the unstaged diff is showing

    // An outside process stages the change: the index (old side) now matches the
    // working tree, so the pane must re-resolve to "No changes".
    await sh(["add", "a.txt"])
    await waitForText("No changes")
  })
})

describe("pickHunkTarget", () => {
  test("next moves to the following hunk and wraps", () => {
    expect(pickHunkTarget([0, 7, 20], 0, 1)).toBe(7)
    expect(pickHunkTarget([0, 7, 20], 7, 1)).toBe(20)
    expect(pickHunkTarget([0, 7, 20], 20, 1)).toBe(0) // wrap to first
  })

  test("prev moves to the preceding hunk and wraps", () => {
    expect(pickHunkTarget([0, 7, 20], 20, -1)).toBe(7)
    expect(pickHunkTarget([0, 7, 20], 7, -1)).toBe(0)
    expect(pickHunkTarget([0, 7, 20], 0, -1)).toBe(20) // wrap to last
  })

  test("no offsets yields null", () => {
    expect(pickHunkTarget([], 0, 1)).toBeNull()
  })
})

describe("DiffPane rendering + interaction", () => {
  test("shows a placeholder when no diff tab is active", async () => {
    await renderActiveDiff()
    await waitForText("No diff open")
  })

  test("unstaged modification renders both before and after content in split view", async () => {
    await write("a.txt", "alpha\nbeta\ngamma\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "alpha\nBETACHANGED\ngamma\n")

    workbenchStore.openDiff(join(root, "a.txt"), "unstaged", root, { preview: false })
    await renderActiveDiff()

    await waitForText("BETACHANGED") // the "after" side
    expect(testSetup!.captureCharFrame()).toContain("beta") // the "before" side
  })

  test("v toggles between split and unified view", async () => {
    await write("a.txt", "one\ntwo\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "one\nCHANGED\n")

    workbenchStore.openDiff(join(root, "a.txt"), "unstaged", root, { preview: false })
    await renderActiveDiff()
    await waitForText("Split")

    testSetup!.mockInput.pressKey("v")
    await waitForText("Unified")
  })

  test("Ctrl+V is a paste chord, not the 'v' view-toggle", async () => {
    await write("a.txt", "one\ntwo\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "one\nCHANGED\n")

    workbenchStore.openDiff(join(root, "a.txt"), "unstaged", root, { preview: false })
    // kittyKeyboard is required for the mock to deliver a disambiguated Ctrl+V as
    // key.name="v" with ctrl=true — without it, Ctrl+V never reaches the handler
    // as "v" and the bare-letter guard wouldn't even be exercised.
    const dims = { width: 80, height: 12 }
    testSetup = await testRender(
      <OverlayProvider>
        <box width={dims.width} height={dims.height}>
          <CommandsProvider>
            <DiffPane focused />
          </CommandsProvider>
        </box>
      </OverlayProvider>,
      { ...dims, kittyKeyboard: true },
    )
    // The initial view depends on module-level `lastView`, so capture it rather
    // than assuming.
    await waitForText("v toggle")
    const before = testSetup.captureCharFrame().includes("Split") ? "Split" : "Unified"
    const opposite = before === "Split" ? "Unified" : "Split"

    // Ctrl+V (paste) must be ignored; a following bare `v` toggles exactly once,
    // so the view must land on the OPPOSITE. If the guard were missing, Ctrl+V
    // would toggle too and the two presses would cancel back to `before`.
    testSetup.mockInput.pressKey("v", { ctrl: true })
    for (let i = 0; i < 6; i++) await testSetup.flush()
    testSetup.mockInput.pressKey("v")
    await waitForText(opposite)
  })

  test("n hunk navigation scrolls to a later hunk", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`)
    await write("big.txt", lines.join("\n") + "\n")
    await sh(["add", "big.txt"])
    await sh(["commit", "-qm", "init"])
    lines[2] = "HUNK_ONE_CHANGE"
    lines[55] = "HUNK_TWO_CHANGE"
    await write("big.txt", lines.join("\n") + "\n")

    workbenchStore.openDiff(join(root, "big.txt"), "unstaged", root, { preview: false })
    await renderActiveDiff({ width: 80, height: 8 })
    await waitForText("HUNK_ONE_CHANGE")

    const before = testSetup!.captureCharFrame()
    testSetup!.mockInput.pressKey("n")
    for (let i = 0; i < 6; i++) await testSetup!.flush()
    await Bun.sleep(30)
    await testSetup!.flush()
    const after = testSetup!.captureCharFrame()

    expect(after).not.toBe(before) // scroll position moved
  })
})
