import type { RGBA, TextareaRenderable } from "@opentui/core"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { documentRegistry } from "../model/documents"
import { workbenchStore, type Group, type Tab } from "../model/workbench"
import * as clipboard from "../services/clipboard"
import { theme } from "../theme"
import { App } from "./App"
import { handleRendererSelection } from "./rendererSelection"
import { DEFAULT_SIDEBAR_WIDTH } from "./sidebarWidth"

// End-to-end wiring tests that render the REAL, fully-assembled <App> against a
// real fixture git repo and drive it exclusively through simulated keyboard
// input (never renderer.keyInput.emit — that bypasses KeyEvent semantics). Every
// bug this fix round addressed was invisible to component-in-isolation suites;
// these pin the assembled behaviour so the bug class can't silently return.
//
// kittyKeyboard is enabled only where a Ctrl+Shift+<letter> chord must be
// disambiguated from plain Ctrl+<letter> (a real terminal limitation) — every
// other test runs plain. Ctrl+PageUp/PageDown are simulated via legacy CSI
// sequences (the mock's KeyCodes has no page keys), which parse identically in
// both modes.

let root: string
let testSetup: Awaited<ReturnType<typeof testRender>>

// The mock's pressKey only knows a fixed KeyCodes set (no PageUp/PageDown), so
// send the legacy modified-CSI sequences directly; both encode name=page{up,down}.
function pressCtrlPageDown() {
  testSetup.mockInput.pressKey("\x1B[6~", { ctrl: true })
}
function pressCtrlPageUp() {
  testSetup.mockInput.pressKey("\x1B[5~", { ctrl: true })
}

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

async function settle(ms = 300) {
  await Bun.sleep(ms)
  await testSetup.renderOnce()
}

async function waitForText(text: string, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await testSetup.flush()
    if (testSetup.captureCharFrame().includes(text)) return
    await Bun.sleep(30)
  }
  throw new Error(`timed out waiting for "${text}"\n${testSetup.captureCharFrame()}`)
}

async function waitForTextGone(text: string, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await testSetup.flush()
    if (!testSetup.captureCharFrame().includes(text)) return
    await Bun.sleep(30)
  }
  throw new Error(`timed out waiting for "${text}" to disappear\n${testSetup.captureCharFrame()}`)
}

const HELLO = () => join(root, "hello.ts")
const SECOND = () => join(root, "second.ts")

function activeGroup(): Group {
  const state = workbenchStore.getState()
  return state.groups.find((g) => g.id === state.activeGroupId)!
}

function activeTabPath(): string | null {
  return activeGroup().activeTabPath
}

function tabFor(path: string): Tab | undefined {
  return activeGroup().tabs.find((t) => t.path === path)
}

// Boot focus is the Explorer. Reset the tree selection to the top (`.git` sorts
// first as a directory), step down to the target row, and Enter to open it —
// FileTree Enter and a single mouse click share the same preview-open path, so
// this faithfully drives "single-click" open semantics. Only valid while the
// sidebar holds focus (call focusExplorer() first if the editor stole it).
async function openFromTree(downFromTop: number, contentMarker: string) {
  for (let i = 0; i < 5; i++) testSetup.mockInput.pressArrow("up")
  await settle(60)
  for (let i = 0; i < downFromTop; i++) testSetup.mockInput.pressArrow("down")
  await settle(80)
  testSetup.mockInput.pressEnter()
  await waitForText(contentMarker)
}

async function openHelloFromTree() {
  await waitForText("hello.ts")
  await openFromTree(1, "greeting")
}

async function focusExplorer() {
  testSetup.mockInput.pressKey("e", { ctrl: true, shift: true })
  await settle(120)
}

// Open Source Control, select the sole modified file's group, press 'x' to raise
// the single-file discard prompt. Returns once the confirm prompt is on screen.
async function openDiscardDialog() {
  testSetup.mockInput.pressKey("g", { ctrl: true, shift: true })
  await waitForText("SOURCE CONTROL")
  await waitForText("hello.ts")
  testSetup.mockInput.pressKey("x")
  await waitForText("discard changes in 'hello.ts'")
}

/** Every editor textarea currently mounted (both split panes share the id). */
function editorTextareas(): { focused: boolean }[] {
  const out: { focused: boolean }[] = []
  const walk = (node: { id?: string; getChildren: () => unknown[] }) => {
    if (node.id === "editor-textarea") out.push(node as unknown as { focused: boolean })
    for (const child of node.getChildren()) walk(child as typeof node)
  }
  walk(testSetup.renderer.root as unknown as { getChildren: () => unknown[] })
  return out
}

/** Every mounted editor textarea as a full renderable, left-to-right by x. */
function editorTextareaNodes(): TextareaRenderable[] {
  const out: TextareaRenderable[] = []
  const walk = (node: { id?: string; getChildren: () => unknown[] }) => {
    if (node.id === "editor-textarea") out.push(node as unknown as TextareaRenderable)
    for (const child of node.getChildren()) walk(child as typeof node)
  }
  walk(testSetup.renderer.root as unknown as { getChildren: () => unknown[] })
  return out.sort((a, b) => a.x - b.x)
}

// "Ln <n>, Col <n>" shows only while the EDITOR area holds focus (App wires
// cursor reporting to editorFocused), so it is a focus proxy independent of the
// textarea-blur work.
function statusShowsCursor(): boolean {
  return /Ln \d+, Col \d+/.test(testSetup.captureCharFrame())
}

/** RGB triplet of a pane's border color, so accent-vs-neutral is easy to assert. */
function paneBorderRgb(groupId: string): [number, number, number] {
  let found: RGBA | undefined
  const walk = (node: { id?: string; borderColor?: RGBA; getChildren: () => unknown[] }) => {
    if (node.id === `editor-group-${groupId}`) found = node.borderColor
    for (const child of node.getChildren()) walk(child as typeof node)
  }
  walk(testSetup.renderer.root as unknown as { getChildren: () => unknown[] })
  if (!found) throw new Error(`no pane for group ${groupId}`)
  const [r, g, b] = found.toInts()
  return [r, g, b]
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vsx-app-int-"))
  await git(root, ["init", "-q"])
  await git(root, ["config", "user.email", "a@b.com"])
  await git(root, ["config", "user.name", "Test"])
  await writeFile(HELLO(), "const greeting = 'hi'\n")
  await writeFile(SECOND(), "const beta = 42\n")
  await git(root, ["add", "."])
  await git(root, ["commit", "-q", "-m", "initial"])
  workbenchStore.reset()
})

// Each test gets a UNIQUE tmpdir, so document-registry keys (absolute paths)
// never collide across tests — combined with the retainer's unmount cleanup
// fired by renderer.destroy(), documents from a prior test can never leak into
// the next one even though workbenchStore.reset() does not release documents.
afterEach(async () => {
  if (testSetup) testSetup.renderer.destroy()
  // Clear the shared renderer-selection cache between tests.
  handleRendererSelection({ getSelectedText: () => "" })
  await rm(root, { recursive: true, force: true })
})

async function boot({ width = 100, kittyKeyboard = false } = {}) {
  testSetup = await testRender(<App workspaceRoot={root} />, {
    width,
    height: 30,
    kittyKeyboard,
  })
  await settle()
}

// ── 1. C1: tab-switch data loss ────────────────────────────────────────────
test("C1: editing a file, switching away and back keeps the edit and dirty state (no disk reload)", async () => {
  await boot()
  await openHelloFromTree()

  await testSetup.mockInput.typeText("XYZ")
  await settle(150)
  const doc = documentRegistry.get(HELLO())
  expect(doc?.getText()).toContain("XYZ")
  expect(doc?.isDirty).toBe(true)

  // Open the OTHER file, then cycle back to the edited one.
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  await testSetup.mockInput.typeText("second")
  await settle(300)
  testSetup.mockInput.pressEnter()
  await waitForText("beta")
  expect(activeTabPath()).toContain("second.ts")

  pressCtrlPageUp()
  await settle(150)
  expect(activeTabPath()).toContain("hello.ts")

  // Same Document instance, edit preserved, still dirty — not reloaded from disk.
  const doc2 = documentRegistry.get(HELLO())
  expect(doc2).toBe(doc)
  expect(doc2?.getText()).toContain("XYZ")
  expect(doc2?.isDirty).toBe(true)
})

// ── 2. C2: preview promotion ───────────────────────────────────────────────
test("C2: a preview tab promotes on first edit, and a later single-click open makes a NEW preview tab", async () => {
  await boot({ kittyKeyboard: true })
  await openHelloFromTree()

  // Opened as a preview (italic in the tab strip).
  expect(tabFor(HELLO())?.preview).toBe(true)

  // A single typed character promotes it permanently.
  await testSetup.mockInput.typeText("z")
  await settle(150)
  expect(tabFor(HELLO())?.preview).toBe(false)

  // Single-click-open a DIFFERENT file: because hello is now permanent it can't
  // be reused as the preview slot, so a NEW preview tab appears alongside it.
  await focusExplorer()
  await openFromTree(2, "beta")

  expect(activeGroup().tabs).toHaveLength(2)
  expect(tabFor(HELLO())?.preview).toBe(false)
  expect(tabFor(SECOND())?.preview).toBe(true)
})

// ── 3. C3: focus restoration after Quick Open closes ───────────────────────
test("C3: closing Quick Open with Esc restores editor focus so subsequent typing reaches the document", async () => {
  await boot()
  await openHelloFromTree()

  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  testSetup.mockInput.pressEscape()
  await waitForTextGone("Go to file")
  // Let the overlay-close focus-restore effect run before typing, so keystrokes
  // don't race ahead of the imperative .focus() under load.
  await settle(150)

  await testSetup.mockInput.typeText("AAA")
  await settle(200)
  expect(documentRegistry.get(HELLO())?.getText()).toContain("AAA")
})

// ── 4. C4: tab commands wired (close + cycle) ──────────────────────────────
test("C4: Ctrl+PageDown cycles tabs and Ctrl+W closes the active tab", async () => {
  await boot({ kittyKeyboard: true })
  await openHelloFromTree()

  // Promote + save hello so it's a permanent, CLEAN tab (Ctrl+W won't prompt).
  await testSetup.mockInput.typeText("x")
  await settle(120)
  testSetup.mockInput.pressKey("s", { ctrl: true })
  await settle(200)
  expect(documentRegistry.get(HELLO())?.isDirty).toBe(false)

  // Second preview tab; two tabs total, second active.
  await focusExplorer()
  await openFromTree(2, "beta")
  expect(activeGroup().tabs).toHaveLength(2)
  expect(activeTabPath()).toContain("second.ts")

  // Cycle: next wraps second → hello, then hello → second.
  pressCtrlPageDown()
  await settle(120)
  expect(activeTabPath()).toContain("hello.ts")
  pressCtrlPageDown()
  await settle(120)
  expect(activeTabPath()).toContain("second.ts")

  // Close the active (clean) tab.
  testSetup.mockInput.pressKey("w", { ctrl: true })
  await settle(200)
  expect(activeGroup().tabs).toHaveLength(1)
  expect(activeTabPath()).toContain("hello.ts")
})

// ── 5a. Overlay capture: paste doesn't leak through Quick Open ──────────────
test("Overlay capture: Ctrl+V while Quick Open is open does not leak a paste into the editor underneath", async () => {
  const readSpy = spyOn(clipboard, "read").mockResolvedValue("LEAKED")
  try {
    await boot()
    await openHelloFromTree()

    testSetup.mockInput.pressKey("p", { ctrl: true })
    await waitForText("Go to file")
    testSetup.mockInput.pressKey("v", { ctrl: true })
    await settle(200)

    expect(documentRegistry.get(HELLO())?.getText()).not.toContain("LEAKED")
  } finally {
    readSpy.mockRestore()
  }
})

// ── 5b. Overlay capture: Enter doesn't fall through to the FileTree ─────────
test("Overlay capture: Enter while an overlay is open does not open the FileTree's selected row", async () => {
  await boot()
  await waitForText("hello.ts")

  // Select the hello.ts FILE row (sidebar still focused, nothing open yet).
  testSetup.mockInput.pressArrow("down")
  await settle(100)
  expect(activeTabPath()).toBeNull()

  // Quick Open over the focused Explorer; its empty MRU makes Enter a no-op AND
  // the tree (gated on the open overlay) must NOT open hello.ts underneath.
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  testSetup.mockInput.pressEnter()
  await settle(200)
  expect(activeTabPath()).toBeNull()
})

// ── 6. Path invariant: one tab + one Document across both open paths ────────
test("Path invariant: opening the same file via FileTree and Quick Open yields one tab and one Document", async () => {
  await boot()
  await openHelloFromTree()
  const doc1 = documentRegistry.get(HELLO())
  expect(activeGroup().tabs).toHaveLength(1)

  // Re-open the identical file through Quick Open; dedup must reuse the tab/doc.
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  await testSetup.mockInput.typeText("hello")
  await settle(300)
  testSetup.mockInput.pressEnter()
  await waitForTextGone("Go to file")
  await settle(150)

  expect(activeGroup().tabs).toHaveLength(1)
  const doc2 = documentRegistry.get(HELLO())
  expect(doc2).toBe(doc1)
})

// ── 7. Dirty-close guard: Save / Don't Save / Cancel ───────────────────────
async function openDirtyHelloThenCtrlW() {
  await openHelloFromTree()
  await testSetup.mockInput.typeText("DIRTY")
  await settle(150)
  expect(documentRegistry.get(HELLO())?.isDirty).toBe(true)
  testSetup.mockInput.pressKey("w", { ctrl: true })
  await waitForText("save the changes you made to hello.ts")
}

test("Dirty close (Save): persists the buffer to disk then closes the tab", async () => {
  await boot()
  await openDirtyHelloThenCtrlW()

  // "Save" is the default-highlighted button — Enter confirms it.
  testSetup.mockInput.pressEnter()
  await waitForTextGone("save the changes you made to hello.ts")

  const start = Date.now()
  while (Date.now() - start < 4000) {
    if ((await Bun.file(HELLO()).text()).includes("DIRTY")) break
    await testSetup.flush()
    await Bun.sleep(30)
  }
  expect(await Bun.file(HELLO()).text()).toContain("DIRTY")
  expect(activeGroup().tabs).toHaveLength(0)
})

test("Dirty close (Don't Save): discards the edit and closes the tab, leaving disk untouched", async () => {
  await boot()
  await openDirtyHelloThenCtrlW()

  // Move to "Don't Save" (index 1) and confirm.
  testSetup.mockInput.pressArrow("right")
  await settle(80)
  testSetup.mockInput.pressEnter()
  await waitForTextGone("save the changes you made to hello.ts")
  await settle(150)

  expect(activeGroup().tabs).toHaveLength(0)
  expect(await Bun.file(HELLO()).text()).toBe("const greeting = 'hi'\n")
})

test("Dirty close (Cancel): leaves the tab open with its edits intact", async () => {
  await boot()
  await openDirtyHelloThenCtrlW()

  // Move to "Cancel" (index 2) and confirm.
  testSetup.mockInput.pressArrow("right")
  testSetup.mockInput.pressArrow("right")
  await settle(80)
  testSetup.mockInput.pressEnter()
  await waitForTextGone("save the changes you made to hello.ts")
  await settle(150)

  expect(activeGroup().tabs).toHaveLength(1)
  expect(activeTabPath()).toContain("hello.ts")
  const doc = documentRegistry.get(HELLO())
  expect(doc?.isDirty).toBe(true)
  expect(doc?.getText()).toContain("DIRTY")
})

// ── 8. Modal placement: discard dialog spans past the sidebar column ───────
test("Modal placement: the SCM discard dialog renders wider than the sidebar", async () => {
  await writeFile(HELLO(), "const greeting = 'changed'\n")
  await boot({ kittyKeyboard: true })
  await openDiscardDialog()

  // The full prompt line cannot fit unwrapped inside the sidebar's usable columns,
  // so an end column past the sidebar width proves the dialog escaped the sidebar
  // (the original bug trapped it inside the sidebar box). Tied to the real default
  // width so it stays honest now that the sidebar is drag-resizable (task #38).
  const line = testSetup
    .captureCharFrame()
    .split("\n")
    .find((l) => l.includes("discard changes in 'hello.ts'"))
  expect(line).toBeDefined()
  const marker = "discard changes in 'hello.ts'"
  const endCol = line!.indexOf(marker) + marker.length
  expect(endCol).toBeGreaterThan(DEFAULT_SIDEBAR_WIDTH)
})

// ── 8b. Overlay exclusivity: no command dispatch / stacking under an overlay ─
test("Overlay exclusivity: Ctrl+W while Quick Open is open neither closes the tab nor stacks a dialog", async () => {
  await boot()
  await openHelloFromTree()
  await testSetup.mockInput.typeText("DIRTY")
  await settle(150)
  expect(documentRegistry.get(HELLO())?.isDirty).toBe(true)

  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")

  // Ctrl+W would normally raise the dirty-close prompt; gated under the overlay it
  // must be a silent no-op — no dialog stacks on top and the tab stays open.
  testSetup.mockInput.pressKey("w", { ctrl: true })
  await settle(200)

  expect(testSetup.captureCharFrame()).not.toContain("save the changes you made to hello.ts")
  expect(activeGroup().tabs).toHaveLength(1)
  expect(testSetup.captureCharFrame()).toContain("Go to file")
})

test("Overlay exclusivity: after a suppressed Ctrl+W, one Enter runs only the Quick Open accept", async () => {
  await boot()
  await openHelloFromTree()
  await testSetup.mockInput.typeText("DIRTY")
  await settle(150)

  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  testSetup.mockInput.pressKey("w", { ctrl: true })
  await settle(200)

  // The stacked-dialog bug let one Enter fire BOTH the dialog's default "Save" AND
  // the Quick Open accept. With dispatch gated, a single Enter must only open the
  // queried file — hello's dirty buffer is never saved to disk underneath.
  await testSetup.mockInput.typeText("second")
  await settle(300)
  testSetup.mockInput.pressEnter()
  await waitForText("beta")

  expect(activeTabPath()).toContain("second.ts")
  expect(documentRegistry.get(HELLO())?.isDirty).toBe(true)
  expect(await Bun.file(HELLO()).text()).toBe("const greeting = 'hi'\n")
})

test("Overlay exclusivity: Ctrl+P while a confirm dialog is open does not open a second overlay", async () => {
  await boot()
  await openHelloFromTree()
  await testSetup.mockInput.typeText("DIRTY")
  await settle(150)
  testSetup.mockInput.pressKey("w", { ctrl: true })
  await waitForText("save the changes you made to hello.ts")

  // The confirm dialog owns the screen; Ctrl+P (Quick Open) must be gated out so
  // Quick Open never mounts underneath/over it.
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await settle(200)

  expect(testSetup.captureCharFrame()).not.toContain("Go to file")
  expect(testSetup.captureCharFrame()).toContain("save the changes you made to hello.ts")
})

// ── 8c. Split save: Ctrl+S targets the FOCUSED pane, and survives its teardown ─
async function waitForClean(path: () => string) {
  const start = Date.now()
  while (Date.now() - start < 4000) {
    if (!documentRegistry.get(path())?.isDirty) return
    await testSetup.flush()
    await Bun.sleep(30)
  }
  throw new Error(`timed out waiting for ${path()} to become clean`)
}

test("Split save: Ctrl+S saves only the focused pane's file, and the command survives closing that pane", async () => {
  await boot({ width: 120, kittyKeyboard: true })
  await openHelloFromTree()

  // Split, then make the new (focused) group hold ONLY second.ts: open it, then
  // close the cloned hello tab that splitGroup carried over.
  testSetup.mockInput.pressKey("\\", { ctrl: true })
  await settle(150)
  expect(workbenchStore.getState().groups).toHaveLength(2)

  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  await testSetup.mockInput.typeText("second")
  await settle(300)
  testSetup.mockInput.pressEnter()
  await waitForText("beta")
  await settle(150)

  pressCtrlPageUp() // activate the cloned (still clean) hello tab in group 2
  await settle(120)
  expect(activeTabPath()).toContain("hello.ts")
  testSetup.mockInput.pressKey("w", { ctrl: true }) // close it (clean, no prompt)
  await settle(200)
  expect(activeGroup().tabs).toHaveLength(1)
  expect(activeTabPath()).toContain("second.ts")

  // Edit BOTH panes: second (pane 2, currently focused) then hello (pane 1).
  await testSetup.mockInput.typeText("PANE2")
  await settle(150)
  testSetup.mockInput.pressKey("1", { ctrl: true })
  await settle(120)
  await testSetup.mockInput.typeText("PANE1")
  await settle(150)

  const hello = documentRegistry.get(HELLO())
  const second = documentRegistry.get(SECOND())
  expect(hello?.isDirty).toBe(true)
  expect(second?.isDirty).toBe(true)

  // Focus pane 2 and save: only second.ts is written; hello.ts stays dirty on disk.
  testSetup.mockInput.pressKey("2", { ctrl: true })
  await settle(120)
  testSetup.mockInput.pressKey("s", { ctrl: true })
  await waitForClean(SECOND)
  expect(await Bun.file(SECOND()).text()).toContain("PANE2")
  expect(hello?.isDirty).toBe(true)
  expect(await Bun.file(HELLO()).text()).toBe("const greeting = 'hi'\n")

  // Close pane 2 (its saved-clean tab closes without a prompt); the split
  // collapses back to the single group showing the still-dirty hello.
  testSetup.mockInput.pressKey("w", { ctrl: true })
  await settle(200)
  expect(workbenchStore.getState().groups).toHaveLength(1)
  expect(activeTabPath()).toContain("hello.ts")

  // The command survives the pane teardown: the palette still lists "Save"...
  testSetup.mockInput.pressKey("p", { ctrl: true, shift: true })
  await waitForText("Show All Commands")
  await waitForText("Save")
  testSetup.mockInput.pressEscape()
  await waitForTextGone("Show All Commands")
  await settle(150)

  // ...and Ctrl+S now saves the surviving pane's file (hello.ts → PANE1 on disk).
  testSetup.mockInput.pressKey("s", { ctrl: true })
  await waitForClean(HELLO)
  expect(await Bun.file(HELLO()).text()).toContain("PANE1")
})

// ── 9b. Go-to-line: Quick Open ":line[:col]" drives the real editor cursor ──
const BIG = () => join(root, "big.ts")

// 120 numbered lines, NO trailing newline so the buffer's line count is exactly
// 120 — makes the ":9999" clamp target deterministic. Each line is long enough
// that column 7 is a valid interior position.
function bigContent(): string {
  return Array.from({ length: 120 }, (_, i) => `const line${i + 1} = ${i + 1}`).join("\n")
}

// Write an untracked 120-line file (git ls-files --others enumerates it) and open
// it through Quick Open so the whole real path — parse → onGotoLine → editor — runs.
async function openBig() {
  await writeFile(BIG(), bigContent())
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  await testSetup.mockInput.typeText("big")
  await settle(300)
  testSetup.mockInput.pressEnter()
  await waitForText("const line1 = 1")
}

async function quickGoto(query: string) {
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  await testSetup.mockInput.typeText(query)
  await settle(150)
  testSetup.mockInput.pressEnter()
  await waitForTextGone("Go to file")
  // Let the overlay-close focus-restore effect run before typing (see C3).
  await settle(150)
}

test("Go to line: ':42' moves the cursor to line 42, focuses the editor, and inserts there", async () => {
  await boot()
  await openBig()

  await quickGoto(":42")
  await waitForText("Ln 42")

  // Focus landed in the editor: subsequent typing reaches the document AT line 42
  // (proves both the cursor move and that focus returned to the buffer, not Quick Open).
  await testSetup.mockInput.typeText("ZZZ")
  await settle(200)
  const lines = documentRegistry.get(BIG())!.getText().split("\n")
  expect(lines[41]).toBe("ZZZconst line42 = 42")
  expect(statusShowsCursor()).toBe(true)
})

test("Go to line: ':9999' clamps to the last line", async () => {
  await boot()
  await openBig()

  await quickGoto(":9999")
  await waitForText("Ln 120")
})

test("Go to line: ':42:7' sets both line and column", async () => {
  await boot()
  await openBig()

  await quickGoto(":42:7")
  await waitForText("Ln 42, Col 7")
})

// ── 9c. Cursor reporting: vertical nav, undo, and diff tabs ─────────────────
// Vertical arrows route through editorView.moveUp/DownVisual (the view pointer),
// which — unlike the horizontal editBuffer moves — emits NO native cursor-changed
// event. Without the keyboard-driven re-report, the status bar's Ln/Col sticks
// while the caret visibly moves. These pin the assembled behaviour.

test("Cursor report: Down/Up arrows keep the status bar Ln/Col live (no native cursor event on the view path)", async () => {
  await boot()
  await openBig()

  // Land the caret at the top AND move workbench focus into the editor (a plain
  // Quick Open file-open leaves focus on the sidebar; go-to-line focuses the editor).
  await quickGoto(":1")
  await waitForText("Ln 1, Col 1")

  // Down ALONE must advance the line: this is the exact key the native path drops.
  testSetup.mockInput.pressArrow("down")
  await waitForText("Ln 2, Col 1")
  expect(testSetup.captureCharFrame()).not.toContain("Ln 1, Col 1")

  // Horizontal move still reports (native path) — combined position stays honest.
  testSetup.mockInput.pressArrow("right")
  await waitForText("Ln 2, Col 2")

  // A second vertical move (ending on Down) must also update, not freeze at Col 2/Ln 2.
  testSetup.mockInput.pressArrow("down")
  await waitForText("Ln 3, Col 2")

  // ...and Up walks it back.
  testSetup.mockInput.pressArrow("up")
  await waitForText("Ln 2, Col 2")
})

test("Cursor report: undo repositions the caret and the status bar reports the new line", async () => {
  await boot()
  await openBig()

  await quickGoto(":42")
  await waitForText("Ln 42")

  // Insert one char at line 42 (a single, cleanly-revertible undo unit), then walk
  // the caret up to line 40 so undo has to move it back down.
  await testSetup.mockInput.typeText("Z")
  await settle(150)
  expect(documentRegistry.get(BIG())!.getText().split("\n")[41]).toBe("Zconst line42 = 42")

  testSetup.mockInput.pressArrow("up")
  testSetup.mockInput.pressArrow("up")
  await waitForText("Ln 40")

  // Undo reverts the insert AND jumps the caret back to line 42; the bar follows.
  testSetup.mockInput.pressKey("z", { ctrl: true })
  await waitForText("Ln 42")
  expect(documentRegistry.get(BIG())!.getText().split("\n")[41]).toBe("const line42 = 42")
})

test("Cursor report: a diff tab shows no Ln/Col, and switching back to a file tab restores it", async () => {
  await boot()
  await openHelloFromTree()
  // Promote hello to a permanent file tab so the diff opens as a SEPARATE tab.
  await testSetup.mockInput.typeText("x")
  await settle(150)
  await waitForText("Ln 1")
  expect(statusShowsCursor()).toBe(true)

  // Open an unstaged diff for the same file: the active tab now has no cursor.
  await writeFile(HELLO(), "const greeting = 'changed'\n")
  workbenchStore.openDiff(HELLO(), "unstaged", root, { preview: true })
  await settle(150)
  expect(tabFor(activeTabPath()!)?.kind).toBe("diff")
  expect(statusShowsCursor()).toBe(false)

  // Switch back to the file tab: the Ln/Col segment reappears for the remounted editor.
  pressCtrlPageDown()
  await settle(150)
  expect(activeTabPath()).toContain("hello.ts")
  await waitForText("Ln 1, Col 1")
  expect(statusShowsCursor()).toBe(true)
})

// ── 9. Sidebar focus blur ──────────────────────────────────────────────────
test("Sidebar focus blur: Ctrl+Shift+E blurs the editor so typing/arrows never reach the document", async () => {
  await boot({ kittyKeyboard: true })
  await openHelloFromTree()

  const doc = documentRegistry.get(HELLO())
  const original = doc!.getText()

  await focusExplorer()

  await testSetup.mockInput.typeText("ZZZ")
  testSetup.mockInput.pressArrow("down")
  testSetup.mockInput.pressArrow("up")
  await settle(200)
  expect(doc?.getText()).toBe(original)
  expect(statusShowsCursor()).toBe(false)

  // Esc returns focus to the editor; the same typing now lands in the document.
  testSetup.mockInput.pressEscape()
  await settle(150)
  await testSetup.mockInput.typeText("BBB")
  await settle(200)
  expect(doc?.getText()).toContain("BBB")
  expect(statusShowsCursor()).toBe(true)
})

// ── 10. Unified focus: group-focus commands redirect keyboard from the sidebar ─
// The core bug this round fixed: from sidebar focus, in a split, Ctrl+<n> switched
// the active group but keystrokes still went to the sidebar (focusArea was App-
// local and the command couldn't reach it). Now focusArea lives in the store so
// the command flips it, the pane shows an accent border, and typing lands there.
test("Unified focus: from the sidebar, Ctrl+2 focuses group 2's pane and typing lands in its document", async () => {
  await boot({ width: 140, kittyKeyboard: true })
  await openHelloFromTree() // hello.ts in group 1, editor focused

  // Split, then make the new (active) group 2 show second.ts so the two panes hold
  // DIFFERENT documents — proving keystrokes reach group 2 specifically.
  testSetup.mockInput.pressKey("\\", { ctrl: true })
  await settle(150)
  expect(workbenchStore.getState().groups).toHaveLength(2)
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  await testSetup.mockInput.typeText("second")
  await settle(300)
  testSetup.mockInput.pressEnter()
  await waitForText("beta")
  await settle(150)

  // Move workbench focus onto the sidebar: neither pane is focused now.
  await focusExplorer()
  expect(editorTextareas().filter((t) => t.focused)).toHaveLength(0)
  expect(statusShowsCursor()).toBe(false)

  const [g1, g2] = workbenchStore.getState().groups
  const helloBefore = documentRegistry.get(HELLO())!.getText()

  // Ctrl+2 from the sidebar: group 2 becomes the focused editor group.
  testSetup.mockInput.pressKey("2", { ctrl: true })
  await settle(150)
  expect(workbenchStore.getState().activeGroupId).toBe(g2.id)

  // Exactly the right pane is focused and shows the accent border; the left stays neutral.
  const focused = editorTextareas()
  expect(focused.filter((t) => t.focused)).toHaveLength(1)
  expect(focused[1].focused).toBe(true)
  expect(paneBorderRgb(g2.id)).toEqual(hexRgb(theme.accent))
  expect(paneBorderRgb(g1.id)).toEqual(hexRgb(theme.border))

  // Typing now lands in group 2's document (second.ts), NOT the sidebar and NOT hello.
  await testSetup.mockInput.typeText("ZZZ")
  await settle(200)
  expect(documentRegistry.get(SECOND())?.getText()).toContain("ZZZ")
  expect(documentRegistry.get(HELLO())?.getText()).toBe(helloBefore)
  expect(statusShowsCursor()).toBe(true)
})

test("Unified focus: clicking a pane body from the sidebar moves keyboard focus into that pane", async () => {
  await boot({ kittyKeyboard: true })
  await openHelloFromTree()

  await focusExplorer()
  expect(statusShowsCursor()).toBe(false)
  const doc = documentRegistry.get(HELLO())!

  // Click into the editor pane body (well past the sidebar column, below the tab
  // strip). This must both focus the group and take editor keyboard focus.
  await testSetup.mockMouse.click(DEFAULT_SIDEBAR_WIDTH + 20, 8)
  await testSetup.flush()
  await settle(150)

  expect(statusShowsCursor()).toBe(true)
  await testSetup.mockInput.typeText("CLK")
  await settle(200)
  expect(doc.getText()).toContain("CLK")
})

test("Click-to-position: clicking a non-focused split pane places the caret there and focuses it", async () => {
  await boot({ width: 140 })
  await openHelloFromTree() // hello.ts in group 1, editor focused

  // Split, then show second.ts in the new (active) group 2 so the panes differ.
  testSetup.mockInput.pressKey("\\", { ctrl: true })
  await settle(150)
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  await testSetup.mockInput.typeText("second")
  await settle(300)
  testSetup.mockInput.pressEnter()
  await waitForText("beta")
  await settle(150)

  const [g1, g2] = workbenchStore.getState().groups
  expect(workbenchStore.getState().activeGroupId).toBe(g2.id)

  // The left pane (group 1, hello.ts) is NOT focused. Click into it at a known cell.
  const left = editorTextareaNodes()[0]
  await testSetup.mockMouse.click(left.x + 6, left.y + 0) // col 6 = 'g' of "greeting"
  await testSetup.flush()
  await settle(150)

  // Caret landed at the clicked cell in group 1's textarea, and focus moved there
  // (building on #49's pane-click-to-focus).
  expect(left.editorView.getCursor()).toEqual({ row: 0, col: 6 })
  expect(workbenchStore.getState().activeGroupId).toBe(g1.id)

  // Typing now lands in hello.ts at the clicked position, not in second.ts.
  await testSetup.mockInput.typeText("Z")
  await settle(150)
  expect(documentRegistry.get(HELLO())?.getText()).toBe("const Zgreeting = 'hi'\n")
  expect(documentRegistry.get(SECOND())?.getText()).toBe("const beta = 42\n")
})

test("Unified focus: opening a file via Quick Open from the sidebar ends with editor focus", async () => {
  await boot()
  await waitForText("hello.ts") // boots on the Explorer (sidebar focused)
  expect(statusShowsCursor()).toBe(false)

  // Plain Quick Open file-open (no go-to-line): previously left focus on the sidebar.
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  await testSetup.mockInput.typeText("hello")
  await settle(300)
  testSetup.mockInput.pressEnter()
  await waitForTextGone("Go to file")
  await settle(150)

  // Focus landed in the editor: the cursor shows and typing reaches the document.
  expect(statusShowsCursor()).toBe(true)
  await testSetup.mockInput.typeText("QQQ")
  await settle(200)
  expect(documentRegistry.get(HELLO())?.getText()).toContain("QQQ")
})

// ── 11. Copy-on-select: renderer selections reach the clipboard ─────────────
// The renderer's mouse-selection system covers non-textarea surfaces (here the
// too-large-file preview). App subscribes to its `selection` event and, on
// mouse-up, copies the finished selection — the only way these surfaces can be
// copied at all (they have no edit buffer for the Ctrl+C path to read).

const HUGE = () => join(root, "huge.ts")

// 6 MB (> MAX_FILE_SIZE) so the pane shows the plain-text preview. A distinctive
// first line makes the selected text easy to locate and assert on.
async function openHugePreview() {
  await writeFile(HUGE(), `SELECTME_TOKEN\n${"A".repeat(6 * 1024 * 1024)}`)
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  await testSetup.mockInput.typeText("huge")
  await settle(300)
  testSetup.mockInput.pressEnter()
  await waitForText("SELECTME_TOKEN")
}

/** Screen row/col of a marker in the current frame, or throws if absent. */
function locate(marker: string): { x: number; y: number } {
  const lines = testSetup.captureCharFrame().split("\n")
  const y = lines.findIndex((l) => l.includes(marker))
  if (y === -1) throw new Error(`"${marker}" not on screen\n${lines.join("\n")}`)
  return { x: lines[y].indexOf(marker), y }
}

test("Copy-on-select: dragging over the too-large-file preview copies the selection", async () => {
  const writeSpy = spyOn(clipboard, "write").mockResolvedValue(undefined)
  try {
    await boot()
    await openHugePreview()

    // Drag across the distinctive first preview line; mouse-up fires the
    // renderer's `selection` event, which App copies to the clipboard.
    const { x, y } = locate("SELECTME_TOKEN")
    await testSetup.mockMouse.drag(x, y, x + "SELECTME_TOKEN".length, y)
    await settle(120)

    expect(writeSpy).toHaveBeenCalled()
    expect(writeSpy.mock.calls.some((c) => String(c[0]).includes("SELECT"))).toBe(true)
  } finally {
    writeSpy.mockRestore()
  }
})

test("Copy-on-select: dragging over a diff pane's content copies the selection", async () => {
  const writeSpy = spyOn(clipboard, "write").mockResolvedValue(undefined)
  try {
    await writeFile(HELLO(), "const greeting = 'changed'\n")
    await boot({ width: 140 })
    // Open the unstaged diff directly; its rendered body carries the code text
    // via inner (selectable-by-default) code renderables. "greeting" renders in
    // full on the left (old) side of the split, so it's a stable drag target.
    workbenchStore.openDiff(HELLO(), "unstaged", root, { preview: true })
    await waitForText("greeting")

    const { x, y } = locate("greeting")
    await testSetup.mockMouse.drag(x, y, x + "greeting".length, y)
    await settle(120)

    expect(writeSpy).toHaveBeenCalled()
    expect(writeSpy.mock.calls.some((c) => String(c[0]).length > 0)).toBe(true)
  } finally {
    writeSpy.mockRestore()
  }
})
