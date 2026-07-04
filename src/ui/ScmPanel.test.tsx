import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { realpathSync } from "node:fs"
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { ModalProvider } from "../workbench/ModalProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { GitService, type StatusResult } from "../services/git"
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

async function writeDeep(rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), content)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vsx-scm-"))
  await sh(["init", "-q", "-b", "main"])
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

// The cap renders up to MAX_RENDERED_GROUP_ROWS (200) rows plus a trailing
// "more" row; a viewport this tall keeps that row on-screen so `captureCharFrame`
// (which only shows the visible window) can see it. The default height (20) would
// cut off everything past the first ~16 rows.
const TALL = { width: 44, height: 220 }

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

// Row action buttons render only on the selected row; find a glyph's cell by
// scanning the frame for the first line that also contains `onLine`.
function cellOf(glyph: string, onLine: string): { x: number; y: number } {
  const lines = testSetup.captureCharFrame().split("\n")
  const y = lines.findIndex((l) => l.includes(onLine))
  if (y === -1)
    throw new Error(`no line containing "${onLine}"\n${lines.join("\n")}`)
  const x = lines[y].indexOf(glyph)
  if (x === -1) throw new Error(`no "${glyph}" on line: ${lines[y]}`)
  return { x, y }
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

  // The refresh is driven by FSEvents → watcher debounce → an out-of-band
  // git status(); that whole chain balloons under full-suite CPU load. Give the
  // bounded poll a generous deadline (it still returns the instant the row
  // lands) and the test explicit timeout headroom above that budget.
  await waitForText("external.txt", 8000)
  expect(testSetup.captureCharFrame()).toContain("external.txt")
}, 20000)

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

test("a bare untracked file creation triggers a watcher-driven refresh", async () => {
  await baseline()

  testSetup = await render()
  await waitForText("SOURCE CONTROL")
  await settle()
  expect(testSetup.captureCharFrame()).not.toContain("bare.txt")

  // Create an untracked file on disk with NO git operation — only the working
  // tree changes, so the refresh must come from the worktree watcher (not the
  // .git/index write that the "external git change" test above relies on).
  await write("bare.txt", "x\n")

  await waitForText("bare.txt")
  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Untracked Changes")
  expect(frame).toContain("bare.txt")
})

test("clicking the + button on a selected Changes row stages the file", async () => {
  await baseline()
  await write("tracked.txt", "two\n")

  testSetup = await render()
  await waitForText("tracked.txt")
  await settle()

  // Rows: [Changes header, tracked.txt]. Select the file so its buttons render.
  testSetup.mockInput.pressArrow("down")
  await settle()

  const { x, y } = cellOf("+", "tracked.txt")
  await testSetup.mockMouse.click(x, y)
  await waitForText("Staged Changes")

  const s = await statusNow()
  expect(s.staged.map((f) => f.path)).toContain("tracked.txt")
  expect(s.changes.map((f) => f.path)).not.toContain("tracked.txt")
})

test("clicking the discard button on a selected untracked row confirms, then trashes it", async () => {
  const moveToTrash = spyOn(trash, "moveToTrash").mockResolvedValue(undefined)
  await baseline()
  await write("untracked.txt", "u\n")

  testSetup = await render(undefined, WIDE)
  await waitForText("untracked.txt")
  await settle()

  // Rows: [Untracked header, untracked.txt]. Select the file, click discard.
  testSetup.mockInput.pressArrow("down")
  await settle()

  const { x, y } = cellOf("↶", "untracked.txt")
  await testSetup.mockMouse.click(x, y)
  await waitForText("DELETE 'untracked.txt'")

  testSetup.mockInput.pressEnter()
  await waitForTextGone("Move to Trash")

  expect(moveToTrash).toHaveBeenCalledTimes(1)
  expect(moveToTrash.mock.calls[0][0]).toEqual([
    join(realpathSync(root), "untracked.txt"),
  ])
})

test("clicking a row action button does not open a diff", async () => {
  await baseline()
  await write("tracked.txt", "two\n")

  const diffs: Array<{ path: string; kind: "staged" | "unstaged" }> = []
  testSetup = await render({
    onOpenDiff: (path, kind) => diffs.push({ path, kind }),
  })
  await waitForText("tracked.txt")
  await settle()

  testSetup.mockInput.pressArrow("down")
  await settle()

  // The file row's own onMouseDown opens a diff; the + button sits on that same
  // row but must not — stopPropagation keeps the row handler from also firing.
  const { x, y } = cellOf("+", "tracked.txt")
  await testSetup.mockMouse.click(x, y)
  await waitForText("Staged Changes")

  expect(diffs).toEqual([])
})

test("row action buttons render only on the selected row", async () => {
  await write("a.txt", "a1\n")
  await write("b.txt", "b1\n")
  await sh(["add", "-A"])
  await sh(["commit", "-q", "-m", "base"])
  await write("a.txt", "a2\n")
  await write("b.txt", "b2\n")

  testSetup = await render()
  await waitForText("a.txt")
  await settle()

  // Rows: [Changes header, a.txt, b.txt]. Select a.txt only.
  testSetup.mockInput.pressArrow("down")
  await settle()

  const lines = testSetup.captureCharFrame().split("\n")
  const aLine = lines.find((l) => l.includes("a.txt"))
  const bLine = lines.find((l) => l.includes("b.txt"))
  expect(aLine).toContain("↶")
  expect(bLine).not.toContain("↶")
})

// Leading-space count of a rendered line, used to assert tree indentation.
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

test("nested paths render as an expanded directory tree with indented leaves", async () => {
  await baseline()
  await writeDeep("src/app.ts", "x\n")
  await writeDeep("src/util/helper.ts", "y\n")

  testSetup = await render()
  await waitForText("helper.ts")
  await settle()

  const lines = testSetup.captureCharFrame().split("\n")
  const srcLine = lines.find((l) => l.includes("▾ src"))
  const utilLine = lines.find((l) => l.includes("▾ util"))
  const helperLine = lines.find((l) => l.includes("helper.ts"))

  // Default-expand-all: every level is visible at once, no interaction needed.
  expect(srcLine).toBeDefined()
  expect(utilLine).toBeDefined()
  expect(lines.some((l) => l.includes("app.ts"))).toBe(true)

  // Indentation deepens with tree depth.
  expect(indentOf(utilLine!)).toBeGreaterThan(indentOf(srcLine!))
  expect(indentOf(helperLine!)).toBeGreaterThan(indentOf(utilLine!))
})

test("collapsing a directory hides its descendants; expanding restores them", async () => {
  await baseline()
  await writeDeep("src/app.ts", "x\n")
  await writeDeep("src/util/helper.ts", "y\n")

  testSetup = await render()
  await waitForText("helper.ts")
  await settle()

  // Rows: [Untracked header, src, util, helper.ts, app.ts]. Select util.
  testSetup.mockInput.pressArrow("down")
  testSetup.mockInput.pressArrow("down")
  await settle()

  // Left collapses util in place — helper.ts (its only child) disappears while
  // the sibling app.ts, under the still-expanded src, stays visible.
  testSetup.mockInput.pressArrow("left")
  await waitForTextGone("helper.ts")
  expect(testSetup.captureCharFrame()).toContain("app.ts")

  // Right re-expands util — helper.ts returns.
  testSetup.mockInput.pressArrow("right")
  await waitForText("helper.ts")
})

test("left on a leaf jumps selection to its parent directory", async () => {
  await baseline()
  await writeDeep("src/util/helper.ts", "y\n")

  testSetup = await render()
  await waitForText("helper.ts")
  await settle()

  // Rows: [Untracked header, src, util, helper.ts]. Select the leaf.
  testSetup.mockInput.pressArrow("down")
  testSetup.mockInput.pressArrow("down")
  testSetup.mockInput.pressArrow("down")
  await settle()
  // The leaf is selected, so its action cluster renders on the helper.ts line.
  cellOf("↶", "helper.ts")

  // Left with no expanded dir under the cursor jumps to the parent (util); the
  // selection-only action cluster follows to the util row.
  testSetup.mockInput.pressArrow("left")
  await settle()
  const lines = testSetup.captureCharFrame().split("\n")
  const utilLine = lines.find((l) => l.includes("▾ util"))
  expect(utilLine).toContain("↶")
})

test("collapse state survives a watcher-driven refresh", async () => {
  await baseline()
  await writeDeep("src/util/helper.ts", "y\n")

  testSetup = await render()
  await waitForText("helper.ts")
  await settle()

  // Select util and collapse it.
  testSetup.mockInput.pressArrow("down")
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressArrow("left")
  await waitForTextGone("helper.ts")

  // An unrelated external change forces a full row rebuild.
  await write("other.txt", "o\n")
  await waitForText("other.txt")

  // Collapse state lives outside the rebuild path, so util stays collapsed.
  expect(testSetup.captureCharFrame()).not.toContain("helper.ts")
})

test("selection tracks the row by id across a refresh that inserts earlier rows", async () => {
  await baseline()
  await writeDeep("m/mid.txt", "x\n")

  testSetup = await render()
  await waitForText("mid.txt")
  await settle()

  // Rows: [Untracked header, dir m, mid.txt]. Select the deep leaf.
  testSetup.mockInput.pressArrow("down")
  testSetup.mockInput.pressArrow("down")
  await settle()
  // Confirm the leaf is selected (its action cluster is on the mid.txt line).
  cellOf("↶", "mid.txt")

  // Stage a new file externally: a Staged group appears ABOVE Untracked, so
  // every Untracked row shifts down. Position-based selection would now land on
  // a Staged row; id-based selection must stay on mid.txt.
  await write("new.txt", "n\n")
  await sh(["add", "new.txt"])
  await waitForText("Staged Changes")
  await settle()

  const lines = testSetup.captureCharFrame().split("\n")
  const midLine = lines.find((l) => l.includes("mid.txt"))
  const newLine = lines.find((l) => l.includes("new.txt"))
  expect(midLine).toContain("↶")
  expect(newLine).not.toContain("↶")
})

test("staging a directory row stages exactly its descendant files", async () => {
  await writeDeep("src/a.ts", "a1\n")
  await writeDeep("src/b.ts", "b1\n")
  await write("root.txt", "r1\n")
  await sh(["add", "-A"])
  await sh(["commit", "-q", "-m", "base"])
  await writeDeep("src/a.ts", "a2\n")
  await writeDeep("src/b.ts", "b2\n")
  await write("root.txt", "r2\n")

  testSetup = await render()
  await waitForText("root.txt")
  await settle()

  // Rows: [Changes header, dir src, a.ts, b.ts, root.txt]. Select src, stage it.
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressKey(" ")
  await waitForText("Staged Changes")

  const s = await statusNow()
  expect(new Set(s.staged.map((f) => f.path))).toEqual(
    new Set(["src/a.ts", "src/b.ts"]),
  )
  expect(s.changes.map((f) => f.path)).toContain("root.txt")
  expect(s.changes.map((f) => f.path)).not.toContain("src/a.ts")
})

test("discarding a directory row raises the existing multi-file confirm for its descendants", async () => {
  await writeDeep("src/a.ts", "a1\n")
  await writeDeep("src/b.ts", "b1\n")
  await sh(["add", "-A"])
  await sh(["commit", "-q", "-m", "base"])
  await writeDeep("src/a.ts", "a2\n")
  await writeDeep("src/b.ts", "b2\n")

  testSetup = await render(undefined, WIDE)
  await waitForText("a.ts")
  await settle()

  // Rows: [Changes header, dir src, a.ts, b.ts]. Discard the whole dir; its two
  // tracked descendants flow into the existing IRREVERSIBLE ladder.
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressKey("x")
  await waitForText("This is IRREVERSIBLE!")
  expect(testSetup.captureCharFrame()).toContain("Discard All 2 Files")
})

// A synthetic status with N untracked leaves under `prefix`. Rendering thousands
// of real files is slow and beside the point (the guard is on RENDER cost), so
// these scalability tests mock the panel's git status directly.
function untrackedStatus(count: number, prefix = ""): StatusResult {
  const untracked = Array.from({ length: count }, (_, i) => ({
    path: `${prefix}f${String(i).padStart(5, "0")}.txt`,
    statusLetter: "U" as const,
  }))
  return { mergeChanges: [], staged: [], changes: [], untracked }
}

test("caps a huge untracked group and renders it within a bounded time", async () => {
  spyOn(GitService.prototype, "status").mockResolvedValue(untrackedStatus(2000))

  const start = Date.now()
  testSetup = await render(undefined, TALL)
  await waitForText("Untracked Changes")
  const elapsed = Date.now() - start
  await settle()

  const frame = testSetup.captureCharFrame()
  // The header still reports the TRUE total even though only the cap is rendered.
  expect(frame).toContain("(2000)")
  // The overflow collapses into a single "more" row instead of 2000 Renderables.
  expect(frame).toContain("more files")
  // Unbounded rendering (~13ms/row) would blow past this; the cap keeps it fast.
  // eslint-disable-next-line no-console
  console.log(`[perf] 2000-file untracked render: ${elapsed}ms`)
  expect(elapsed).toBeLessThan(5000)
})

test("renders exactly the cap plus one more-row and nav can reach the more-row", async () => {
  // 500 flat files > MAX_RENDERED_GROUP_ROWS (200): 200 file rows are shown and
  // the rest fold into the more-row, so hiddenCount = 500 - 200 = 300.
  spyOn(GitService.prototype, "status").mockResolvedValue(untrackedStatus(500))

  testSetup = await render(undefined, TALL)
  await waitForText("more files")
  await settle()
  expect(testSetup.captureCharFrame()).toContain("(500)")
  expect(testSetup.captureCharFrame()).toContain("300 more files")

  // Rows: group header + 200 files + more-row. Driving selection off the end must
  // land on the informational more-row (last selectable row) without crashing.
  for (let i = 0; i < 260; i++) testSetup.mockInput.pressArrow("down")
  await settle()
  expect(testSetup.captureCharFrame()).toContain("more files")
})

test("a group past the collapse threshold renders collapsed to its top level", async () => {
  // 600 files, all under one dir → over COLLAPSE_THRESHOLD (500), so the dir is
  // collapsed by default and the tree shows only its top level.
  spyOn(GitService.prototype, "status").mockResolvedValue(untrackedStatus(600, "big/"))

  testSetup = await render(undefined, TALL)
  await waitForText("Untracked Changes")
  await settle()
  let frame = testSetup.captureCharFrame()
  expect(frame).toContain("(600)") // true total in the header
  expect(frame).toContain("▸ big") // collapsed twisty
  expect(frame).not.toContain("f00000.txt") // children hidden

  // Rows: [group header, dir big]. Select the dir and expand it; its children
  // now render (still capped, so a more-row appears).
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressArrow("right")
  await waitForText("f00000.txt")
  frame = testSetup.captureCharFrame()
  expect(frame).toContain("▾ big")
  expect(frame).toContain("more files")
})

test("a huge repo does not stop a small sibling repo from rendering", async () => {
  // Two real sibling repos under one workspace: one large (capped), one tiny.
  // The small repo's row must still render — pinning that a repo's status/tree is
  // built and memoized independently of its siblings.
  const ws = await mkdtemp(join(tmpdir(), "vsx-scm-multi-"))
  const gitIn = async (cwd: string, args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    await proc.exited
  }
  try {
    const giant = join(ws, "giant")
    const small = join(ws, "small")
    for (const dir of [giant, small]) {
      await mkdir(dir)
      await gitIn(dir, ["init", "-q", "-b", "main"])
    }
    await Promise.all(
      Array.from({ length: 210 }, (_, i) =>
        writeFile(join(giant, `f${String(i).padStart(4, "0")}.txt`), "x\n"),
      ),
    )
    await writeFile(join(small, "solo.txt"), "s\n")

    // A viewport tall enough to hold the capped giant section AND the small one.
    testSetup = await render({ workspaceRoot: ws }, { width: 60, height: 240 })
    await waitForText("solo.txt")
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("solo.txt") // small repo rendered
    expect(frame).toContain("more files") // giant repo capped, not frozen
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
