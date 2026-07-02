import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { documentRegistry } from "../model/documents"
import { workbenchStore } from "../model/workbench"
import * as clipboard from "../services/clipboard"
import { App } from "./App"

let root: string
let testSetup: Awaited<ReturnType<typeof testRender>>

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

async function settle(setup: typeof testSetup, ms = 400) {
  await Bun.sleep(ms)
  await setup.renderOnce()
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

// Open Source Control, select the sole modified file's group, and press 'x' to
// raise the discard dialog. Returns once the confirm prompt is on screen.
async function openDiscardDialog() {
  testSetup.mockInput.pressKey("g", { ctrl: true, shift: true })
  await waitForText("SOURCE CONTROL")
  await waitForText("hello.ts")
  // First selectable row is the "Changes" group (one file); 'x' discards it,
  // which for a single-file group renders the single-file discard prompt.
  testSetup.mockInput.pressKey("x")
  await waitForText("discard changes in 'hello.ts'")
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vsx-app-"))
  await git(root, ["init", "-q"])
  await git(root, ["config", "user.email", "a@b.com"])
  await git(root, ["config", "user.name", "Test"])
  await writeFile(join(root, "hello.ts"), "const greeting = 'hi'\n")
  await git(root, ["add", "."])
  await git(root, ["commit", "-q", "-m", "initial"])
  workbenchStore.reset()
})

afterEach(async () => {
  if (testSetup) testSetup.renderer.destroy()
  await rm(root, { recursive: true, force: true })
})

test("boots into the Explorer with an empty editor and status bar showing the branch", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("hello.ts")
  expect(frame).toContain("No file open")
  expect(frame).toMatch(/main|master/)
})

test("Ctrl+P opens Quick Open, and accepting a file opens it in the editor", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)

  testSetup.mockInput.pressKey("p", { ctrl: true })
  await settle(testSetup, 150)
  expect(testSetup.captureCharFrame()).toContain("Go to file")

  // An empty query shows the (empty, on a fresh session) recently-opened MRU
  // list, not the full file list — type part of the filename to search it,
  // same as a real user would.
  await testSetup.mockInput.typeText("hello")
  await settle(testSetup, 300)

  testSetup.mockInput.pressEnter()
  await settle(testSetup)

  const state = workbenchStore.getState()
  const group = state.groups.find((g) => g.id === state.activeGroupId)
  expect(group?.activeTabPath ?? "").toContain("hello.ts")
})

test("opening a file directly through the model reflects its content in the editor pane", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)

  workbenchStore.openFile(join(root, "hello.ts"), { preview: true })
  await settle(testSetup)

  expect(testSetup.captureCharFrame()).toContain("greeting")

  const doc = documentRegistry.get(join(root, "hello.ts"))
  expect(doc?.language).toBe("typescript")
})

test("an external edit to an open, clean file reloads the buffer in the editor", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)

  // Open the file (clean, no unsaved edits) so its document is registered.
  workbenchStore.openFile(join(root, "hello.ts"), { preview: true })
  await waitForText("greeting")

  // Another editor/script rewrites the file on disk; the workspace watcher must
  // pick it up and reload the open clean buffer.
  await writeFile(join(root, "hello.ts"), "const greeting = 'from-outside'\n")
  await waitForText("from-outside")

  const doc = documentRegistry.get(join(root, "hello.ts"))
  expect(doc?.getText()).toContain("from-outside")
})

test("Ctrl+Shift+G switches the sidebar to Source Control", async () => {
  // Ctrl+Shift+<letter> is only disambiguable from plain Ctrl+<letter> on a
  // kitty-keyboard-capable terminal — the same accommodation QuickInput's own
  // Ctrl+Shift+P test needs. This is a real, documented terminal limitation,
  // not a workaround for a bug.
  testSetup = await testRender(<App workspaceRoot={root} />, {
    width: 100,
    height: 30,
    kittyKeyboard: true,
  })
  await settle(testSetup)

  testSetup.mockInput.pressKey("g", { ctrl: true, shift: true })
  await settle(testSetup)

  expect(testSetup.captureCharFrame()).toContain("SOURCE CONTROL")
})

test("discard confirmation renders across the full viewport, not just the 32-col sidebar", async () => {
  await writeFile(join(root, "hello.ts"), "const greeting = 'changed'\n")
  testSetup = await testRender(<App workspaceRoot={root} />, {
    width: 100,
    height: 30,
    kittyKeyboard: true,
  })
  await settle(testSetup)

  await openDiscardDialog()

  // The whole prompt line "…discard changes in 'hello.ts'?" is ~57 chars — it
  // could not fit unwrapped inside the ~26 usable sidebar columns, so its mere
  // presence on one line plus an end column well past 32 proves the dialog now
  // spans the full viewport rather than the sidebar it was raised from.
  const line = testSetup
    .captureCharFrame()
    .split("\n")
    .find((l) => l.includes("discard changes in 'hello.ts'"))
  expect(line).toBeDefined()
  const marker = "discard changes in 'hello.ts'"
  const endCol = line!.indexOf(marker) + marker.length
  expect(endCol).toBeGreaterThan(32)
})

test("confirming a discard through the root modal reverts the file", async () => {
  await writeFile(join(root, "hello.ts"), "const greeting = 'changed'\n")
  testSetup = await testRender(<App workspaceRoot={root} />, {
    width: 100,
    height: 30,
    kittyKeyboard: true,
  })
  await settle(testSetup)

  await openDiscardDialog()

  // Default button is "Discard File"; Enter confirms it.
  testSetup.mockInput.pressEnter()
  await waitForTextGone("discard changes in 'hello.ts'")

  const start = Date.now()
  while (Date.now() - start < 4000) {
    if ((await Bun.file(join(root, "hello.ts")).text()) === "const greeting = 'hi'\n") break
    await testSetup.flush()
    await Bun.sleep(30)
  }
  expect(await Bun.file(join(root, "hello.ts")).text()).toBe("const greeting = 'hi'\n")
})

test("cancelling a discard through the root modal leaves the file untouched", async () => {
  await writeFile(join(root, "hello.ts"), "const greeting = 'changed'\n")
  testSetup = await testRender(<App workspaceRoot={root} />, {
    width: 100,
    height: 30,
    kittyKeyboard: true,
  })
  await settle(testSetup)

  await openDiscardDialog()

  testSetup.mockInput.pressEscape()
  await waitForTextGone("discard changes in 'hello.ts'")

  expect(await Bun.file(join(root, "hello.ts")).text()).toBe("const greeting = 'changed'\n")
})

function activeTabPath(): string | null {
  const state = workbenchStore.getState()
  return state.groups.find((g) => g.id === state.activeGroupId)?.activeTabPath ?? null
}

// Boot has the Explorer focused. Move selection to hello.ts (the `.git` dir sorts
// ahead of it) and press Enter, which opens it and moves logical focus into the
// editor (App.openFile sets focusArea = "editor").
async function openHelloFromTree() {
  await waitForText("hello.ts")
  testSetup.mockInput.pressArrow("down")
  await settle(testSetup, 100)
  testSetup.mockInput.pressEnter()
  await waitForText("greeting")
}

test("closing Quick Open with Esc restores editor focus so typing lands in the editor again", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)
  await openHelloFromTree()

  // Quick Open steals native focus from the textarea while it is open.
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  testSetup.mockInput.pressEscape()
  await waitForTextGone("Go to file")
  // The imperative focus-restore runs in an effect on the overlay-close epoch;
  // settle so it lands before we type, otherwise the keystrokes can race ahead of
  // the .focus() under heavy load and be dropped.
  await settle(testSetup, 150)

  // The regression (C3): before the imperative focus restore, native focus stayed
  // null after the overlay closed and this typing went nowhere.
  await testSetup.mockInput.typeText("ZZZ")
  await settle(testSetup, 200)

  const doc = documentRegistry.get(join(root, "hello.ts"))
  expect(doc?.getText()).toContain("ZZZ")
})

test("Ctrl+V while Quick Open is open does not leak a paste into the editor underneath", async () => {
  const readSpy = spyOn(clipboard, "read").mockResolvedValue("LEAKED")
  try {
    testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
    await settle(testSetup)
    await openHelloFromTree()

    testSetup.mockInput.pressKey("p", { ctrl: true })
    await waitForText("Go to file")

    testSetup.mockInput.pressKey("v", { ctrl: true })
    await settle(testSetup, 200)

    const doc = documentRegistry.get(join(root, "hello.ts"))
    expect(doc?.getText()).not.toContain("LEAKED")
  } finally {
    readSpy.mockRestore()
  }
})

test("Enter while an overlay is open does not open the FileTree's selected row", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)
  await waitForText("hello.ts")

  // Select the hello.ts FILE row (the `.git` dir sorts first) so that an ungated
  // FileTree Enter WOULD open it — the gate is what must stop that.
  testSetup.mockInput.pressArrow("down")
  await settle(testSetup, 100)
  expect(activeTabPath()).toBeNull()

  // Quick Open opens over the still-"focused" Explorer; its empty MRU has no
  // result to accept, so Enter must be a no-op AND the tree (gated on the open
  // overlay) must NOT open its selected hello.ts row underneath.
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  testSetup.mockInput.pressEnter()
  await settle(testSetup, 200)

  expect(activeTabPath()).toBeNull()
})

// The status bar shows "Ln <n>, Col <n>" only while the EDITOR area holds focus
// (App wires cursor reporting to editorFocused), so its presence is a proxy for
// focusArea === "editor" that is independent of the textarea-blur work.
function statusShowsCursor(): boolean {
  return /Ln \d+, Col \d+/.test(testSetup.captureCharFrame())
}

test("Esc that closes Quick Open does not flip sidebar focus into the editor", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)
  await waitForText("hello.ts")

  // Load a document (opening a file now takes editor focus), then return logical
  // focus to the sidebar — the "sidebar focused with a doc already loaded" state.
  workbenchStore.openFile(join(root, "hello.ts"), { preview: true })
  workbenchStore.setFocusArea("sidebar")
  await settle(testSetup)
  expect(statusShowsCursor()).toBe(false)

  testSetup.mockInput.pressKey("p", { ctrl: true })
  await waitForText("Go to file")
  testSetup.mockInput.pressEscape()
  await waitForTextGone("Go to file")
  await settle(testSetup, 150)

  // Before the fix, App's Esc handler flipped sidebar→editor on the same keypress
  // that dismissed Quick Open, which would surface the cursor in the status bar.
  expect(statusShowsCursor()).toBe(false)
})

test("cancelling a discard dialog with Esc does not flip sidebar focus into the editor", async () => {
  await writeFile(join(root, "hello.ts"), "const greeting = 'changed'\n")
  testSetup = await testRender(<App workspaceRoot={root} />, {
    width: 100,
    height: 30,
    kittyKeyboard: true,
  })
  await settle(testSetup)

  // Editor holds the file, but logical focus is on the sidebar throughout.
  workbenchStore.openFile(join(root, "hello.ts"), { preview: true })
  await settle(testSetup)

  await openDiscardDialog()
  testSetup.mockInput.pressEscape()
  await waitForTextGone("discard changes in 'hello.ts'")
  await settle(testSetup, 150)

  // The dialog's own Esc cancels it; the App-level Esc must NOT also flip focus
  // sidebar→editor (which would surface the cursor in the status bar).
  expect(statusShowsCursor()).toBe(false)
})

/** Every editor textarea currently mounted, left-to-right (both split panes share the id). */
function editorTextareas(): { focused: boolean }[] {
  const out: { focused: boolean }[] = []
  const walk = (node: { id?: string; getChildren: () => unknown[] }) => {
    if (node.id === "editor-textarea") out.push(node as unknown as { focused: boolean })
    for (const child of node.getChildren()) walk(child as typeof node)
  }
  walk(testSetup.renderer.root as unknown as { getChildren: () => unknown[] })
  return out
}

test("focusing the Explorer blurs the editor so typing and arrows never reach the open document", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, {
    width: 100,
    height: 30,
    kittyKeyboard: true,
  })
  await settle(testSetup)
  await openHelloFromTree() // opens hello.ts and moves focus into the editor

  const doc = documentRegistry.get(join(root, "hello.ts"))
  const original = doc!.getText()

  // Ctrl+Shift+E moves workbench focus to the Explorer; the editor textarea must
  // blur so its native focus no longer captures keystrokes.
  testSetup.mockInput.pressKey("e", { ctrl: true, shift: true })
  await settle(testSetup, 150)

  // Typed characters land in the sidebar, not the document; arrow keys drive tree
  // navigation only — they do NOT also move the editor cursor (no double-dispatch).
  await testSetup.mockInput.typeText("ZZZ")
  testSetup.mockInput.pressArrow("down")
  testSetup.mockInput.pressArrow("up")
  await settle(testSetup, 200)
  expect(doc?.getText()).toBe(original)
  expect(doc?.getText()).not.toContain("ZZZ")
  expect(statusShowsCursor()).toBe(false)

  // Esc returns focus to the editor; the SAME typing now inserts into the document.
  testSetup.mockInput.pressEscape()
  await settle(testSetup, 150)
  await testSetup.mockInput.typeText("BBB")
  await settle(testSetup, 200)
  expect(doc?.getText()).toContain("BBB")
  expect(statusShowsCursor()).toBe(true)
})

test("in split view, sidebar focus blurs both panes and Esc focuses only the active one", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 140, height: 30 })
  await settle(testSetup)

  // Two panes over the same file. Opening/splitting now takes editor focus, so
  // explicitly return workbench focus to the sidebar to set up the blurred state.
  workbenchStore.openFile(join(root, "hello.ts"), { preview: false })
  workbenchStore.splitGroup() // the second (right) group is the active one
  workbenchStore.setFocusArea("sidebar")
  await waitForText("greeting")

  const focusedCount = () => editorTextareas().filter((t) => t.focused).length

  // Sidebar owns focus → BOTH panes are blurred.
  expect(editorTextareas()).toHaveLength(2)
  expect(focusedCount()).toBe(0)

  // Esc returns focus to the editor: ONLY the active (right) group's pane focuses.
  testSetup.mockInput.pressEscape()
  await settle(testSetup, 150)
  expect(focusedCount()).toBe(1)
  const [left, right] = editorTextareas()
  expect(left.focused).toBe(false)
  expect(right.focused).toBe(true)
})

// --- Sidebar activity tabs ---

// Center column of a header label on row 0, read from the live frame so the click
// coordinate tracks the real layout instead of a hardcoded offset.
function headerLabelX(label: string): number {
  const line0 = testSetup.captureCharFrame().split("\n")[0]
  const i = line0.indexOf(label)
  if (i === -1) throw new Error(`header label "${label}" not on row 0:\n${line0}`)
  return i + Math.floor(label.length / 2)
}

// The red channel of a header label's foreground: the active tab uses
// accentForeground (#ffffff → 255) and inactive tabs dimForeground (#858585 → 133),
// so a simple >200 / <200 split distinguishes active from dimmed.
function headerLabelRed(label: string): number {
  const spans = testSetup.captureSpans().lines[0]?.spans ?? []
  const span = spans.find((s) => s.text.trim() === label)
  if (!span) throw new Error(`no header span for "${label}": ${spans.map((s) => JSON.stringify(s.text)).join(",")}`)
  return span.fg.toInts()[0]
}

test("sidebar header shows all three activity tabs with Explorer active by default", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)

  const line0 = testSetup.captureCharFrame().split("\n")[0]
  expect(line0).toContain("Explorer")
  expect(line0).toContain("SCM")
  expect(line0).toContain("Commits")

  // Explorer is the boot view → accent (bright); the other two are dimmed.
  expect(headerLabelRed("Explorer")).toBeGreaterThan(200)
  expect(headerLabelRed("SCM")).toBeLessThan(200)
  expect(headerLabelRed("Commits")).toBeLessThan(200)
})

test("clicking the SCM tab switches to Source Control and highlights that tab", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)

  await testSetup.mockMouse.pressDown(headerLabelX("SCM"), 0)
  await waitForText("SOURCE CONTROL")

  expect(headerLabelRed("SCM")).toBeGreaterThan(200)
  expect(headerLabelRed("Explorer")).toBeLessThan(200)
})

test("clicking the Commits tab switches to the commit log", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)

  await testSetup.mockMouse.pressDown(headerLabelX("Commits"), 0)
  // The uppercase "COMMITS" panel header (distinct from the "Commits" tab label)
  // proves CommitLog rendered in the sidebar body.
  await waitForText("COMMITS")

  expect(headerLabelRed("Commits")).toBeGreaterThan(200)
})

test("Ctrl+Shift+E keyboard command still switches to and highlights the Explorer tab", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, {
    width: 100,
    height: 30,
    kittyKeyboard: true,
  })
  await settle(testSetup)

  // Move off Explorer via a click, then prove the keyboard path returns to it —
  // both routes share the same focus(view) action.
  await testSetup.mockMouse.pressDown(headerLabelX("SCM"), 0)
  await waitForText("SOURCE CONTROL")
  expect(headerLabelRed("Explorer")).toBeLessThan(200)

  testSetup.mockInput.pressKey("e", { ctrl: true, shift: true })
  await settle(testSetup)

  expect(testSetup.captureCharFrame()).toContain("hello.ts")
  expect(headerLabelRed("Explorer")).toBeGreaterThan(200)
})

test("clicking a sidebar tab does not leak focus into the editor", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle(testSetup)

  // Open a file INTO the editor so it holds focus (cursor visible in the status bar).
  await openHelloFromTree()
  expect(statusShowsCursor()).toBe(true)

  // Clicking the SCM tab must move focus to the sidebar, never leave it on the editor.
  await testSetup.mockMouse.pressDown(headerLabelX("SCM"), 0)
  await waitForText("SOURCE CONTROL")
  expect(statusShowsCursor()).toBe(false)
})
