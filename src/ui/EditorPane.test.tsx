import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { useState } from "react"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getTreeSitterClient,
  type ScrollBarRenderable,
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
import { getEditorControls } from "../workbench/editorControls"
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

/** A scrollbar by its stable id, or null when it isn't in the tree (e.g. the
 * horizontal bar while wrap is on). */
function getScrollbar(id: string): ScrollBarRenderable | null {
  return (testSetup.renderer.root.findDescendantById(id) as unknown as ScrollBarRenderable) ?? null
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

test("resolves the markup and extended Dark+ scopes added for the new grammars", async () => {
  // Scopes markdown/html/json/yaml grammars emit that the pre-centralization theme
  // did NOT cover: enumerated markup.* (a heading level, strong, a link variant)
  // plus variable.member / label / string.special.key. All must now resolve to a
  // styleId; a genuinely unregistered scope must still be skipped.
  const highlights: SimpleHighlight[] = [
    [0, 1, "markup.heading.1"],
    [2, 3, "markup.strong"],
    [4, 5, "markup.link.url"],
    [6, 7, "variable.member"],
    [8, 9, "label"],
    [10, 11, "string.special.key"],
    [12, 13, "totally.unknown"], // control: root not registered → skipped
  ]
  mockHighlightOnce(async () => ({ highlights }))

  const file = join(dir, "coverage.md")
  await writeFile(file, "abcdefghijklmnop\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("abcdef")

  const spy = spyOnHighlights()

  // Trigger a fresh debounced pass and let it settle.
  await testSetup.mockInput.typeText("x")
  await testSetup.flush()
  await Bun.sleep(300)
  await testSetup.flush()

  // Every newly-covered scope applied; only the unregistered control was skipped.
  const starts = spy.added.map((h) => h.start).sort((a, b) => a - b)
  expect(starts).toEqual([0, 2, 4, 6, 8, 10])
  expect(spy.added.every((h) => typeof h.styleId === "number")).toBe(true)
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

test("Ctrl+A goes to the start of the current VISUAL line (not select-all), staying put on repeat", async () => {
  const file = join(dir, "vlh.ts")
  // Line 0 is short (no wrap); line 1 is long enough to wrap into several visual rows.
  await writeFile(file, `hello world\n${"word ".repeat(40).trim()}\n`)
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("hello world")

  const ta = getTextarea()

  // --- non-wrapped line: mid-line Ctrl+A → line start, no selection (not select-all) ---
  ta.setCursor(0, 6)
  await testSetup.flush()
  // pressKey ctrl+a emits raw byte 0x01 — exactly what a macOS terminal translates
  // cmd+left into, so this is the true cmd+left path (no kitty protocol).
  testSetup.mockInput.pressKey("a", { ctrl: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 0 })
  expect(ta.hasSelection()).toBe(false)

  // Repeat is a no-op — it stays at the visual-row start (VSCode Home-under-wrap).
  testSetup.mockInput.pressKey("a", { ctrl: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 0 })

  // --- wrapped line: Ctrl+A → start of the CURRENT visual row, not logical col 0 ---
  ta.setCursor(1, 190) // deep in a later visual segment of the wrapped line
  await testSetup.flush()
  testSetup.mockInput.pressKey("a", { ctrl: true })
  await testSetup.flush()
  const c = ta.editorView.getCursor()
  expect(c.row).toBe(1) // stayed on the same logical line
  expect(c.col).toBeGreaterThan(0) // NOT the logical line home (col 0)
  expect(c.col).toBeLessThan(190) // moved back to this visual row's start
})

test("Ctrl+E goes to the end of the current VISUAL line, staying put and never advancing to the next line", async () => {
  const file = join(dir, "vle.ts")
  await writeFile(file, `hello\n${"word ".repeat(40).trim()}\n`)
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("hello")

  const ta = getTextarea()

  // --- non-wrapped line: Ctrl+E → end of line 0 ("hello" → col 5) ---
  ta.setCursor(0, 0)
  await testSetup.flush()
  // pressKey ctrl+e emits raw byte 0x05 — the byte a macOS terminal translates
  // cmd+right into.
  testSetup.mockInput.pressKey("e", { ctrl: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 5 })

  // The key regression: at end-of-line, a second Ctrl+E must NOT advance to the
  // next line (OpenTUI's default line-end has that emacs at-EOL jump; visual-line-end
  // does not).
  testSetup.mockInput.pressKey("e", { ctrl: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 5 })

  // --- wrapped line: Ctrl+E from an early visual segment → that segment's end,
  // still on the same logical line and short of the logical line end. ---
  const lineLen = "word ".repeat(40).trim().length
  ta.setCursor(1, 20) // an early visual segment (not the last)
  await testSetup.flush()
  testSetup.mockInput.pressKey("e", { ctrl: true })
  await testSetup.flush()
  const c = ta.editorView.getCursor()
  expect(c.row).toBe(1) // did NOT advance to the next logical line
  expect(c.col).toBeGreaterThan(20) // moved forward to this visual row's end
  expect(c.col).toBeLessThan(lineLen) // a visual-row end, NOT the logical line end
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

/**
 * REGRESSION (drag-selection): these tests drive the FULL renderer mouse pipeline
 * (down → drag(s) → up through processSingleMouseEvent), which is the only path
 * where the renderer's selection gesture exists. The multi-click handler's
 * single-click branch used to call `ta.clearSelection()`, whose internal
 * `_ctx.clearSelection()` aborted the gesture the renderer had just armed on the
 * same mousedown — killing ALL mouse drag-selection while direct-dispatch tests
 * stayed green. Dispatching straight at the textarea would not catch this class.
 */
test("mouse drag selects across multiple lines (buffer selection, not just highlight)", async () => {
  const file = join(dir, "drag-select.ts")
  await writeFile(file, "alpha one\nbravo two\ncharlie three\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("charlie three")

  const ta = getTextarea()
  // Drag from line 1 col 2 down to line 3 col 7 (mockMouse emits down,
  // intermediate drags, and up — the renderer arms/updates/finishes the gesture).
  await testSetup.mockMouse.drag(ta.x + 2, ta.y + 0, ta.x + 7, ta.y + 2)
  await testSetup.flush()

  expect(ta.hasSelection()).toBe(true)
  const selected = ta.getSelectedText()
  expect(selected).toContain("pha one\n")
  expect(selected).toContain("bravo two\n")
  expect(selected).toContain("charlie")
  expect(selected.split("\n").length).toBe(3)
})

test("typing replaces a mouse-dragged selection", async () => {
  const file = join(dir, "drag-type.ts")
  await writeFile(file, "abcdef\nghijkl\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("ghijkl")

  const ta = getTextarea()
  // Select from line 1 col 2 through line 2 col 3 ("cdef\nghi").
  await testSetup.mockMouse.drag(ta.x + 2, ta.y + 0, ta.x + 3, ta.y + 1)
  await testSetup.flush()
  expect(ta.hasSelection()).toBe(true)

  await testSetup.mockInput.typeText("X")
  await testSetup.flush()
  expect(documentRegistry.get(file)!.getText()).toBe("abXjkl\n")
})

test("Ctrl+C copies a mouse-dragged selection", async () => {
  const writeSpy = spyClipboardWrite()
  const file = join(dir, "drag-copy.ts")
  await writeFile(file, "one two\nthree four\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("three four")

  const ta = getTextarea()
  await testSetup.mockMouse.drag(ta.x + 4, ta.y + 0, ta.x + 5, ta.y + 1)
  await testSetup.flush()
  const selected = ta.getSelectedText()
  expect(selected.length).toBeGreaterThan(0)

  testSetup.mockInput.pressKey("c", { ctrl: true })
  await testSetup.flush()
  expect(writeSpy).toHaveBeenCalled()
  expect(String(writeSpy.mock.calls.at(-1)?.[0])).toBe(selected)
})

test("a plain single click after a drag selection collapses it and moves the caret", async () => {
  const file = join(dir, "drag-then-click.ts")
  await writeFile(file, "hello world\nsecond line\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("second line")

  const ta = getTextarea()
  await testSetup.mockMouse.drag(ta.x + 0, ta.y + 0, ta.x + 5, ta.y + 1)
  await testSetup.flush()
  expect(ta.hasSelection()).toBe(true)

  await clickCell(3, 1)
  expect(ta.hasSelection()).toBe(false)
  expect(ta.editorView.getCursor()).toEqual({ row: 1, col: 3 })
})

test("shift+click extends the selection from the current caret", async () => {
  const file = join(dir, "shift-click.ts")
  await writeFile(file, "hello world\nsecond line\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("second line")

  const ta = getTextarea()
  // Place the caret at line 1 col 2, then shift+click at line 2 col 6.
  await clickCell(2, 0)
  await testSetup.mockMouse.click(ta.x + 6, ta.y + 1, 0, { modifiers: { shift: true } })
  await testSetup.flush()

  // Selection spans caret → shift-clicked cell: "llo world\nsecond".
  expect(ta.hasSelection()).toBe(true)
  expect(ta.getSelectedText()).toBe("llo world\nsecond")
})

test("shift+click with an existing selection keeps the far anchor", async () => {
  const file = join(dir, "shift-anchor.ts")
  await writeFile(file, "alpha bravo charlie\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("alpha bravo charlie")

  const ta = getTextarea()
  await clickCell(8, 0, 2) // double-click "bravo" → selection [6,11)
  expect(ta.getSelectedText()).toBe("bravo")

  // Shift+click far to the RIGHT: the selection's left end (6) is the far
  // anchor, so the result runs from "bravo"'s start to the clicked cell.
  await testSetup.mockMouse.click(ta.x + 17, ta.y + 0, 0, { modifiers: { shift: true } })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("bravo charl")
})

test("double-click then drag extends the selection word-wise", async () => {
  const file = join(dir, "dbl-drag.ts")
  await writeFile(file, "alpha bravo charlie delta\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("alpha bravo charlie")

  const ta = getTextarea()
  const mm = testSetup.mockMouse
  // Real double-click-drag: click, then press-and-hold (2nd down arms the word
  // gesture on "bravo"), drag into the middle of "charlie", release.
  await mm.click(ta.x + 8, ta.y + 0)
  await mm.pressDown(ta.x + 8, ta.y + 0)
  await mm.emitMouseEvent("drag", ta.x + 15, ta.y + 0)
  await mm.release(ta.x + 15, ta.y + 0)
  await testSetup.flush()

  // Whole words: anchor word "bravo" through focus word "charlie".
  expect(ta.getSelectedText()).toBe("bravo charlie")
})

test("double-click drag shrinks back to the anchor word when the pointer returns", async () => {
  const file = join(dir, "dbl-drag-shrink.ts")
  await writeFile(file, "alpha bravo charlie delta\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("alpha bravo charlie")

  const ta = getTextarea()
  const mm = testSetup.mockMouse
  await mm.click(ta.x + 8, ta.y + 0)
  await mm.pressDown(ta.x + 8, ta.y + 0)
  await mm.emitMouseEvent("drag", ta.x + 15, ta.y + 0) // out to "charlie"
  await mm.emitMouseEvent("drag", ta.x + 8, ta.y + 0) // back inside "bravo"
  await mm.release(ta.x + 8, ta.y + 0)
  await testSetup.flush()

  expect(ta.getSelectedText()).toBe("bravo")
})

test("triple-click then drag extends the selection line-wise", async () => {
  const file = join(dir, "tri-drag.ts")
  await writeFile(file, "one\ntwo\nthree\nfour\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("three")

  const ta = getTextarea()
  const mm = testSetup.mockMouse
  // click, click, press-and-hold (3rd down arms the line gesture on line 2), drag down.
  await mm.click(ta.x + 1, ta.y + 1)
  await mm.click(ta.x + 1, ta.y + 1)
  await mm.pressDown(ta.x + 1, ta.y + 1)
  await mm.emitMouseEvent("drag", ta.x + 2, ta.y + 2)
  await mm.release(ta.x + 2, ta.y + 2)
  await testSetup.flush()

  // Whole lines 2-3 including their trailing newlines.
  expect(ta.getSelectedText()).toBe("two\nthree\n")
})

test("drag-selecting at the bottom edge auto-scrolls the viewport", async () => {
  const file = join(dir, "autoscroll.ts")
  const body = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1).padStart(2, "0")}`).join("\n")
  await writeFile(file, `${body}\n`)
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("line 01")

  const ta = getTextarea()
  const mm = testSetup.mockMouse
  const bottomY = ta.y + ta.height - 1

  await mm.pressDown(ta.x + 2, ta.y + 1)
  // Park the pointer on the bottom edge until the auto-scroll velocity has
  // demonstrably moved the viewport (bounded poll — tolerant of load-dependent
  // frame pacing in a full-suite run).
  for (let i = 0; i < 40 && ta.editorView.getViewport().offsetY === 0; i++) {
    await mm.emitMouseEvent("drag", ta.x + 2, bottomY)
    await Bun.sleep(25)
    await testSetup.flush()
  }
  await mm.release(ta.x + 2, bottomY)
  await testSetup.flush()

  expect(ta.editorView.getViewport().offsetY).toBeGreaterThan(0)
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

/** Alt+Up/Down (Option on macOS): CSI 1;3A/B → parser sets key.option. */
function pressAltArrow(direction: "up" | "down") {
  testSetup.mockInput.pressArrow(direction, { meta: true })
}

test("Alt+Down moves the current line down and follows it with the caret", async () => {
  const file = join(dir, "move-down.ts")
  await writeFile(file, "one\ntwo\nthree\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("three")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  ta.setCursor(0, 2) // on "one"
  await testSetup.flush()

  pressAltArrow("down")
  await testSetup.flush()

  expect(doc.getText()).toBe("two\none\nthree\n")
  // Caret follows the moved line (row 0 → row 1), column preserved.
  expect(ta.editorView.getCursor()).toEqual({ row: 1, col: 2 })
})

test("Alt+Up moves the current line up and follows it with the caret", async () => {
  const file = join(dir, "move-up.ts")
  await writeFile(file, "one\ntwo\nthree\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("three")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  ta.setCursor(2, 1) // on "three"
  await testSetup.flush()

  pressAltArrow("up")
  await testSetup.flush()

  expect(doc.getText()).toBe("one\nthree\ntwo\n")
  expect(ta.editorView.getCursor()).toEqual({ row: 1, col: 1 })
})

test("Alt+Up on the first line is a no-op", async () => {
  const file = join(dir, "move-up-edge.ts")
  await writeFile(file, "one\ntwo\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("two")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  ta.setCursor(0, 1)
  await testSetup.flush()

  pressAltArrow("up")
  await testSetup.flush()

  expect(doc.getText()).toBe("one\ntwo\n")
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 1 })
})

test("Alt+Down on the last line is a no-op", async () => {
  const file = join(dir, "move-down-edge.ts")
  // No trailing newline, so "two" is the true last line.
  await writeFile(file, "one\ntwo")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("two")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  ta.setCursor(1, 1)
  await testSetup.flush()

  pressAltArrow("down")
  await testSetup.flush()

  expect(doc.getText()).toBe("one\ntwo")
  expect(ta.editorView.getCursor()).toEqual({ row: 1, col: 1 })
})

// A trailing newline leaves a phantom empty final line in plainText.split("\n").
// VSCode's getLineCount() counts that phantom line too, so its down-guard fires on
// the phantom line — not the last text line. These pin that parity: the last TEXT
// line still moves (swapping below the phantom line), and the phantom line is what
// no-ops. See the move handler's guard in EditorPane.tsx.
test("Alt+Down on the last text line of a newline-terminated file swaps it below the phantom line", async () => {
  const file = join(dir, "move-down-trailing.ts")
  await writeFile(file, "one\ntwo\nthree\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("three")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  ta.setCursor(2, 1) // on "three", the last text line
  await testSetup.flush()

  pressAltArrow("down")
  await testSetup.flush()

  // "three" swaps below the phantom empty final line — VSCode does the same.
  expect(doc.getText()).toBe("one\ntwo\n\nthree")
  // Caret follows the moved line down one row, column preserved.
  expect(ta.editorView.getCursor()).toEqual({ row: 3, col: 1 })
})

test("Alt+Down on the phantom empty final line is a no-op", async () => {
  const file = join(dir, "move-down-phantom.ts")
  await writeFile(file, "one\ntwo\nthree\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("three")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  ta.setCursor(3, 0) // on the phantom empty line after the trailing newline
  await testSetup.flush()

  pressAltArrow("down")
  await testSetup.flush()

  expect(doc.getText()).toBe("one\ntwo\nthree\n")
  expect(ta.editorView.getCursor()).toEqual({ row: 3, col: 0 })
})

test("Alt+Up on the phantom empty final line moves it above the last text line", async () => {
  const file = join(dir, "move-up-phantom.ts")
  await writeFile(file, "one\ntwo\nthree\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("three")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  ta.setCursor(3, 0) // on the phantom empty line
  await testSetup.flush()

  pressAltArrow("up")
  await testSetup.flush()

  // The empty line swaps above "three", producing the same text as the mirror-image
  // Alt+Down case but with the caret on the moved (now line-3) empty line.
  expect(doc.getText()).toBe("one\ntwo\n\nthree")
  expect(ta.editorView.getCursor()).toEqual({ row: 2, col: 0 })
})

test("a single Ctrl+Z restores the exact text after a trailing-newline-edge move", async () => {
  const file = join(dir, "move-trailing-undo.ts")
  await writeFile(file, "one\ntwo\nthree\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("three")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  ta.setCursor(2, 1) // on the last text line
  await testSetup.flush()

  pressAltArrow("down")
  await testSetup.flush()
  expect(doc.getText()).toBe("one\ntwo\n\nthree")

  testSetup.mockInput.pressKey("z", { ctrl: true })
  await testSetup.flush()

  expect(doc.getText()).toBe("one\ntwo\nthree\n")
})

test("Alt+Down keeps the caret's column on the moved line even past a shorter neighbor", async () => {
  const file = join(dir, "move-sticky.ts")
  await writeFile(file, "longer line here\nab\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("longer line")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  // Caret near the end of the long line; the line moves intact, so its column is
  // preserved even though the neighbor it swaps with ("ab") is far shorter.
  ta.setCursor(0, 12)
  await testSetup.flush()

  pressAltArrow("down")
  await testSetup.flush()

  expect(doc.getText()).toBe("ab\nlonger line here\n")
  expect(ta.editorView.getCursor()).toEqual({ row: 1, col: 12 })
})

test("Alt+Down moves a multi-line selection block and the selection follows it", async () => {
  const file = join(dir, "move-block.ts")
  await writeFile(file, "one\ntwo\nthree\nfour\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("four")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  // Select "one\ntwo" (rows 0-1) via offsets, then move the block down.
  const start = ta.editBuffer.positionToOffset(0, 0)
  const end = ta.editBuffer.positionToOffset(1, 3)
  ta.setSelection(start, end)
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("one\ntwo")

  pressAltArrow("down")
  await testSetup.flush()

  expect(doc.getText()).toBe("three\none\ntwo\nfour\n")
  // The selection tracks the moved block (now rows 1-2).
  expect(ta.getSelectedText()).toBe("one\ntwo")
})

test("a single Ctrl+Z fully restores the text and caret after an Alt move", async () => {
  const file = join(dir, "move-undo.ts")
  await writeFile(file, "one\ntwo\nthree\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("three")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  ta.setCursor(0, 1)
  await testSetup.flush()

  pressAltArrow("down")
  await testSetup.flush()
  expect(doc.getText()).toBe("two\none\nthree\n")

  testSetup.mockInput.pressKey("z", { ctrl: true })
  await testSetup.flush()

  expect(doc.getText()).toBe("one\ntwo\nthree\n")
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 1 })
})

test("an Alt move marks the document dirty and updates the reported Ln/Col", async () => {
  const positions: { line: number; column: number }[] = []
  const file = join(dir, "move-dirty.ts")
  await writeFile(file, "one\ntwo\nthree\n")
  workbenchStore.openFile(file)

  testSetup = await render({ onCursorChange: (p) => positions.push(p) })
  await waitForText("three")

  const ta = getTextarea()
  const doc = documentRegistry.get(file)!
  expect(doc.isDirty).toBe(false)
  ta.setCursor(0, 2)
  await testSetup.flush()

  pressAltArrow("down")
  await testSetup.flush()

  expect(doc.isDirty).toBe(true)
  // Caret moved from line 1 to line 2 (1-based status-bar coordinates).
  expect(positions.at(-1)).toEqual({ line: 2, column: 3 })
})

test("the gutter numbers the visible lines", async () => {
  const file = join(dir, "gutter.ts")
  await writeFile(file, "alpha\nbravo\ncharlie\n")
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("charlie")

  const frame = testSetup.captureCharFrame()
  // A 3-wide gutter (single-digit doc): right-aligned number, one padding col, content.
  expect(frame).toContain(" 1 alpha")
  expect(frame).toContain(" 2 bravo")
  expect(frame).toContain(" 3 charlie")
})

test("scrolling past the viewport updates the first visible line number", async () => {
  const file = join(dir, "gutter-scroll.ts")
  // 60 digit-free content lines so any digit in a frame can only be a gutter number.
  const body = Array.from({ length: 60 }, () => "zzz").join("\n")
  await writeFile(file, `${body}\n`)
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("zzz")

  // At the top, the far line number is nowhere on screen.
  expect(testSetup.captureCharFrame()).not.toContain("60")

  // Reveal the last line through the same control Quick Open's go-to-line uses.
  const groupId = workbenchStore.getState().activeGroupId
  getEditorControls(groupId)!.gotoLine(60)

  // Bounded poll: the gutter re-syncs on the next frame after scrollY changes.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !testSetup.captureCharFrame().includes("60")) {
    await testSetup.flush()
    await Bun.sleep(30)
  }
  expect(testSetup.captureCharFrame()).toContain("60")
})

test("a long wrapped line is numbered only on its first visual row", async () => {
  const file = join(dir, "gutter-wrap.ts")
  // Middle line is far wider than the 50-col pane, so it wraps to several rows.
  await writeFile(file, `short\n${"x".repeat(120)}\nafter`)
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("after")

  const frame = testSetup.captureCharFrame()
  const xLines = frame.split("\n").filter((l) => l.includes("xxx"))
  // The long line occupies multiple visual rows...
  expect(xLines.length).toBeGreaterThan(1)
  // ...but only its first visual row carries a number (content has no digits, so
  // any digit on an x-row is the gutter).
  expect(xLines.filter((l) => /\d/.test(l)).length).toBe(1)
  // Numbering skips wrap-continuation rows: the third logical line is still "3".
  expect(frame).toContain("3")
  expect(frame).not.toContain("4")
})

test("the gutter widens for a document with more than 999 lines", async () => {
  const file = join(dir, "gutter-wide.ts")
  const body = Array.from({ length: 1200 }, () => "zzz").join("\n")
  await writeFile(file, `${body}\n`)
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("zzz")

  // Four-digit line count → gutter widens to fit (digits + one pad col each side),
  // shifting the textarea right accordingly.
  expect(getTextarea().x).toBe(6)

  const groupId = workbenchStore.getState().activeGroupId
  getEditorControls(groupId)!.gotoLine(1200)
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !testSetup.captureCharFrame().includes("1200")) {
    await testSetup.flush()
    await Bun.sleep(30)
  }
  expect(testSetup.captureCharFrame()).toContain("1200")
})

test("the vertical scrollbar's position reflects the viewport after a deep goto-line jump", async () => {
  const file = join(dir, "vbar-scroll.ts")
  const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")
  await writeFile(file, `${body}\n`)
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("line 1")

  // Jump deep into the document through the same control Quick Open's go-to-line
  // uses; the viewport scrolls to reveal line 200.
  const groupId = workbenchStore.getState().activeGroupId
  getEditorControls(groupId)!.gotoLine(200)

  const ta = getTextarea()
  // Bounded poll: the per-frame sync mirrors the scrolled viewport onto the bar.
  const deadline = Date.now() + 3000
  let vbar = getScrollbar("editor-vscrollbar")
  while (
    Date.now() < deadline &&
    !(vbar && vbar.scrollPosition > 0 && vbar.scrollPosition === ta.editorView.getViewport().offsetY)
  ) {
    await testSetup.flush()
    await Bun.sleep(30)
    vbar = getScrollbar("editor-vscrollbar")
  }

  const vp = ta.editorView.getViewport()
  expect(vp.offsetY).toBeGreaterThan(0)
  expect(vbar!.scrollPosition).toBe(vp.offsetY)
})

test("dragging the vertical scrollbar thumb scrolls the editor viewport", async () => {
  const file = join(dir, "vbar-drag.ts")
  const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")
  await writeFile(file, `${body}\n`)
  workbenchStore.openFile(file)

  testSetup = await render()
  await waitForText("line 1")

  const ta = getTextarea()
  ta.setCursor(0, 0)
  await testSetup.flush()

  // Let the per-frame sync size the thumb from the document extent (so the bar is
  // draggable, not auto-hidden).
  const vbar = getScrollbar("editor-vscrollbar")!
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && vbar.scrollSize <= vbar.viewportSize) {
    await testSetup.flush()
    await Bun.sleep(30)
  }
  expect(vbar.scrollSize).toBeGreaterThan(vbar.viewportSize)

  const mm = testSetup.mockMouse
  // Grab the thumb near the top of the track and drag it toward the bottom.
  await mm.pressDown(vbar.x, vbar.y)
  await mm.emitMouseEvent("drag", vbar.x, vbar.y + vbar.height - 1)
  await mm.release(vbar.x, vbar.y + vbar.height - 1)
  // Settle a couple of frames so the poll applies the thumb position.
  await testSetup.flush()
  await testSetup.flush()

  // The viewport scrolled down. (This edit buffer ties the viewport to the caret —
  // its own wheel scroll moves the caret too — so the scrollbar scrolls the same
  // way; the assertion is on the viewport, which is what the bar drives.)
  const vp = ta.editorView.getViewport()
  expect(vp.offsetY).toBeGreaterThan(0)
  // The bar mirrors the new offset.
  expect(vbar.scrollPosition).toBe(vp.offsetY)
})

test("the horizontal scrollbar sizes to the document-wide width when the widest line is below the viewport", async () => {
  const file = join(dir, "hbar-extent.ts")
  // 40 short lines then one 120-col line: the widest line sits far below the
  // initial viewport, so a visible-window measurement would under-report it.
  const wide = "x".repeat(120)
  const body = [...Array.from({ length: 40 }, () => "ab"), wide].join("\n")
  await writeFile(file, `${body}\n`)
  workbenchStore.openFile(file)

  // Wrap off is the only mode where the horizontal bar exists / is meaningful.
  testSetup = await render({ wordWrap: "none" })
  await waitForText("ab")

  // Bounded poll: the per-frame sync sizes the thumb from the document extent.
  const deadline = Date.now() + 3000
  let hbar = getScrollbar("editor-hscrollbar")
  while (Date.now() < deadline && !(hbar && hbar.scrollSize === 120)) {
    await testSetup.flush()
    await Bun.sleep(30)
    hbar = getScrollbar("editor-hscrollbar")
  }

  // Extent is the document-wide max width, not the visible window's — and at
  // scroll-top (widest line off-screen) the bar is still scrollable, not auto-hidden.
  expect(getTextarea().editorView.getViewport().offsetY).toBe(0)
  expect(hbar!.scrollSize).toBe(120)
  expect(hbar!.scrollSize).toBeGreaterThan(hbar!.viewportSize)
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
