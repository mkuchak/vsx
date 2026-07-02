import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { realpathSync } from "node:fs"
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { ModalProvider } from "../workbench/ModalProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { GitService } from "../services/git"
import { documentRegistry } from "../model/documents"
import * as trash from "../services/trash"
import { ScmPanel, type ScmPanelProps } from "./ScmPanel"

let testSetup: Awaited<ReturnType<typeof testRender>>
let root: string
let git: GitService

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vsx-scm-"))
  await sh(["init", "-q"])
  await sh(["config", "user.email", "a@b.com"])
  await sh(["config", "user.name", "Tester"])
  await sh(["config", "commit.gpgsign", "false"])
  git = new GitService(root)
})

afterEach(async () => {
  if (testSetup) testSetup.renderer.destroy()
  // Let the unmount cleanup (watcher dispose + in-flight status) settle before
  // deleting the repo so lingering git spawns don't race the next test.
  await Bun.sleep(50)
  await rm(root, { recursive: true, force: true })
  mock.restore()
})

function render(
  props?: Partial<ScmPanelProps>,
  dims: { width: number; height: number } = { width: 44, height: 20 },
) {
  return testRender(
    <box width={dims.width} height={dims.height}>
      <CommandsProvider>
        <OverlayProvider>
          <ModalProvider>
            <ScmPanel workspaceRoot={root} focused {...props} />
          </ModalProvider>
        </OverlayProvider>
      </CommandsProvider>
    </box>,
    { width: dims.width, height: dims.height },
  )
}

// Discard dialogs render text wider than the default 44-col panel; a roomy
// viewport keeps message lines unwrapped so substring assertions are stable.
const WIDE = { width: 80, height: 24 }

async function waitForText(text: string, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await testSetup.flush()
    if (testSetup.captureCharFrame().includes(text)) return
    await Bun.sleep(30)
  }
  throw new Error(
    `timed out waiting for "${text}"\n${testSetup.captureCharFrame()}`,
  )
}

async function waitForTextGone(text: string, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await testSetup.flush()
    if (!testSetup.captureCharFrame().includes(text)) return
    await Bun.sleep(30)
  }
  throw new Error(
    `timed out waiting for "${text}" to disappear\n${testSetup.captureCharFrame()}`,
  )
}

// Commit + run passive effects so useKeyboard's handler ref (and command
// closures) see the latest state between simulated keypresses.
async function settle(passes = 6) {
  for (let i = 0; i < passes; i++) {
    await testSetup.flush()
    await Bun.sleep(15)
  }
}

// The panel owns a *separate* GitService on the same repo, so a bare git call
// from the test can momentarily race the panel's index-writing ops for
// `.git/index.lock`. Retry briefly to read a consistent snapshot.
async function statusNow(retries = 10) {
  for (;;) {
    try {
      return await git.status()
    } catch (e) {
      if (retries-- <= 0) throw e
      await Bun.sleep(40)
    }
  }
}

async function baseline() {
  await write("tracked.txt", "one\n")
  await sh(["add", "-A"])
  await sh(["commit", "-q", "-m", "base"])
}

async function createConflict() {
  // conflict.txt diverges on two branches; merging leaves it unmerged (UU).
  await write("conflict.txt", "base\n")
  await sh(["add", "conflict.txt"])
  await sh(["commit", "-q", "-m", "add conflict.txt"])
  const branch = (
    await Bun.$`git -C ${root} rev-parse --abbrev-ref HEAD`.text()
  ).trim()
  await sh(["checkout", "-q", "-b", "feature"])
  await write("conflict.txt", "feature\n")
  await sh(["commit", "-qam", "feature edit"])
  await sh(["checkout", "-q", branch])
  await write("conflict.txt", "main\n")
  await sh(["commit", "-qam", "main edit"])
  const merge = Bun.spawn(["git", "merge", "feature"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  await merge.exited // non-zero on conflict, which is expected
}

test("groups merge, staged, changes, and untracked files with counts", async () => {
  await baseline()
  await createConflict()

  // staged addition
  await write("added.txt", "new\n")
  await sh(["add", "added.txt"])
  // worktree modification (Changes)
  await write("tracked.txt", "two\n")
  // untracked
  await write("untracked.txt", "u\n")

  testSetup = await render()
  await waitForText("Untracked Changes")
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Merge Changes")
  expect(frame).toContain("conflict.txt")
  expect(frame).toContain("Staged Changes")
  expect(frame).toContain("added.txt")
  expect(frame).toContain("tracked.txt")
  expect(frame).toContain("Untracked Changes")
  expect(frame).toContain("untracked.txt")
  expect(frame).toContain("SOURCE CONTROL")
  expect(frame).toMatchSnapshot()
})

test("staging a Changes-file moves it to Staged; unstage reverses it", async () => {
  await baseline()
  await write("tracked.txt", "two\n")

  testSetup = await render()
  await waitForText("tracked.txt")
  await settle()

  // Rows: [group Changes, file tracked.txt]. Select the file, then stage it.
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressKey(" ")
  // Wait for the panel's own refresh to reflect the move before reading git.
  await waitForText("Staged Changes")

  let s = await statusNow()
  expect(s.staged.map((f) => f.path)).toContain("tracked.txt")
  expect(s.changes.map((f) => f.path)).not.toContain("tracked.txt")

  await settle()
  // The file is still selected (row 1); unstage it.
  testSetup.mockInput.pressKey("-")
  await waitForTextGone("Staged Changes")

  s = await statusNow()
  expect(s.changes.map((f) => f.path)).toContain("tracked.txt")
  expect(s.staged.map((f) => f.path)).not.toContain("tracked.txt")
})

test("commit with staged changes creates a real commit and clears the group", async () => {
  await baseline()
  await write("added.txt", "new\n")
  await sh(["add", "added.txt"])

  testSetup = await render()
  await waitForText("Staged Changes")
  await settle()

  // Focus the commit input, type a message, press Enter to commit.
  testSetup.mockInput.pressKey("i")
  await settle()
  await testSetup.mockInput.typeText("add file")
  await settle()
  testSetup.mockInput.pressEnter()
  await waitForTextGone("Staged Changes")

  const log = await git.log({ maxEntries: 5 })
  expect(log[0].message).toBe("add file")
  expect(testSetup.captureCharFrame()).not.toContain("added.txt")
})

test("commit with nothing staged requires a second Enter to stage-all & commit", async () => {
  await baseline()
  await write("tracked.txt", "two\n")

  testSetup = await render()
  await waitForText("Changes")
  await settle()

  testSetup.mockInput.pressKey("i")
  await settle()
  await testSetup.mockInput.typeText("commit all")
  await settle()

  // First Enter: no staged changes -> confirmation, no commit yet.
  testSetup.mockInput.pressEnter()
  await waitForText("Press Enter again")
  const s = await statusNow()
  expect(s.changes.map((f) => f.path)).toContain("tracked.txt")

  // Second Enter: stages all tracked & commits.
  testSetup.mockInput.pressEnter()
  await waitForTextGone("tracked.txt")

  const log = await git.log({ maxEntries: 5 })
  expect(log[0].message).toBe("commit all")
  expect((await statusNow()).changes.length).toBe(0)
})

test("a typechanged file (T) can be staged and then discarded", async () => {
  await write("swap.txt", "regular file\n")
  await sh(["add", "-A"])
  await sh(["commit", "-q", "-m", "base"])
  // Replace the regular file with a symlink -> git status " T swap.txt".
  await rm(join(root, "swap.txt"))
  await symlink("/tmp/whatever", join(root, "swap.txt"))

  testSetup = await render(undefined, WIDE)
  await waitForText("swap.txt")
  await settle()

  // Rows: [group Changes, file swap.txt]. Select the file, then stage it.
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressKey(" ")
  await waitForText("Staged Changes")

  let s = await statusNow()
  expect(s.staged.map((f) => f.path)).toContain("swap.txt")
  expect(s.staged.find((f) => f.path === "swap.txt")?.statusLetter).toBe("T")

  // Unstage it back to Changes (discard reverts from the index, so it must be
  // unstaged for the worktree to be restored to the original file from HEAD).
  await settle()
  testSetup.mockInput.pressKey("-")
  await waitForTextGone("Staged Changes")
  s = await statusNow()
  expect(s.changes.find((f) => f.path === "swap.txt")?.statusLetter).toBe("T")

  // The file is still selected; discard it and confirm the revert on disk.
  await settle()
  testSetup.mockInput.pressKey("x")
  await waitForText("discard changes in 'swap.txt'")
  testSetup.mockInput.pressEnter()
  await waitForTextGone("swap.txt")

  expect((await lstat(join(root, "swap.txt"))).isSymbolicLink()).toBe(false)
  expect(await Bun.file(join(root, "swap.txt")).text()).toBe("regular file\n")
  expect((await statusNow()).changes.length).toBe(0)
})

test("an external git change triggers a watcher-driven refresh", async () => {
  await baseline()

  testSetup = await render()
  await waitForText("SOURCE CONTROL")
  await settle()
  expect(testSetup.captureCharFrame()).not.toContain("external.txt")

  // Another process mutates the repo.
  await write("external.txt", "x\n")
  await sh(["add", "external.txt"])

  await waitForText("external.txt")
  expect(testSetup.captureCharFrame()).toContain("external.txt")
})

test("onOpenDiff fires with the right path and kind for a modified file", async () => {
  await baseline()
  await write("tracked.txt", "two\n")

  const diffs: Array<{ path: string; kind: "staged" | "unstaged" }> = []
  testSetup = await render({
    onOpenDiff: (path, kind) => diffs.push({ path, kind }),
  })
  await waitForText("tracked.txt")
  await settle()

  // Select the modified file (row after the Changes header), press 'o'.
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressKey("o")
  await settle()

  // ScmPanel opens absolute paths; discoverRepositories realpath-resolves the root.
  expect(diffs).toEqual([{ path: join(realpathSync(root), "tracked.txt"), kind: "unstaged" }])
})

test("discarding a single tracked file confirms, then reverts it on disk", async () => {
  await baseline()
  await write("tracked.txt", "two\n")

  testSetup = await render(undefined, WIDE)
  await waitForText("tracked.txt")
  await settle()

  // Rows: [group Changes, file tracked.txt]. Select the file, press 'x'.
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressKey("x")
  await waitForText("discard changes in 'tracked.txt'")

  // Nothing reverted yet — the dialog is only a prompt.
  expect(await Bun.file(join(root, "tracked.txt")).text()).toBe("two\n")

  // Default action is "Discard File"; Enter confirms it.
  testSetup.mockInput.pressEnter()
  await waitForTextGone("tracked.txt")

  expect(await Bun.file(join(root, "tracked.txt")).text()).toBe("one\n")
  expect((await statusNow()).changes.length).toBe(0)
})

test("cancelling a single tracked-file discard leaves the file untouched", async () => {
  await baseline()
  await write("tracked.txt", "two\n")

  testSetup = await render(undefined, WIDE)
  await waitForText("tracked.txt")
  await settle()

  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressKey("x")
  await waitForText("discard changes in 'tracked.txt'")

  testSetup.mockInput.pressEscape()
  await waitForTextGone("Discard File")

  expect(await Bun.file(join(root, "tracked.txt")).text()).toBe("two\n")
  expect((await statusNow()).changes.map((f) => f.path)).toContain("tracked.txt")
})

test("discarding a single untracked file moves it to Trash (mocked)", async () => {
  const moveToTrash = spyOn(trash, "moveToTrash").mockResolvedValue(undefined)
  await baseline()
  await write("untracked.txt", "u\n")

  testSetup = await render(undefined, WIDE)
  await waitForText("untracked.txt")
  await settle()

  // Rows: [group Untracked, file untracked.txt]. Select the file, press 'x'.
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressKey("x")
  await waitForText("DELETE 'untracked.txt'")

  // Default action is "Move to Trash"; Enter confirms it.
  testSetup.mockInput.pressEnter()
  await waitForTextGone("Move to Trash")

  expect(moveToTrash).toHaveBeenCalledTimes(1)
  // discoverRepositories realpath-resolves the root (/var -> /private/var on macOS).
  expect(moveToTrash.mock.calls[0][0]).toEqual([
    join(realpathSync(root), "untracked.txt"),
  ])
})

test("cancelling a single untracked discard leaves the file on disk", async () => {
  const moveToTrash = spyOn(trash, "moveToTrash").mockResolvedValue(undefined)
  await baseline()
  await write("untracked.txt", "u\n")

  testSetup = await render(undefined, WIDE)
  await waitForText("untracked.txt")
  await settle()

  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressKey("x")
  await waitForText("DELETE 'untracked.txt'")

  testSetup.mockInput.pressEscape()
  await waitForTextGone("Move to Trash")

  expect(moveToTrash).not.toHaveBeenCalled()
  expect(await Bun.file(join(root, "untracked.txt")).exists()).toBe(true)
})

test("discarding a Changes group shows the IRREVERSIBLE warning and reverts all files", async () => {
  await write("a.txt", "a1\n")
  await write("b.txt", "b1\n")
  await sh(["add", "-A"])
  await sh(["commit", "-q", "-m", "base"])
  await write("a.txt", "a2\n")
  await write("b.txt", "b2\n")

  testSetup = await render(undefined, WIDE)
  await waitForText("Changes")
  await settle()

  // The Changes group header is the first selectable row; discard the whole group.
  testSetup.mockInput.pressKey("x")
  await waitForText("This is IRREVERSIBLE!")
  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Discard All 2 Files")

  testSetup.mockInput.pressEnter()
  await waitForTextGone("This is IRREVERSIBLE!")
  await waitForTextGone("a.txt")

  expect(await Bun.file(join(root, "a.txt")).text()).toBe("a1\n")
  expect(await Bun.file(join(root, "b.txt")).text()).toBe("b1\n")
  expect((await statusNow()).changes.length).toBe(0)
})

test("discarding an Untracked group moves every file to Trash (mocked)", async () => {
  const moveToTrash = spyOn(trash, "moveToTrash").mockResolvedValue(undefined)
  await baseline()
  await write("u1.txt", "1\n")
  await write("u2.txt", "2\n")

  testSetup = await render(undefined, WIDE)
  await waitForText("Untracked Changes")
  await settle()

  // The Untracked group header is the first selectable row here.
  testSetup.mockInput.pressKey("x")
  await waitForText("DELETE the following 2 untracked files")

  testSetup.mockInput.pressEnter()
  await waitForTextGone("Move to Trash")

  expect(moveToTrash).toHaveBeenCalledTimes(1)
  const realRoot = realpathSync(root)
  expect(new Set(moveToTrash.mock.calls[0][0])).toEqual(
    new Set([join(realRoot, "u1.txt"), join(realRoot, "u2.txt")]),
  )
})

test("a successful discard reloads any open document for that path", async () => {
  await baseline()
  await write("tracked.txt", "two\n")

  const reloadFromDisk = mock(() => Promise.resolve())
  const trackedAbs = join(realpathSync(root), "tracked.txt")
  spyOn(documentRegistry, "get").mockImplementation((path: string) =>
    path === trackedAbs
      ? ({ reloadFromDisk } as unknown as ReturnType<typeof documentRegistry.get>)
      : undefined,
  )

  testSetup = await render(undefined, WIDE)
  await waitForText("tracked.txt")
  await settle()

  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressKey("x")
  await waitForText("discard changes in 'tracked.txt'")
  testSetup.mockInput.pressEnter()
  await waitForTextGone("tracked.txt")
  await settle()

  expect(reloadFromDisk).toHaveBeenCalledTimes(1)
})
