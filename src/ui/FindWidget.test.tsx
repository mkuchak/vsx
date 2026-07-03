import type { Renderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { documentRegistry } from "../model/documents"
import { workbenchStore } from "../model/workbench"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { EditorGroups } from "./EditorGroups"
import { FindWidget } from "./FindWidget"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined
let dir: string

beforeEach(async () => {
  workbenchStore.reset()
  dir = await mkdtemp(join(tmpdir(), "vsx-find-"))
})

afterEach(async () => {
  testSetup?.renderer.destroy()
  testSetup = undefined
  workbenchStore.reset()
  await rm(dir, { recursive: true, force: true })
})

function collect(root: Renderable, pred: (r: Renderable) => boolean): Renderable[] {
  const out: Renderable[] = []
  const walk = (node: Renderable) => {
    if (pred(node)) out.push(node)
    for (const child of node.getChildren()) walk(child)
  }
  walk(root)
  return out
}

function textarea(): TextareaRenderable {
  const [node] = collect(testSetup!.renderer.root, (r) => r.id === "editor-textarea")
  if (!node) throw new Error("no editor textarea mounted")
  return node as unknown as TextareaRenderable
}

function frame(): string {
  return testSetup!.captureCharFrame()
}

/**
 * Let the mock stdin flush a prior keystroke before the next one. Two identical
 * keys fired back-to-back (e.g. Enter then Enter) can otherwise coalesce in the
 * byte stream before the parser sees them as distinct events.
 */
async function settle() {
  await testSetup!.flush()
  await Bun.sleep(30)
  await testSetup!.flush()
}

async function render(dims = { width: 80, height: 12 }) {
  testSetup = await testRender(
    <OverlayProvider>
      <CommandsProvider>
        <box width={dims.width} height={dims.height} position="relative">
          <EditorGroups />
          <FindWidget />
        </box>
      </CommandsProvider>
    </OverlayProvider>,
    dims,
  )
  return testSetup
}

async function waitForFrame(text: string, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await testSetup!.flush()
    if (frame().includes(text)) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for "${text}"\n${frame()}`)
}

/**
 * Poll until the editor's buffer selection starts at `start`. The selection is
 * driven synchronously through refs (revealMatch → setSelection), so it is the
 * reliable signal for "the current match moved" — the "N of M" text in the frame
 * lags a React commit behind and is only asserted where a specific count matters.
 */
async function waitForSelectionStart(start: number, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await testSetup!.flush()
    if (textarea().getSelection()?.start === start) return
    await Bun.sleep(20)
  }
  throw new Error(`selection.start never became ${start}; got ${JSON.stringify(textarea().getSelection())}`)
}

/** Poll until the renderable with `id` holds native focus. */
async function waitForFocus(id: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await testSetup!.flush()
    if (testSetup!.renderer.currentFocusedRenderable?.id === id) return
    await Bun.sleep(20)
  }
  throw new Error(`focus never landed on "${id}"; on "${testSetup!.renderer.currentFocusedRenderable?.id}"`)
}

/** Open a file in the active group and wait for its editor to render. */
async function openFile(name: string, content: string, dims?: { width: number; height: number }) {
  const file = join(dir, name)
  await writeFile(file, content)
  const doc = await documentRegistry.openDocument(file)
  workbenchStore.openFile(file, { preview: false })
  await render(dims)
  await waitForFrame(content.split("\n")[0]!.slice(0, 6))
  return { file, doc }
}

/**
 * Poll until the given match text's VISUAL row sits inside the editor viewport.
 * The visual row is derived from the match's logical row through the SAME
 * document-wide lineInfo the reveal uses, so this is the reliable check that a
 * reveal actually scrolled the match on screen — under word wrap (the default),
 * logical and visual rows diverge and a logical-row comparison is meaningless.
 */
async function waitForMatchVisible(text: string, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs
  let detail = "(match text never found)"
  while (Date.now() < deadline) {
    await testSetup!.flush()
    const ta = textarea()
    const offset = ta.plainText.indexOf(text)
    if (offset >= 0) {
      const pos = ta.editBuffer.offsetToPosition(offset)
      if (pos) {
        const visualRow = ta.editorView.getLogicalLineInfo().lineSources.indexOf(pos.row)
        const vp = ta.editorView.getViewport()
        detail = `visualRow=${visualRow} offsetY=${vp.offsetY} height=${vp.height}`
        if (visualRow >= 0 && visualRow >= vp.offsetY && visualRow < vp.offsetY + vp.height) return
      }
    }
    await Bun.sleep(20)
  }
  throw new Error(`match "${text}" never entered the viewport: ${detail}`)
}

/**
 * Press Ctrl+F and wait until the find <input> has actually taken native focus —
 * the focus transition needs a tick, and typing before it lands leaks the first
 * keystrokes into the editor buffer.
 */
async function openFind() {
  testSetup!.mockInput.pressKey("f", { ctrl: true })
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    await testSetup!.flush()
    if (testSetup!.renderer.currentFocusedRenderable?.id === "find-input") return
    await Bun.sleep(20)
  }
  throw new Error("find input never took focus")
}

test("Ctrl+F opens the bar and typing renders the 'N of M' match count", async () => {
  await openFile("count.ts", "foo bar foo baz foo\n")

  await openFind()
  await testSetup!.mockInput.typeText("foo")
  await waitForFrame("1 of 3")

  expect(frame()).toContain("1 of 3")
})

test("Enter and the arrow keys cycle matches (wrap-around) and move the selection", async () => {
  const { doc } = await openFile("cycle.ts", "foo and foo and foo\n")

  await openFind()
  await testSetup!.mockInput.typeText("foo")
  // Gate on the count so the matches are painted and the first one revealed before
  // we start cycling. Matches sit at offsets 0, 8, 16.
  await waitForFrame("1 of 3")
  await waitForSelectionStart(0)
  expect(textarea().getSelectedText()).toBe("foo")

  // Enter → next match.
  await settle()
  testSetup!.mockInput.pressEnter()
  await waitForSelectionStart(8)

  // ↓ (routed through the keymap layer, since the focused input swallows arrows)
  // → next; wrapping from the last match back to the first.
  await settle()
  testSetup!.mockInput.pressArrow("down")
  await waitForSelectionStart(16)
  await settle()
  testSetup!.mockInput.pressArrow("down")
  await waitForSelectionStart(0)

  // ↑ → previous, wrapping to the last match.
  await settle()
  testSetup!.mockInput.pressArrow("up")
  await waitForSelectionStart(16)

  // Buffer text untouched by find.
  expect(doc.getText()).toBe("foo and foo and foo\n")
})

test("a match beyond the viewport scrolls into view", async () => {
  // 40 lines; the only match sits near the bottom, well past a 12-row viewport.
  const lines = Array.from({ length: 40 }, (_, i) => (i === 30 ? "NEEDLE here" : `line ${i}`))
  await openFile("scroll.ts", `${lines.join("\n")}\n`)
  const ta = textarea()
  expect(ta.editorView.getViewport().offsetY).toBe(0)

  await openFind()
  await testSetup!.mockInput.typeText("NEEDLE")
  await waitForFrame("1 of 1")

  // revealMatch nudged the viewport down toward the match's row (~30).
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && ta.editorView.getViewport().offsetY === 0) {
    await testSetup!.flush()
    await Bun.sleep(20)
  }
  expect(ta.editorView.getViewport().offsetY).toBeGreaterThan(0)
})

test("Esc closes the bar, returns focus to the editor with the caret on the match", async () => {
  const { file, doc } = await openFile("esc.ts", "alpha target omega\n")
  const ta = textarea()

  await openFind()
  await testSetup!.mockInput.typeText("target")
  await waitForFrame("1 of 1")
  await waitForSelectionStart(6)
  expect(ta.getSelection()).toEqual({ start: 6, end: 12 })

  testSetup!.mockInput.pressEscape()
  // Focus returns to the editor (the overlay-close focus-restore effect).
  await waitForFocus("editor-textarea")

  // The bar is gone.
  expect(frame()).not.toContain("Aa")

  // The caret is on the current match, so typing replaces it (the selection
  // revealMatch set survives the close) — and proves keys now land in the buffer.
  await testSetup!.mockInput.typeText("X")
  await testSetup!.flush()
  await Bun.sleep(30)
  await testSetup!.flush()
  expect(ta.plainText).toBe("alpha X omega\n")
  expect(doc.getText()).toBe("alpha X omega\n")

  documentRegistry.releaseDocument(file)
})

test("closing removes the find highlights (refs 2 and 3)", async () => {
  await openFile("clear.ts", "keep keep keep\n")
  const ta = textarea()
  const eb = ta.editBuffer as unknown as { removeHighlightsByRef: (ref: number) => void }

  await openFind()
  await testSetup!.mockInput.typeText("keep")
  await waitForFrame("1 of 3")

  // Spy AFTER matches are painted so we capture the close-time clears.
  const cleared: number[] = []
  const original = eb.removeHighlightsByRef.bind(eb)
  eb.removeHighlightsByRef = (ref: number) => {
    cleared.push(ref)
    original(ref)
  }

  testSetup!.mockInput.pressEscape()
  await testSetup!.flush()
  await Bun.sleep(30)
  await testSetup!.flush()

  expect(cleared).toContain(2) // FIND_MATCH_REF
  expect(cleared).toContain(3) // FIND_CURRENT_REF
})

test("an edit to the buffer while the bar is open recomputes the count", async () => {
  const { doc } = await openFile("edit.ts", "hit and hit\n")

  await openFind()
  await testSetup!.mockInput.typeText("hit")
  await waitForFrame("1 of 2")

  // Simulate an external edit (disk/save) adding another occurrence. EditorTextarea
  // applies it to the buffer regardless of focus; the widget's Document subscription
  // then recomputes against the updated text.
  doc.setText("hit and hit and hit\n", "disk")
  await waitForFrame("1 of 3")

  expect(frame()).toContain("1 of 3")
})

test("reveals a match under word wrap by scrolling to its VISUAL row (regression)", async () => {
  // Word wrap is the default. A narrow pane makes each long line above the match
  // wrap into ~10 visual rows, so the match's VISUAL row is far below the viewport
  // while its LOGICAL row (4) stays small. The pre-fix reveal compared the logical
  // row against the visual viewport, concluded "already visible" (4 < height), and
  // never scrolled — leaving the match off-screen. (Red pre-fix: waitForMatchVisible
  // times out because the viewport never moves.)
  const long = "lorem ipsum dolor sit ".repeat(20).trim()
  const content = `${long}\n${long}\n${long}\n${long}\nZZNEEDLEZZ tail\n`
  await openFile("wrap-reveal.ts", content, { width: 40, height: 12 })
  const ta = textarea()
  expect(ta.editorView.getViewport().offsetY).toBe(0)

  await openFind()
  await testSetup!.mockInput.typeText("NEEDLE")
  // The match is selected (search ran), then its wrapped-visual row is on screen.
  await waitForSelectionStart(ta.plainText.indexOf("NEEDLE"))
  await waitForMatchVisible("ZZNEEDLEZZ")
})

test("reveals an earlier match by scrolling UP under word wrap (regression)", async () => {
  // UPNEEDLE sits at logical row 1 but a heavily-wrapped line above it pushes its
  // visual row down; DOWNNEEDLE is far below. Navigate down to DOWNNEEDLE then back
  // up to UPNEEDLE — the up-scroll must map logical→visual or it lands short and
  // leaves UPNEEDLE off-screen.
  const long = "lorem ipsum dolor sit ".repeat(20).trim()
  const content = [long, "UPNEEDLE here", long, long, long, "DOWNNEEDLE here", ""].join("\n")
  await openFile("wrap-up.ts", content, { width: 40, height: 12 })

  await openFind()
  await testSetup!.mockInput.typeText("NEEDLE")
  await waitForMatchVisible("UPNEEDLE")

  await settle()
  testSetup!.mockInput.pressEnter() // → DOWNNEEDLE
  await waitForMatchVisible("DOWNNEEDLE")

  await settle()
  testSetup!.mockInput.pressEnter() // wraps → UPNEEDLE (scrolls back up)
  await waitForMatchVisible("UPNEEDLE")
})

test("an external shrink below a match clears stale find highlights and updates the count", async () => {
  const { doc } = await openFile("shrink.ts", "target one\ntarget two\ntarget three\n")
  const ta = textarea()

  await openFind()
  await testSetup!.mockInput.typeText("target")
  await waitForFrame("1 of 3")

  // Spy the ref-clears AFTER the initial paint, so we capture the on-edit clears.
  const eb = ta.editBuffer as unknown as { removeHighlightsByRef: (ref: number) => void }
  const cleared: number[] = []
  const original = eb.removeHighlightsByRef.bind(eb)
  eb.removeHighlightsByRef = (ref: number) => {
    cleared.push(ref)
    original(ref)
  }

  // Shrink the buffer far below the previous match offsets. The onDidChange hook
  // must synchronously drop find's ref-2/3 spans (so none linger past the new end)
  // before the debounced recompute repaints the single surviving match.
  doc.setText("target\n", "disk")
  await waitForFrame("1 of 1")

  expect(cleared).toContain(2) // FIND_MATCH_REF cleared synchronously on edit
  expect(cleared).toContain(3) // FIND_CURRENT_REF cleared synchronously on edit
  expect(frame()).toContain("1 of 1")
})

test("reopening the bar does not flash the previous match count", async () => {
  await openFile("reopen.ts", "alpha alpha alpha\n")

  await openFind()
  await testSetup!.mockInput.typeText("alpha")
  await waitForFrame("1 of 3")

  testSetup!.mockInput.pressEscape()
  await waitForFocus("editor-textarea")
  // Collapse the selection so the reopen seeds an EMPTY query — then the only way
  // "of 3" could appear is a stale, un-reset match count from the prior session.
  testSetup!.mockInput.pressKey("HOME")
  await testSetup!.flush()

  // Reopen and render exactly one frame (well under the ~90ms recompute debounce):
  // close() reset the match state, so no stale "1 of 3" is painted.
  testSetup!.mockInput.pressKey("f", { ctrl: true })
  await testSetup!.flush()
  expect(frame()).not.toContain("of 3")
})
