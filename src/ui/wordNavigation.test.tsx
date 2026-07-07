/**
 * REGRESSION: the native `EditBuffer.getNextWordBoundary`/`getPrevWordBoundary`
 * (behind the default TextareaAction "word-forward"/"word-backward", bound to
 * Option/Ctrl+Left/Right) only advance one character past the first
 * word/whitespace class transition instead of skipping the whole separator
 * run — e.g. on "hello    world" (4 spaces) it lands mid-gap rather than at
 * "world"'s start, and on the common single-space case it overshoots into the
 * next word instead of stopping at the end of the current one. EditorPane.tsx
 * disables those bindings (DISABLE_NATIVE_ACTION) and replaces them with
 * `nextWordBoundary`/`prevWordBoundary`, exercised here against a REAL
 * textarea (not a stub) so a regression in the replacement is caught the same
 * way a stubbed test would have missed the original bug.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { workbenchStore } from "../model/workbench"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { EditorPane } from "./EditorPane"
import type { TextareaRenderable } from "@opentui/core"

let testSetup: Awaited<ReturnType<typeof testRender>>
let dir: string

beforeEach(async () => {
  workbenchStore.reset()
  dir = await mkdtemp(join(tmpdir(), "vsx-verify-"))
})

afterEach(async () => {
  if (testSetup) testSetup.renderer.destroy()
  workbenchStore.reset()
  await rm(dir, { recursive: true, force: true })
})

function getTextarea() {
  return testSetup.renderer.root.findDescendantById("editor-textarea") as unknown as TextareaRenderable
}

async function waitForText(text: string) {
  const start = Date.now()
  while (Date.now() - start < 3000) {
    await testSetup.flush()
    if (testSetup.captureCharFrame().includes(text)) return
    await Bun.sleep(30)
  }
  throw new Error("timeout")
}

async function setup(text: string) {
  const file = join(dir, "v.ts")
  await writeFile(file, text)
  workbenchStore.openFile(file)
  testSetup = await testRender(
    <OverlayProvider>
      <EditorPane focused />
    </OverlayProvider>,
    { width: 60, height: 12 },
  )
  await waitForText(text.split("\n")[0]!.slice(0, 5) || " ")
  return getTextarea()
}

/**
 * `mockInput.pressArrow` can only emit CSI modifier sequences (`ESC[1;3D`),
 * never the raw `ESC b` / `ESC f` an Option-as-Meta terminal sends for
 * Option+Left/Right — so those two bytes are injected directly into the
 * renderer's stdin, exactly as `createMockKeys` itself does under the hood
 * (see @opentui/core/testing.js: every key press is `renderer.stdin.emit(
 * "data", Buffer.from(...))`).
 */
async function pressEscMeta(letter: "b" | "f") {
  ;(testSetup.renderer as unknown as { stdin: { emit: (event: string, data: Buffer) => void } }).stdin.emit(
    "data",
    Buffer.from(`\x1b${letter}`),
  )
  await testSetup.flush()
}

test("single space: option+right stops right after word, not consuming the space", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 5 })
  testSetup.mockInput.pressArrow("right", { meta: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 11 })
})

test("multi-space run is fully skipped, not just one extra char", async () => {
  const ta = await setup("hello    world\n") // 4 spaces
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 5 })
  testSetup.mockInput.pressArrow("right", { meta: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 14 }) // end of "world", all spaces skipped
})

test("option+left mirrors option+right exactly", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 15) // end of "foo"
  await testSetup.flush()
  testSetup.mockInput.pressArrow("left", { meta: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 12 }) // start of "foo"
  testSetup.mockInput.pressArrow("left", { meta: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 6 }) // start of "world"
})

test("option+shift+right selects exactly the word, no trailing space", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("hello")
})

test("option+shift+right twice grows the selection (anchor stays fixed)", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true, shift: true })
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("hello world")
})

test("option+shift+left after growing right shrinks the selection back", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true, shift: true })
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("hello world")
  testSetup.mockInput.pressArrow("left", { meta: true, shift: true })
  await testSetup.flush()
  // Word-left stops at the START of "world" (not back at word-right's
  // stopping point, the END of "hello") — the same right/left asymmetry
  // VSCode itself has, not a bug.
  expect(ta.getSelectedText()).toBe("hello ")
})

test("ctrl+right/left also uses the fixed word-motion", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { ctrl: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 5 })
})

test("option+right at end of line crosses into the next line", async () => {
  const ta = await setup("foo\nbar\n")
  ta.setCursor(0, 3) // end of "foo"
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true })
  await testSetup.flush()
  expect(ta.editorView.getCursor()).toEqual({ row: 1, col: 3 }) // end of "bar"
})

/**
 * REGRESSION: OpenTUI's offset `setSelection(start, end)` does no normalization
 * — a reversed range (start > end) is stored verbatim, paints nothing, and
 * `getSelectedText()` returns "" even though `hasSelection()` reports true. The
 * FIRST press of a leftward word-select computes `focusOffset < anchorOffset`,
 * so without sorting the range before calling setSelection this selection is
 * invisible. These tests assert on `getSelectedText()`, not the cursor — offset
 * setSelection never moves the caret.
 */
test("first-press option+shift+left selects the previous word (not an invisible empty range)", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 15) // end of "foo"
  await testSetup.flush()
  testSetup.mockInput.pressArrow("left", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("foo")
})

test("chained option+shift+left presses grow the selection leftward", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 15) // end of "foo"
  await testSetup.flush()
  testSetup.mockInput.pressArrow("left", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("foo")
  testSetup.mockInput.pressArrow("left", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("world foo")
})

test("option+shift+left then option+shift+right shrinks the leftward selection back", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 15) // end of "foo"
  await testSetup.flush()
  testSetup.mockInput.pressArrow("left", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("foo")
  testSetup.mockInput.pressArrow("right", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("")
})

test("option+shift+left crosses a line boundary and selects the previous line's last word", async () => {
  const ta = await setup("foo\nbar\n")
  ta.setCursor(1, 0) // start of "bar"
  await testSetup.flush()
  testSetup.mockInput.pressArrow("left", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("foo\n")
})

/**
 * REGRESSION: Option-as-Meta terminals (Terminal.app default, iTerm2 "Esc+",
 * Alacritty/Ghostty option-as-alt) send raw `ESC b` / `ESC f` for Option+Left/
 * Right instead of a CSI modifier sequence — the parser turns those into
 * {name:"b"/"f", meta:true}, NOT {name:"left"/"right"}. Without recognizing
 * b/f as direction aliases (gated on key.meta), OpenTUI's own default binding
 * for meta+b/f would fire the buggy native word-backward/forward instead.
 */
test("ESC f from col 0 lands at the end of the first word, not one past it", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await pressEscMeta("f")
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 5 })
})

test("ESC b from the end of the buffer lands at the start of the last word", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 15) // end of "foo"
  await pressEscMeta("b")
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 12 })
})

test("ESC b crosses a multi-space gap in one press, no per-space crawling", async () => {
  const ta = await setup("hello    world\n") // 4 spaces
  ta.setCursor(0, 9) // start of "world"
  await pressEscMeta("b")
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 0 })
})

/**
 * REGRESSION: the native meta+backspace/meta+d bindings share
 * getNextWordBoundary/getPrevWordBoundary with the native word-nav actions
 * (same off-by-one / multi-space bugs) — replaced here with
 * nextWordBoundary/prevWordBoundary via an explicit setSelection+deleteSelection,
 * exercised against a REAL textarea so a regression is caught the same way.
 */
test("option+backspace deletes exactly the previous word, leaving the trailing space", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 15) // end of "foo"
  await testSetup.flush()
  testSetup.mockInput.pressBackspace({ meta: true })
  await testSetup.flush()
  expect(ta.plainText).toBe("hello world \n")
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 12 })
})

test("option+backspace across a multi-space gap deletes the whole run, not one char", async () => {
  const ta = await setup("hello    world\n") // 4 spaces
  ta.setCursor(0, 9) // start of "world"
  await testSetup.flush()
  testSetup.mockInput.pressBackspace({ meta: true })
  await testSetup.flush()
  expect(ta.plainText).toBe("world\n")
})

test("option+d deletes the next word but not the following space", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressKey("d", { meta: true })
  await testSetup.flush()
  expect(ta.plainText).toBe(" world foo\n")
})

test("option+backspace from col 0 joins lines back to the previous line's last word start", async () => {
  const ta = await setup("hello world\nfoo\n")
  ta.setCursor(1, 0) // start of "foo"
  await testSetup.flush()
  testSetup.mockInput.pressBackspace({ meta: true })
  await testSetup.flush()
  expect(ta.plainText).toBe("hello foo\n")
})

test("option+backspace deletes an active selection instead of computing a word boundary", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { shift: true })
  testSetup.mockInput.pressArrow("right", { shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("he")
  testSetup.mockInput.pressBackspace({ meta: true })
  await testSetup.flush()
  expect(ta.plainText).toBe("llo world foo\n")
})

test("ctrl+z undoes an option+backspace word-delete in one step", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 15) // end of "foo"
  await testSetup.flush()
  testSetup.mockInput.pressBackspace({ meta: true })
  await testSetup.flush()
  expect(ta.plainText).toBe("hello world \n")
  testSetup.mockInput.pressKey("z", { ctrl: true })
  await testSetup.flush()
  expect(ta.plainText).toBe("hello world foo\n")
})

/**
 * REGRESSION: OpenTUI has TWO selection stores. Native plain-move handlers
 * only clear the renderer coordinator's `currentSelection` (populated by
 * native shift+arrow / mouse-drag), never the offset-API selection made by
 * `ta.setSelection(...)` — used by word-nav shift-select, clicks, and the
 * find widget. Without the collapse handler, a plain arrow leaves that
 * highlight painted forever. These assert on `getSelectedText()`/`hasSelection()`
 * and the collapsed cursor position, per VSCode convention: Left/Up → the
 * selection's START, Right/Down → its END.
 */
test("plain right after an option+shift+right word-selection collapses to the selection's end", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("hello")
  testSetup.mockInput.pressArrow("right")
  await testSetup.flush()
  expect(ta.hasSelection()).toBe(false)
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 5 })
})

test("plain left after the same word-selection collapses to the selection's start, unmoved", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("hello")
  testSetup.mockInput.pressArrow("left")
  await testSetup.flush()
  expect(ta.hasSelection()).toBe(false)
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 0 })
})

test("plain down after a word-selection collapses to the end, then moves down a line", async () => {
  const ta = await setup("hello world foo\nsecond line\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { meta: true, shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("hello")
  testSetup.mockInput.pressArrow("down")
  await testSetup.flush()
  expect(ta.hasSelection()).toBe(false)
  expect(ta.editorView.getCursor().row).toBe(1)
})

test("plain up after a directly-forced offset selection collapses to the start, then moves up a line", async () => {
  const ta = await setup("first line\nsecond line\n")
  ta.setCursor(1, 0)
  await testSetup.flush()
  // Force an offset selection the way clicks / find-reveal do (not via keyboard).
  ta.setSelection(0, 5) // "first"
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("first")
  testSetup.mockInput.pressArrow("up")
  await testSetup.flush()
  expect(ta.hasSelection()).toBe(false)
  expect(ta.editorView.getCursor()).toEqual({ row: 0, col: 0 })
})

test("native shift+arrow selection still extends normally and is not broken by the collapse handler", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  testSetup.mockInput.pressArrow("right", { shift: true })
  testSetup.mockInput.pressArrow("right", { shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("he")
})

test("collapsing a selection does not leave a stale anchor for the next shift+arrow", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 0)
  await testSetup.flush()
  // Native select-word-forward twice: a keyboard-made (renderer-coordinator)
  // selection, same store the collapse handler must fully clear.
  testSetup.mockInput.pressArrow("right", { shift: true })
  testSetup.mockInput.pressArrow("right", { shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText()).toBe("he")
  testSetup.mockInput.pressArrow("right") // collapse (our handler)
  await testSetup.flush()
  expect(ta.hasSelection()).toBe(false)
  const collapsedCol = ta.editorView.getCursor().col
  // A fresh shift+right must select exactly one char from the collapsed caret,
  // not a range stretching back to the old (stale) anchor.
  testSetup.mockInput.pressArrow("right", { shift: true })
  await testSetup.flush()
  expect(ta.getSelectedText().length).toBe(1)
  expect(ta.editorView.getCursor().col).toBe(collapsedCol + 1)
})

test("a plain arrow with a pathological inverted (empty-text) selection does not throw", async () => {
  const ta = await setup("hello world foo\n")
  ta.setCursor(0, 5)
  await testSetup.flush()
  ta.setSelection(10, 4) // reversed: hasSelection() true, getSelectedText() ""
  expect(ta.hasSelection()).toBe(true)
  expect(ta.getSelectedText()).toBe("")
  // The collapse handler bails out (guarded on getSelectedText() !== ""), so
  // this key is NOT prevented and falls through to native handling — which
  // still reads the native hasSelection() (populated by the pathological
  // offset selection) and teleports the caret per its own pre-existing
  // caret-collapse quirk. That native behavior is out of scope here; the only
  // contract this test guards is that our handler doesn't throw or otherwise
  // misbehave on this state.
  expect(() => testSetup.mockInput.pressArrow("right")).not.toThrow()
  await testSetup.flush()
  const cursor = ta.editorView.getCursor()
  expect(cursor.row).toBe(0)
  expect(typeof cursor.col).toBe("number")
})
