import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { useState } from "react"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getTreeSitterClient,
  type SimpleHighlight,
  type TextareaRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { documentRegistry } from "../model/documents"
import { workbenchStore } from "../model/workbench"
import * as clipboard from "../services/clipboard"
import { CommandsProvider, useCommands } from "../workbench/CommandsProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { handleRendererSelection } from "../workbench/rendererSelection"
import type { CommandRegistry } from "../services/commands"
import { EditorPane } from "./EditorPane"

let testSetup: Awaited<ReturnType<typeof testRender>>
let dir: string
let registry: CommandRegistry | null = null

/** Restores the tree-sitter singleton's real `highlightOnce` after a test patches it. */
let restoreHighlight: (() => void) | null = null

/** Clipboard spies to restore after each test (so no test touches the real clipboard). */
let clipboardSpies: { mockRestore: () => void }[] = []

type HighlightResult = {
  highlights?: SimpleHighlight[]
  warning?: string
  error?: string
}

/**
 * Swap the singleton's `highlightOnce` for a controllable stub so highlighting
 * tests never touch the real WASM worker (deterministic + fast). Registering the
 * bundled `MockTreeSitterClient` as the singleton isn't possible — the singleton
 * store it lives in isn't exported — so we override the method on the instance.
 */
function mockHighlightOnce(
  impl: (content: string, filetype: string) => Promise<HighlightResult>,
) {
  const client = getTreeSitterClient()
  const original = client.highlightOnce.bind(client)
  client.highlightOnce = impl as typeof client.highlightOnce
  restoreHighlight = () => {
    client.highlightOnce = original
  }
}

/** The live EditBuffer behind the editable textarea, found by its stable id. */
function getEditBuffer() {
  const ta = testSetup.renderer.root.findDescendantById(
    "editor-textarea",
  ) as unknown as TextareaRenderable
  return ta.editBuffer
}

/** The single-pane editable textarea, found by its stable id. */
function getTextarea() {
  return testSetup.renderer.root.findDescendantById(
    "editor-textarea",
  ) as unknown as TextareaRenderable
}

/**
 * The editable textarea inside a named split pane. Both panes reuse the same
 * "editor-textarea" id, so each is scoped under its wrapper box's id first.
 */
function getPaneTextarea(paneId: string) {
  const pane = testSetup.renderer.root.findDescendantById(paneId)
  return pane!.findDescendantById("editor-textarea") as unknown as TextareaRenderable
}

/**
 * Fire N rapid left clicks at a content (col,row) inside the single-pane textarea.
 * Coordinates are translated from content cells to absolute terminal cells via the
 * renderable's own x/y. Rapid enough (mock click ~30ms each) to register as one
 * multi-click gesture (≤500ms window).
 */
async function clickCell(col: number, row: number, times = 1, ta = getTextarea()) {
  for (let i = 0; i < times; i++) {
    await testSetup.mockMouse.click(ta.x + col, ta.y + row)
  }
  await testSetup.flush()
}

/** Flips which split pane is focused; captured from the harness per render. */
let setFocusedPane: ((pane: 1 | 2) => void) | null = null

/**
 * Paths pinned with an extra refcount for the duration of a test. Two panes
 * mounting against the SAME path race their open/release effects, which can
 * momentarily drop the shared Document's refcount to zero and recreate it;
 * holding a pin keeps a single stable instance alive for the whole test.
 */
let pinnedPaths: string[] = []
async function pinDocument(path: string) {
  await documentRegistry.openDocument(path)
  pinnedPaths.push(path)
}

/**
 * Two EditorPanes over the SAME two groups (a split). OpenTUI focus is singular,
 * so the harness owns which pane is focused and drives both panes' `focused`
 * prop from it — mirroring how a real split has exactly one active pane.
 */
function TwoPaneHarness({ groupA, groupB }: { groupA: string; groupB: string }) {
  const [focused, setFocused] = useState<1 | 2>(1)
  setFocusedPane = setFocused
  return (
    <>
      <box id="pane-1" width={50} height={6}>
        <EditorPane focused={focused === 1} groupId={groupA} />
      </box>
      <box id="pane-2" width={50} height={6}>
        <EditorPane focused={focused === 2} groupId={groupB} />
      </box>
    </>
  )
}

function renderTwoPane(groupA: string, groupB: string) {
  return testRender(
    <OverlayProvider>
      <CommandsProvider>
        <TwoPaneHarness groupA={groupA} groupB={groupB} />
        <CaptureRegistry />
      </CommandsProvider>
    </OverlayProvider>,
    { width: 50, height: 14 },
  )
}

/** Replace the buffer's highlight mutators with pure recorders (no native side effects). */
function spyOnHighlights() {
  const eb = getEditBuffer()
  const added: { start: number; end: number; styleId: number; hlRef?: number | null }[] = []
  let removeCount = 0
  eb.addHighlightByCharRange = (h) => {
    added.push({ start: h.start, end: h.end, styleId: h.styleId, hlRef: h.hlRef })
  }
  eb.removeHighlightsByRef = () => {
    removeCount++
  }
  return {
    added,
    getRemoveCount: () => removeCount,
  }
}

/** Captures the registry created by CommandsProvider so tests can run commands. */
function CaptureRegistry() {
  registry = useCommands()
  return null
}

beforeEach(async () => {
  workbenchStore.reset()
  registry = null
  setFocusedPane = null
  dir = await mkdtemp(join(tmpdir(), "vsx-editorpane-"))
})

afterEach(async () => {
  if (testSetup) testSetup.renderer.destroy()
  if (restoreHighlight) {
    restoreHighlight()
    restoreHighlight = null
  }
  for (const spy of clipboardSpies) spy.mockRestore()
  clipboardSpies = []
  for (const path of pinnedPaths) documentRegistry.releaseDocument(path)
  pinnedPaths = []
  // Clear the shared renderer-selection cache (an empty selection resets it) so
  // one test's cached selection can't bleed into the next test's Ctrl+C.
  handleRendererSelection({ getSelectedText: () => "" })
  workbenchStore.reset()
  await rm(dir, { recursive: true, force: true })
})

/** Stub `clipboard.write` so a copy/cut test records the text without spawning pbcopy. */
function spyClipboardWrite() {
  const spy = spyOn(clipboard, "write").mockResolvedValue(undefined)
  clipboardSpies.push(spy)
  return spy
}

/** Stub `clipboard.read` so a paste test gets known text without spawning pbpaste. */
function spyClipboardRead(text: string) {
  const spy = spyOn(clipboard, "read").mockResolvedValue(text)
  clipboardSpies.push(spy)
  return spy
}

function render(props?: Partial<Parameters<typeof EditorPane>[0]>) {
  return testRender(
    <OverlayProvider>
      <CommandsProvider>
        <box width={50} height={12}>
          <EditorPane focused {...props} />
        </box>
        <CaptureRegistry />
      </CommandsProvider>
    </OverlayProvider>,
    { width: 50, height: 12 },
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

test("renders a recognized file's content in an editable textarea", async () => {
  const file = join(dir, "example.ts")
  await writeFile(file, 'const answer = 42\nfunction greet() {\n  return "hi"\n}\n')
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("const answer")

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("const answer = 42")
  expect(frame).toContain("function greet")
  expect(frame).toMatchSnapshot()
})

test("renders an unrecognized extension as plain text without crashing", async () => {
  const file = join(dir, "notes.xyz")
  await writeFile(file, "plain content here\nsecond line\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("plain content here")

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("plain content here")
  expect(frame).toContain("second line")
})

test("shows a truncated preview notice for a file larger than the limit", async () => {
  const file = join(dir, "huge.ts")
  // 6 MB > MAX_FILE_SIZE (5 MB): registry rejects with FileTooLargeError.
  await writeFile(file, "A".repeat(6 * 1024 * 1024))
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("File too large")

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("truncated preview")
  // The plain-text preview still renders some of the file's bytes.
  expect(frame).toContain("A")
})

test("shows the empty state when no tab is open", async () => {
  workbenchStore.reset()

  testSetup = await render()
  await waitForText("No file open")

  expect(testSetup.captureCharFrame()).toContain("No file open")
})

test("typing updates the document, marks it dirty, and promotes a preview tab", async () => {
  const file = join(dir, "a.ts")
  await writeFile(file, "hello\n")
  // Real call order: openFile runs BEFORE the document is registered — the pane
  // opens (and refcounts) it asynchronously during render. Promotion is driven by
  // the pane on the first local edit, so no pre-open is needed to wire it up.
  workbenchStore.openFile(file, { preview: true })

  testSetup = await render()
  await waitForText("hello")

  const doc = documentRegistry.get(file)!
  expect(doc.isDirty).toBe(false)
  const tabBefore = workbenchStore.getState().groups[0].tabs.find((t) => t.path === file)
  expect(tabBefore?.preview).toBe(true)

  await testSetup.mockInput.typeText("Z")
  await testSetup.flush()

  expect(doc.getText()).toContain("Z")
  expect(doc.isDirty).toBe(true)
  const tabAfter = workbenchStore.getState().groups[0].tabs.find((t) => t.path === file)
  expect(tabAfter?.preview).toBe(false)
})

test("after an edit promotes a preview tab, a single-click open of another file adds a new preview tab", async () => {
  const a = join(dir, "prom-a.ts")
  const b = join(dir, "prom-b.ts")
  await writeFile(a, "aaa content\n")
  await writeFile(b, "bbb content\n")
  workbenchStore.openFile(a, { preview: true })

  testSetup = await render()
  await waitForText("aaa content")

  // Type once: /a.ts promotes to a permanent tab.
  await testSetup.mockInput.typeText("Z")
  await testSetup.flush()
  expect(workbenchStore.getState().groups[0].tabs.find((t) => t.path === a)?.preview).toBe(false)

  // A fresh single-click open must NOT reuse the now-permanent slot: /b.ts opens
  // as its own preview tab alongside the promoted /a.ts.
  workbenchStore.openFile(b, { preview: true })
  await waitForText("bbb content")

  const tabs = workbenchStore.getState().groups[0].tabs
  expect(tabs.map((t) => t.path)).toEqual([a, b])
  expect(tabs.find((t) => t.path === a)?.preview).toBe(false)
  expect(tabs.find((t) => t.path === b)?.preview).toBe(true)
})

test("a disk-sourced change does NOT promote a preview tab", async () => {
  const file = join(dir, "disk-prom.ts")
  await writeFile(file, "original text\n")
  workbenchStore.openFile(file, { preview: true })

  testSetup = await render()
  await waitForText("original text")

  const doc = documentRegistry.get(file)!
  expect(workbenchStore.getState().groups[0].tabs.find((t) => t.path === file)?.preview).toBe(true)

  // Simulate an external edit reloaded from disk flowing INTO the pane. The
  // inbound sync writes the buffer to already match the Document, so the pane's
  // edit-detection no-ops and the tab stays a preview (only local edits promote).
  await writeFile(file, "reloaded text\n")
  await doc.reloadFromDisk()
  await waitForText("reloaded text")

  expect(workbenchStore.getState().groups[0].tabs.find((t) => t.path === file)?.preview).toBe(true)
})

test("Shift+Right selection is replaced by typing", async () => {
  const file = join(dir, "sel.ts")
  await writeFile(file, "abcdef\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("abcdef")

  const doc = documentRegistry.get(file)!

  // Cursor to buffer start, select the first char, then overwrite it.
  testSetup.mockInput.pressKey("HOME")
  testSetup.mockInput.pressArrow("right", { shift: true })
  await testSetup.mockInput.typeText("Z")
  await testSetup.flush()

  expect(doc.getText()).toBe("Zbcdef\n")
})

test("Ctrl+Z undoes the last edit", async () => {
  const file = join(dir, "undo.ts")
  await writeFile(file, "abc\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("abc")

  const doc = documentRegistry.get(file)!

  testSetup.mockInput.pressKey("HOME")
  await testSetup.mockInput.typeText("X")
  await testSetup.flush()
  expect(doc.getText()).toBe("Xabc\n")

  testSetup.mockInput.pressKey("z", { ctrl: true })
  await testSetup.flush()
  expect(doc.getText()).toBe("abc\n")
})

test("reloadFromDisk on a clean document updates the rendered textarea", async () => {
  const file = join(dir, "reload.ts")
  await writeFile(file, "original text\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("original text")

  const doc = documentRegistry.get(file)!
  await writeFile(file, "reloaded text\n")
  await doc.reloadFromDisk()

  await waitForText("reloaded text")
  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("reloaded text")
  expect(frame).not.toContain("original text")
})

test("split view: an edit in one pane updates the other pane without moving its cursor", async () => {
  const file = join(dir, "split-sync.ts")
  await writeFile(file, "line one\nline two\nline three\n")
  await pinDocument(file)
  workbenchStore.openFile(file, { preview: false })
  // Second group shares the SAME file (splitGroup clones the tab identity), so
  // both panes resolve to one Document.
  workbenchStore.splitGroup()
  const [g1, g2] = workbenchStore.getState().groups.map((g) => g.id)

  testSetup = await renderTwoPane(g1, g2)
  await waitForText("line one")

  // Park pane 2's cursor away from home; the inbound sync must leave it there.
  const ta2 = getPaneTextarea("pane-2")
  ta2.setCursor(1, 3)
  await testSetup.flush()
  expect(ta2.editorView.getCursor()).toEqual({ row: 1, col: 3 })

  // Type in the focused pane 1.
  testSetup.mockInput.pressKey("HOME")
  await testSetup.mockInput.typeText("Z")
  await testSetup.flush()

  // Pane 2's text mirrors the edit, but its cursor is untouched (not reset to 0,0).
  expect(ta2.plainText.startsWith("Zline one")).toBe(true)
  expect(ta2.editorView.getCursor()).toEqual({ row: 1, col: 3 })
})

test("split view: an inbound edit from the other pane preserves this pane's undo history", async () => {
  const file = join(dir, "split-undo.ts")
  await writeFile(file, "abc\n")
  await pinDocument(file)
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup()
  const [g1, g2] = workbenchStore.getState().groups.map((g) => g.id)

  testSetup = await renderTwoPane(g1, g2)
  await waitForText("abc")

  const doc = documentRegistry.get(file)!

  // Pane 1 (focused) makes a local edit — this builds pane 1's undo history.
  testSetup.mockInput.pressKey("HOME")
  await testSetup.mockInput.typeText("X")
  await testSetup.flush()
  expect(doc.getText()).toBe("Xabc\n")

  // Focus pane 2 and edit there; the change flows inbound into (now-unfocused)
  // pane 1 via replaceText, which must NOT wipe pane 1's undo stack.
  setFocusedPane!(2)
  await testSetup.flush()
  testSetup.mockInput.pressKey("HOME")
  await testSetup.mockInput.typeText("Y")
  await testSetup.flush()
  expect(doc.getText()).toBe("YXabc\n")

  // Back on pane 1, undo. Because history survived the inbound sync, undo reverts
  // the last applied change instead of being a no-op on a wiped stack.
  setFocusedPane!(1)
  await testSetup.flush()
  testSetup.mockInput.pressKey("z", { ctrl: true })
  await testSetup.flush()
  expect(doc.getText()).toBe("Xabc\n")
})

test("a disk-sourced reload preserves the focused pane's cursor position", async () => {
  const file = join(dir, "reload-cursor.ts")
  await writeFile(file, "alpha\nbravo\ncharlie\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("alpha")

  const ta = getTextarea()
  ta.setCursor(1, 3)
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 1, col: 3 })

  const doc = documentRegistry.get(file)!
  await writeFile(file, "alpha\nBRAVO2\ncharlie\n")
  await doc.reloadFromDisk()
  await waitForText("BRAVO2")

  // The reload replaces the buffer text but leaves the cursor where it was.
  expect(ta.editorView.getCursor()).toEqual({ row: 1, col: 3 })
})

test("does not highlight a document with no known grammar (undefined language)", async () => {
  let calls = 0
  mockHighlightOnce(async () => {
    calls++
    return { highlights: [] }
  })

  const file = join(dir, "notes.xyz") // unrecognized extension → language undefined
  await writeFile(file, "plain content here\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("plain content here")

  // Well past the debounce window: highlightOnce must never have been called.
  await testSetup.flush()
  await Bun.sleep(300)
  await testSetup.flush()

  expect(calls).toBe(0)
})

test("applies highlights, falling back on dotted scopes and skipping unresolved ones", async () => {
  // keyword resolves directly; function.call falls back to "function"; the third
  // scope resolves to nothing (root not registered) and must be skipped.
  const highlights: SimpleHighlight[] = [
    [0, 5, "keyword"],
    [6, 11, "function.call"],
    [12, 15, "totally.unknown"],
  ]
  mockHighlightOnce(async () => ({ highlights }))

  const file = join(dir, "hl.ts")
  await writeFile(file, "const answer = 42\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("const answer")

  const spy = spyOnHighlights()

  // Trigger a fresh debounced pass and let it settle.
  await testSetup.mockInput.typeText("x")
  await testSetup.flush()
  await Bun.sleep(300)
  await testSetup.flush()

  // Previous highlights cleared once, keyword + function.call added, unknown skipped.
  expect(spy.getRemoveCount()).toBeGreaterThanOrEqual(1)
  const starts = spy.added.map((h) => h.start).sort((a, b) => a - b)
  expect(starts).toEqual([0, 6])
  expect(spy.added.every((h) => typeof h.styleId === "number")).toBe(true)
  expect(spy.added.every((h) => h.hlRef === 1)).toBe(true)
})

test("a rapid burst of edits settles on the FINAL text, ignoring stale results", async () => {
  // Hand out manually-resolved promises so we can force out-of-order resolution:
  // an earlier (stale) request resolving AFTER a newer one must not win.
  const pending: { content: string; resolve: (r: HighlightResult) => void }[] = []
  mockHighlightOnce(
    (content) =>
      new Promise<HighlightResult>((resolve) => {
        pending.push({ content, resolve })
      }),
  )

  const file = join(dir, "stale.ts")
  await writeFile(file, "const a = 1\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("const a")

  const spy = spyOnHighlights()

  // Tick 1: type, let the debounce fire one highlightOnce for this text.
  await testSetup.mockInput.typeText("A")
  await testSetup.flush()
  await Bun.sleep(300)
  await testSetup.flush()
  const stale = pending[pending.length - 1]

  // Tick 2: type again, fire a second, newer highlightOnce for the newer text.
  await testSetup.mockInput.typeText("B")
  await testSetup.flush()
  await Bun.sleep(300)
  await testSetup.flush()
  const latest = pending[pending.length - 1]

  expect(stale).not.toBe(latest)
  const removeBefore = spy.getRemoveCount()

  // Resolve NEWEST first (applies), then the STALE one (must be ignored).
  latest.resolve({ highlights: [[0, 1, "keyword"]] })
  await testSetup.flush()
  await Bun.sleep(10)
  stale.resolve({ highlights: [[3, 4, "string"]] })
  await testSetup.flush()
  await Bun.sleep(10)

  // Only the latest pass applied: its span is present, the stale one never added,
  // and exactly one clear happened (the stale resolution short-circuits before it).
  const starts = spy.added.map((h) => h.start)
  expect(starts).toContain(0)
  expect(starts).not.toContain(3)
  expect(spy.getRemoveCount()).toBe(removeBefore + 1)
})

test("a rejected highlight parse never crashes the editor and typing still works", async () => {
  mockHighlightOnce(async () => {
    throw new Error("boom: parse failed")
  })

  const file = join(dir, "err.ts")
  await writeFile(file, "const ok = 1\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("const ok")

  const doc = documentRegistry.get(file)!

  // Type through a failing highlight pass; the rejection is swallowed.
  await testSetup.mockInput.typeText("Z")
  await testSetup.flush()
  await Bun.sleep(300)
  await testSetup.flush()

  expect(doc.getText()).toContain("Z")

  // Editor remains usable: a subsequent edit still lands.
  await testSetup.mockInput.typeText("Q")
  await testSetup.flush()

  expect(doc.getText()).toContain("Q")
  expect(testSetup.captureCharFrame()).toContain("const ok")
})

/** HOME, then N shift-rights: selects the first N chars of the first line. */
async function selectFirst(n: number) {
  testSetup.mockInput.pressKey("HOME")
  for (let i = 0; i < n; i++) testSetup.mockInput.pressArrow("right", { shift: true })
  await testSetup.flush()
}

test("Ctrl+C copies the current selection to the clipboard", async () => {
  const writeSpy = spyClipboardWrite()
  const file = join(dir, "copy.ts")
  await writeFile(file, "abcdef\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("abcdef")

  await selectFirst(3)
  testSetup.mockInput.pressKey("c", { ctrl: true })
  await testSetup.flush()

  expect(writeSpy).toHaveBeenCalledTimes(1)
  expect(writeSpy.mock.calls[0][0]).toBe("abc")
})

test("Ctrl+C with no selection is a no-op", async () => {
  const writeSpy = spyClipboardWrite()
  const file = join(dir, "nocopy.ts")
  await writeFile(file, "abcdef\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("abcdef")

  testSetup.mockInput.pressKey("HOME")
  testSetup.mockInput.pressKey("c", { ctrl: true })
  await testSetup.flush()

  expect(writeSpy).not.toHaveBeenCalled()
})

test("Ctrl+C falls back to the last renderer selection when the buffer has none", async () => {
  const writeSpy = spyClipboardWrite()
  const file = join(dir, "fallback.ts")
  await writeFile(file, "abcdef\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("abcdef")

  // Prime the shared cache as a drag over a non-textarea surface (diff/preview)
  // would; that copy-on-select write is cleared so the assertion sees only the
  // Ctrl+C fallback write. Ctrl+C with NO buffer selection copies the cached text.
  handleRendererSelection({ getSelectedText: () => "from the diff pane" })
  writeSpy.mockClear()
  testSetup.mockInput.pressKey("HOME")
  testSetup.mockInput.pressKey("c", { ctrl: true })
  await testSetup.flush()

  expect(writeSpy).toHaveBeenCalledTimes(1)
  expect(writeSpy.mock.calls[0][0]).toBe("from the diff pane")
})

test("Ctrl+C copies the buffer selection even when a renderer selection is cached", async () => {
  const writeSpy = spyClipboardWrite()
  const file = join(dir, "prefer-buffer.ts")
  await writeFile(file, "abcdef\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("abcdef")

  // A live buffer selection takes precedence over the cached renderer selection.
  handleRendererSelection({ getSelectedText: () => "stale renderer text" })
  writeSpy.mockClear()
  await selectFirst(3)
  testSetup.mockInput.pressKey("c", { ctrl: true })
  await testSetup.flush()

  expect(writeSpy).toHaveBeenCalledTimes(1)
  expect(writeSpy.mock.calls[0][0]).toBe("abc")
})

test("Ctrl+X copies the selection and removes it from the document", async () => {
  const writeSpy = spyClipboardWrite()
  const file = join(dir, "cut.ts")
  await writeFile(file, "abcdef\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("abcdef")

  const doc = documentRegistry.get(file)!
  await selectFirst(3)
  testSetup.mockInput.pressKey("x", { ctrl: true })
  await testSetup.flush()

  expect(writeSpy).toHaveBeenCalledTimes(1)
  expect(writeSpy.mock.calls[0][0]).toBe("abc")
  expect(doc.getText()).toBe("def\n")
})

test("Ctrl+V replaces the active selection with the clipboard text", async () => {
  spyClipboardRead("XYZ")
  const file = join(dir, "paste-sel.ts")
  await writeFile(file, "abcdef\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("abcdef")

  const doc = documentRegistry.get(file)!
  await selectFirst(3)
  testSetup.mockInput.pressKey("v", { ctrl: true })
  await testSetup.flush()
  await Bun.sleep(20)
  await testSetup.flush()

  expect(doc.getText()).toBe("XYZdef\n")
})

test("Ctrl+V inserts the clipboard text at the cursor when nothing is selected", async () => {
  spyClipboardRead("XYZ")
  const file = join(dir, "paste-nosel.ts")
  await writeFile(file, "abcdef\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("abcdef")

  const doc = documentRegistry.get(file)!
  testSetup.mockInput.pressKey("HOME")
  testSetup.mockInput.pressKey("v", { ctrl: true })
  await testSetup.flush()
  await Bun.sleep(20)
  await testSetup.flush()

  expect(doc.getText()).toBe("XYZabcdef\n")
})

test("single click positions the caret and reports the new Ln/Col", async () => {
  const positions: { line: number; column: number }[] = []
  const file = join(dir, "click.ts")
  await writeFile(file, "hello world\nsecond line\n")
  workbenchStore.openFile(file)

  testSetup = await render({ onCursorChange: (p) => positions.push(p) })
  await waitForText("hello world")

  await clickCell(6, 1) // the space after "second" on line 2
  const ta = getTextarea()
  expect(ta.editorView.getCursor()).toEqual({ row: 1, col: 6 })
  // 1-based status-bar coordinates off the existing cursor-report path.
  expect(positions.at(-1)).toEqual({ line: 2, column: 7 })

  // Typing inserts exactly at the clicked position.
  await testSetup.mockInput.typeText("X")
  await testSetup.flush()
  expect(documentRegistry.get(file)!.getText()).toBe("hello world\nsecondX line\n")
})

test("double-click selects the word and typing replaces it", async () => {
  const file = join(dir, "dbl.ts")
  await writeFile(file, "hello world\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("hello world")

  await clickCell(8, 0, 2) // inside "world"
  const ta = getTextarea()
  expect(ta.getSelectedText()).toBe("world")
  expect(ta.hasSelection()).toBe(true)

  // Typing replaces the selected word (existing typing-replaces-selection path).
  await testSetup.mockInput.typeText("Z")
  await testSetup.flush()
  expect(documentRegistry.get(file)!.getText()).toBe("hello Z\n")
})

test("triple-click selects the whole line including its trailing newline", async () => {
  const file = join(dir, "tri.ts")
  await writeFile(file, "alpha\nbravo\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("alpha")

  await clickCell(2, 0, 3)
  expect(getTextarea().getSelectedText()).toBe("alpha\n")
})

test("triple-click on the last (newline-less) line selects to end of line", async () => {
  const file = join(dir, "tri-last.ts")
  // No trailing newline after "last".
  await writeFile(file, "first\nlast")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("last")

  await clickCell(2, 1, 3)
  expect(getTextarea().getSelectedText()).toBe("last")
})

test("double-click then a single click elsewhere clears the selection and moves the caret", async () => {
  const file = join(dir, "dbl-single.ts")
  await writeFile(file, "hello world\nsecond line\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("hello world")

  await clickCell(8, 0, 2) // select "world"
  const ta = getTextarea()
  expect(ta.getSelectedText()).toBe("world")

  // A single click on a different line: the renderer clears only its local (drag)
  // selection on mousedown, so the handler must clear the buffer selection too.
  await clickCell(2, 1)
  expect(ta.hasSelection()).toBe(false)
  expect(ta.editorView.getCursor()).toEqual({ row: 1, col: 2 })
})

test("click positions the caret in a split's non-focused pane", async () => {
  const file = join(dir, "split-click.ts")
  await writeFile(file, "line one\nline two\nline three\n")
  await pinDocument(file)
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup()
  const [g1, g2] = workbenchStore.getState().groups.map((g) => g.id)

  testSetup = await renderTwoPane(g1, g2)
  await waitForText("line one")

  // Pane 1 holds focus (harness default); click into the UNfocused pane 2.
  const ta2 = getPaneTextarea("pane-2")
  await clickCell(5, 1, 1, ta2) // inside "line two"
  expect(ta2.editorView.getCursor()).toEqual({ row: 1, col: 5 })
})

test("switching the active tab releases the previous document's refcount", async () => {
  const a = join(dir, "switch-a.ts")
  const b = join(dir, "switch-b.ts")
  await writeFile(a, "aaa content\n")
  await writeFile(b, "bbb content\n")
  workbenchStore.openFile(a, { preview: false })

  testSetup = await render()
  await waitForText("aaa content")
  expect(documentRegistry.get(a)).toBeDefined()

  workbenchStore.openFile(b, { preview: false })
  await waitForText("bbb content")

  expect(documentRegistry.get(b)).toBeDefined()
  // The pane held the ONLY refcount on A, so switching away disposes it.
  expect(documentRegistry.get(a)).toBeUndefined()
})

test("switching tabs before the initial open resolves does not leak a refcount", async () => {
  const a = join(dir, "race-a.ts")
  const b = join(dir, "race-b.ts")
  await writeFile(a, "aaa content\n")
  await writeFile(b, "bbb content\n")
  workbenchStore.openFile(a, { preview: false })

  testSetup = await render()
  // Switch away immediately, without waiting for A's open to resolve: the
  // effect cleanup must not release a refcount it never acquired, and A's late
  // resolution must release the one it takes.
  workbenchStore.openFile(b, { preview: false })
  await waitForText("bbb content")
  await Bun.sleep(50)
  await testSetup.flush()

  expect(documentRegistry.get(a)).toBeUndefined()
  expect(documentRegistry.get(b)).toBeDefined()
})
