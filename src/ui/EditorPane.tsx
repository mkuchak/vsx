import {
  getTreeSitterClient,
  ScrollBarRenderable,
  TextareaRenderable,
  type MouseEvent as CoreMouseEvent,
  type RenderContext,
  type ScrollBoxRenderable,
  type SimpleHighlight,
  type SyntaxStyle,
  type TextareaAction,
  type TextareaOptions,
} from "@opentui/core"
import { extend, useKeyboard, useRenderer } from "@opentui/react"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import {
  documentRegistry,
  FileTooLargeError,
  type Document,
} from "../model/documents"
import { workbenchStore } from "../model/workbench"
import * as clipboard from "../services/clipboard"
import { CURSOR_STYLE, getFindStyleIds, getSharedSyntaxStyle, theme } from "../theme"
import { createNativeOffsetConverter } from "./highlightOffsets"
import {
  consumePendingGoto,
  FIND_CURRENT_PRIORITY,
  FIND_CURRENT_REF,
  FIND_MATCH_PRIORITY,
  FIND_MATCH_REF,
  registerEditorControls,
  type EditorControls,
  type FindMatch,
} from "../workbench/editorControls"
import { useOverlay, useOverlayFocusRestore } from "../workbench/OverlayProvider"
import { getLastRendererSelection } from "../workbench/rendererSelection"
import { useWorkbenchStore } from "../workbench/useWorkbenchStore"
import "./ThinHScrollBar"

/**
 * VSCode `scrollBeyondLastLine` for the editor. The stock
 * `EditBufferRenderable.handleScroll` clamps wheel-down to
 * `maxOffsetY = totalVirtualLines - viewport.height`, pinning the last line to the
 * viewport bottom. This override lets the last line scroll all the way to the TOP
 * row (`maxOffsetY = totalVirtualLineCount - 1`), leaving blank rows below.
 * Everything else — scroll-up, horizontal scroll (only under wrap "none"), the
 * per-tick `delta`, and `moveCursor: true` (which drags the caret with the view so
 * the native cursor-driven re-derive keeps the overscrolled offset each frame) —
 * matches the original exactly.
 *
 * `scrollMargin` defaults to 0 here (VSCode cursorSurroundingLines=0): with the
 * stock 0.2 band the cursor-follow would push an overscrolled view back down every
 * frame, undoing the overscroll (and the margin would keep the caret 20% off the
 * edges when typing/navigating).
 */
class EditorTextareaRenderable extends TextareaRenderable {
  // `focused` isn't a TextareaOption — the built-in <textarea> JSX type adds it and
  // the reconciler applies it generically (focus()/blur() on any renderable). Widen
  // the option type so our intrinsic element accepts `focused` too; the extra key is
  // ignored by the base constructor and never reaches a setter.
  constructor(ctx: RenderContext, options: TextareaOptions & { focused?: boolean }) {
    super(ctx, { scrollMargin: 0, ...options })
  }

  /**
   * Apply a wheel event to the viewport with the overscroll-aware clamp. Public so
   * the gutter/scrollbar forward handlers (which receive scrolls the textarea's own
   * hit-tested dispatch never sees) reuse the exact same behavior. `forceHorizontal`
   * routes wheel up/down to left/right (the horizontal scrollbar's wheel); a Shift
   * modifier does the same anywhere (VSCode/browser convention). Horizontal scroll
   * stays gated on wrap "none" — the only mode the edit buffer scrolls horizontally.
   */
  applyScroll(event: CoreMouseEvent, forceHorizontal = false): void {
    if (!event.scroll) return
    let direction = event.scroll.direction
    const delta = event.scroll.delta
    if ((forceHorizontal || event.modifiers.shift) && (direction === "up" || direction === "down")) {
      direction = direction === "up" ? "left" : "right"
    }
    const view = this.editorView
    const viewport = view.getViewport()
    if (direction === "up") {
      const newOffsetY = Math.max(0, viewport.offsetY - delta)
      view.setViewport(viewport.offsetX, newOffsetY, viewport.width, viewport.height, true)
      this.requestRender()
    } else if (direction === "down") {
      // Overscroll only extends the range when the content actually overflows: an
      // overflowing buffer can scroll until the last line hits the TOP row
      // (offsetY = total - 1); a buffer that fits the viewport doesn't scroll at all
      // (matching VSCode — no phantom scroll/scrollbar for short files).
      const total = view.getTotalVirtualLineCount()
      const maxOffsetY = total > viewport.height ? total - 1 : 0
      const newOffsetY = Math.min(viewport.offsetY + delta, maxOffsetY)
      view.setViewport(viewport.offsetX, newOffsetY, viewport.width, viewport.height, true)
      this.requestRender()
    } else if (this.wrapMode === "none") {
      // This editor re-derives BOTH offsets from the caret each render, so the
      // horizontal offset needs the same caret-drag the vertical wheel relies on:
      // move the caret's COLUMN by the same delta so it keeps its screen column and
      // the caret-visibility re-derive leaves offsetX where we put it. (moveCursor=true
      // only drags the ROW, not the column — verified against 0.4.2 — so setViewport
      // alone snaps offsetX straight back; that is exactly why the stock horizontal
      // wheel "sometimes doesn't work depending on where the cursor is".) setCursor
      // clamps the column to the caret's line, so how far a wheel can scroll still
      // tracks that line's width — the inherent caret coupling, now driven not fought.
      const cursor = view.getCursor()
      const newOffsetX =
        direction === "left" ? Math.max(0, viewport.offsetX - delta) : viewport.offsetX + delta
      const newCol = direction === "left" ? Math.max(0, cursor.col - delta) : cursor.col + delta
      view.setViewport(newOffsetX, viewport.offsetY, viewport.width, viewport.height, false)
      this.setCursor(cursor.row, newCol)
      this.requestRender()
    }
  }

  protected override handleScroll(event: CoreMouseEvent): void {
    this.applyScroll(event)
    // Stop the wheel bubbling to the gutter parent, whose onMouseScroll ALSO forwards
    // scrolls here — without this a wheel directly over the text would scroll twice
    // (once natively here, once via the forwarder). See EditorTextarea's <line-number>.
    event.stopPropagation()
  }
}

// Neither is in @opentui/react's default component catalogue, so register them
// once at module load to make the elements valid. The module augmentation gives them
// typed intrinsic props. `<thin-hscrollbar>` (also used below) registers itself in
// ThinHScrollBar.ts — the side-effect import in this file's header is load-bearing.
declare module "@opentui/react" {
  interface OpenTUIComponents {
    scrollbar: typeof ScrollBarRenderable
    "editor-textarea-input": typeof EditorTextareaRenderable
  }
}
extend({
  scrollbar: ScrollBarRenderable,
  "editor-textarea-input": EditorTextareaRenderable,
})

export type CursorPosition = { line: number; column: number }

export type EditorPaneProps = {
  focused: boolean
  height?: number | `${number}%` | "auto"
  /** Render a specific group's content; defaults to the globally active group. */
  groupId?: string
  /** Workbench-wide word-wrap mode applied to the textarea; defaults to "word". */
  wordWrap?: "word" | "none"
  /** Fires with a 1-based line/column whenever the cursor moves. Status-bar hookup. */
  onCursorChange?: (pos: CursorPosition) => void
}

/** Bytes of an oversized file to show as a plain-text preview. */
const PREVIEW_BYTES = 100 * 1024

/** Tag shared by every highlight span we push, so a whole pass clears in one call. */
const HIGHLIGHT_REF = 1
/** Debounce window between an edit settling and the re-parse it triggers. */
const HIGHLIGHT_DEBOUNCE_MS = 160

/**
 * tree-sitter capture names are dotted/hierarchical (e.g. `"function.call"`) while
 * the shared theme (see {@link getSharedSyntaxStyle}) registers a mix of coarse
 * roots (`"function"`) and exact leaf names (`"markup.heading.1"`). Try the exact
 * name, then fall back to its first dot-segment; unregistered names yield `null`
 * (skip). Note the fallback only reaches the FIRST segment, so families that need
 * a distinct style per leaf enumerate every emitted name in SYNTAX_THEME.
 */
function resolveStyleId(syntaxStyle: SyntaxStyle, scopeName: string): number | null {
  const direct = syntaxStyle.getStyleId(scopeName)
  if (direct !== null) return direct
  const dot = scopeName.indexOf(".")
  if (dot > 0) return syntaxStyle.getStyleId(scopeName.slice(0, dot))
  return null
}

/**
 * `TreeSitterClient.highlightOnce` can hand back multiple captures spanning the
 * exact same `[start, end)` range — predicate-gated nvim-treesitter captures
 * (e.g. `(#lua-match? @type "^%u")`) leak through the worker unfiltered, so a
 * plain identifier like `hello` in `function hello() {}` can get `variable`,
 * `type`, `constant`, AND `function` all on the same span. Pushing every one of
 * those into `addHighlightByCharRange` at the same (default) priority leaves the
 * visually-winning color to an UNDEFINED native tie-break: empirically, the
 * native edit buffer does NOT reliably resolve equal-priority overlapping spans
 * on an identical range to either the first- or the last-added one (verified
 * with a throwaway probe against `EditBuffer`/`captureSpans` — the "winner"
 * varied with unrelated factors like styleId, not emission order), so relying
 * on native tie-break here would be fragile.
 *
 * OpenTUI's read-only `<code>` path (`treeSitterToTextChunks` in
 * `@opentui/core`) sidesteps this by resolving overlaps in JS: it sorts the
 * active captures by specificity (dot-segment count via `getSpecificity`) and
 * applies the most specific one last, breaking ties by emission index (later
 * wins). This mirrors that same rule, but only for EXACT duplicate ranges —
 * captures with different `[start, end)` bounds are left untouched and can
 * still legitimately overlap (nested spans), which is unrelated to this bug.
 */
function dedupeHighlightsByRange(highlights: SimpleHighlight[]): SimpleHighlight[] {
  const winners = new Map<string, { highlight: SimpleHighlight; specificity: number; index: number }>()
  highlights.forEach((highlight, index) => {
    const [start, end, scopeName] = highlight
    const key = `${start}:${end}`
    const specificity = scopeName.split(".").length
    const existing = winners.get(key)
    if (
      existing === undefined ||
      specificity > existing.specificity ||
      (specificity === existing.specificity && index > existing.index)
    ) {
      winners.set(key, { highlight, specificity, index })
    }
  })
  return [...winners.values()].map((w) => w.highlight)
}

/**
 * Not a real `TextareaAction` — deliberately absent from the native
 * `buildActionHandlers()` map (verified against the installed @opentui/core:
 * `handleKeyPress` looks up `this._actionHandlers.get(action)`, finds nothing,
 * and returns without side effects). Used below to fully disable the native
 * word-forward/backward bindings for Option/Ctrl+Left/Right, whose
 * `getNextWordBoundary`/`getPrevWordBoundary` land one character past the
 * true word boundary (see `nextWordBoundary`/`prevWordBoundary`, which
 * replace them).
 */
const DISABLE_NATIVE_ACTION = "vsx-disabled-noop" as TextareaAction

/**
 * The textarea's built-in undo/redo default to Ctrl+- / Ctrl+. (and super+z on
 * mac); add the familiar Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z. Merged over the
 * upstream defaults, so all built-in selection/word-nav bindings still apply.
 */
const EXTRA_KEY_BINDINGS: {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  action: TextareaAction
}[] = [
  { name: "z", ctrl: true, action: "undo" },
  { name: "z", ctrl: true, shift: true, action: "redo" },
  { name: "y", ctrl: true, action: "redo" },
  // Ctrl+A / Ctrl+E → VISUAL line home / end (custom bindings merge second, so they
  // win over OpenTUI's defaults). macOS terminals translate cmd+left → byte 0x01
  // (= Ctrl+A) and cmd+right → 0x05 (= Ctrl+E); without the kitty protocol they are
  // byte-identical to the ctrl chords, so these bindings ARE what cmd+left/right run
  // there. `visual-line-home`/`visual-line-end` go to the current visual row's
  // start/end and stay put on repeat — VSCode Home/End-under-wrap — overriding the
  // default `line-home`/`line-end` (whose emacs at-EOL toggle jumps ctrl+e to the
  // next line, the "cmd+right goes to the line below" complaint). Select-all is
  // deliberately NOT on Ctrl+A (that collision is why we reverted); it stays on the
  // built-in super+a → Cmd+A, live once the terminal forwards super (kitty protocol).
  { name: "a", ctrl: true, action: "visual-line-home" },
  { name: "e", ctrl: true, action: "visual-line-end" },
  { name: "a", ctrl: true, shift: true, action: "select-visual-line-home" },
  { name: "e", ctrl: true, shift: true, action: "select-visual-line-end" },
  // Disable the native meta+d/meta+backspace word-delete bindings (they share
  // getNextWordBoundary/getPrevWordBoundary with the word-nav actions above, so
  // the same off-by-one/multi-space bugs apply) — see the dedicated useKeyboard
  // handler below that replaces them with nextWordBoundary/prevWordBoundary.
  // ctrl+w and ctrl+backspace natively bind the same delete-word-backward action
  // and are equally buggy, but are deliberately left untouched: this task only
  // covers the Option+Backspace / Option+D convention.
  { name: "d", meta: true, action: DISABLE_NATIVE_ACTION },
  { name: "backspace", meta: true, action: DISABLE_NATIVE_ACTION },
  // Disable the native word-forward/backward bindings for Option/Ctrl+Left/Right
  // (plain move and shift-select) — see DISABLE_NATIVE_ACTION and the dedicated
  // useKeyboard handler below that replaces them with correct word-motion.
  { name: "right", meta: true, action: DISABLE_NATIVE_ACTION },
  { name: "left", meta: true, action: DISABLE_NATIVE_ACTION },
  { name: "right", ctrl: true, action: DISABLE_NATIVE_ACTION },
  { name: "left", ctrl: true, action: DISABLE_NATIVE_ACTION },
  { name: "right", meta: true, shift: true, action: DISABLE_NATIVE_ACTION },
  { name: "left", meta: true, shift: true, action: DISABLE_NATIVE_ACTION },
  { name: "right", ctrl: true, shift: true, action: DISABLE_NATIVE_ACTION },
  { name: "left", ctrl: true, shift: true, action: DISABLE_NATIVE_ACTION },
  // Option-as-Meta terminals (Terminal.app default, iTerm2 "Esc+", Alacritty/
  // Ghostty option-as-alt) send ESC b / ESC f for Option+Left/Right instead of
  // CSI `ESC[1;3D` — the parser turns those into {name:"b"/"f", meta:true},
  // which OpenTUI's own defaults bind to the SAME buggy native word-forward/
  // backward as meta+left/right. Disable them too so the word-nav handler below
  // (which now also recognizes meta+b/f) is what fires there.
  { name: "b", meta: true, action: DISABLE_NATIVE_ACTION },
  { name: "f", meta: true, action: DISABLE_NATIVE_ACTION },
  { name: "b", meta: true, shift: true, action: DISABLE_NATIVE_ACTION },
  { name: "f", meta: true, shift: true, action: DISABLE_NATIVE_ACTION },
]

/**
 * Keys that move the caret. The native `onCursorChange` prop only fires on the
 * edit buffer's `cursor-changed` event, and vertical navigation routes through
 * `editorView.moveUp/DownVisual` (the view pointer) which never emits it — so the
 * status bar's Ln/Col would stick after Up/Down/Home/End/PageUp/PageDown. A
 * focused editor re-reads its position after any of these (modifiers included).
 */
const CURSOR_NAV_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
])

/** Longest gap between mousedowns that still counts as the same multi-click gesture. */
const MULTI_CLICK_MS = 500

/** Character class used to grow a double-click into a whole word/run. */
function charClass(ch: string): "word" | "space" | "other" {
  if (/\s/.test(ch)) return "space"
  if (/[A-Za-z0-9_]/.test(ch)) return "word"
  return "other"
}

/**
 * The [start, end) column run of same-class characters containing `col` on `line`.
 * A click at/past end-of-line grabs the final run; an empty line yields an empty
 * range (caller falls back to a bare caret). Keeps the punctuation/whitespace case
 * simple — it selects the contiguous run of that class, not VSCode-exact tokens.
 */
function wordRangeAt(line: string, col: number): { start: number; end: number } {
  if (line.length === 0) return { start: 0, end: 0 }
  const probe = Math.min(col, line.length - 1)
  const cls = charClass(line[probe])
  let start = probe
  let end = probe + 1
  while (start > 0 && charClass(line[start - 1]) === cls) start--
  while (end < line.length && charClass(line[end]) === cls) end++
  return { start, end }
}

/**
 * The position one step past the end of the next word/punctuation run,
 * skipping any whitespace immediately ahead first — VSCode's Option+Right /
 * Ctrl+Right convention (`getNextWordBoundary` on the native `EditBuffer`
 * does NOT implement this correctly: verified it only advances one character
 * past the first word/whitespace transition rather than skipping the whole
 * whitespace run, e.g. landing mid-gap on "hello    world" instead of at
 * "world"'s start — see the word-nav useKeyboard handler that uses this).
 * Treats a line boundary as whitespace, so a jump at end-of-line crosses to
 * the next line, mirroring VSCode.
 */
function nextWordBoundary(lines: string[], row: number, col: number): { row: number; col: number } {
  let r = row
  let c = col
  while (true) {
    const line = lines[r] ?? ""
    if (c >= line.length) {
      if (r + 1 >= lines.length) return { row: r, col: line.length }
      r++
      c = 0
      continue
    }
    if (charClass(line[c]) !== "space") break
    c++
  }
  const line = lines[r] ?? ""
  const cls = charClass(line[c])
  while (c < line.length && charClass(line[c]) === cls) c++
  return { row: r, col: c }
}

/** The mirror image of {@link nextWordBoundary}, for Option+Left / Ctrl+Left. */
function prevWordBoundary(lines: string[], row: number, col: number): { row: number; col: number } {
  let r = row
  let c = col
  while (true) {
    if (c <= 0) {
      if (r <= 0) return { row: 0, col: 0 }
      r--
      c = (lines[r] ?? "").length
      continue
    }
    const line = lines[r] ?? ""
    if (charClass(line[c - 1]) !== "space") break
    c--
  }
  const line = lines[r] ?? ""
  const cls = charClass(line[c - 1])
  while (c > 0 && charClass(line[c - 1]) === cls) c--
  return { row: r, col: c }
}

type LoadState =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "ready"; doc: Document }
  | { kind: "too-large"; text: string; size: number }
  | { kind: "error"; message: string }

async function readPreview(path: string): Promise<string> {
  const slice = Bun.file(path).slice(0, PREVIEW_BYTES)
  return slice.text()
}

export function EditorPane({
  focused,
  height = "100%",
  groupId,
  wordWrap = "word",
  onCursorChange,
}: EditorPaneProps) {
  const state = useWorkbenchStore()
  const resolvedGroupId = groupId ?? state.activeGroupId
  const group = state.groups.find((g) => g.id === resolvedGroupId)
  const path = group?.activeTabPath ?? null

  const [load, setLoad] = useState<LoadState>({ kind: "empty" })
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0)

  // The too-large preview is a scrollbox that also loses native focus to an
  // overlay; restore it on overlay close when this pane is the focused one.
  const previewScrollRef = useRef<ScrollBoxRenderable | null>(null)
  useOverlayFocusRestore(previewScrollRef, focused && load.kind === "too-large")

  useEffect(() => {
    if (path === null) {
      setLoad({ kind: "empty" })
      return
    }

    let cancelled = false
    let acquired = false
    setLoad({ kind: "loading" })

    documentRegistry
      .openDocument(path)
      .then((doc) => {
        acquired = true
        // Unmounted before the open resolved: release the refcount we just took
        // instead of leaking it (cleanup already ran and skipped the release).
        if (cancelled) {
          acquired = false
          documentRegistry.releaseDocument(path)
          return
        }
        setLoad({ kind: "ready", doc })
      })
      .catch(async (err) => {
        if (cancelled) return
        if (err instanceof FileTooLargeError) {
          try {
            const text = await readPreview(path)
            if (!cancelled) setLoad({ kind: "too-large", text, size: err.size })
          } catch {
            if (!cancelled) setLoad({ kind: "error", message: "Could not read file" })
          }
          return
        }
        setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) })
      })

    return () => {
      cancelled = true
      // Only release a refcount we actually acquired; if the open hasn't resolved
      // yet, its resolution handler releases (see the `cancelled` check above).
      if (acquired) {
        acquired = false
        documentRegistry.releaseDocument(path)
      }
    }
  }, [path])

  useEffect(() => {
    if (load.kind !== "ready") return
    return load.doc.onDidChange(() => forceUpdate())
  }, [load])

  if (path === null || load.kind === "empty") {
    return (
      <box height={height} alignItems="center" justifyContent="center">
        <text fg={theme.dimForeground}>No file open</text>
      </box>
    )
  }

  if (load.kind === "loading") {
    return (
      <box height={height} alignItems="center" justifyContent="center">
        <text fg={theme.dimForeground}>Loading…</text>
      </box>
    )
  }

  if (load.kind === "error") {
    return (
      <box height={height} alignItems="center" justifyContent="center">
        <text fg={theme.error}>{load.message}</text>
      </box>
    )
  }

  if (load.kind === "too-large") {
    return (
      <box flexDirection="column" height={height}>
        <box height={1} paddingLeft={1} backgroundColor={theme.sidebarBackground}>
          <text fg={theme.warning}>File too large — showing a truncated preview</text>
        </box>
        <scrollbox ref={previewScrollRef} focused={focused} flexGrow={1}>
          <code content={load.text} syntaxStyle={getSharedSyntaxStyle()} />
        </scrollbox>
      </box>
    )
  }

  // Keyed by uri so switching files remounts with fresh `initialValue`.
  return (
    <EditorTextarea
      key={load.doc.uri}
      doc={load.doc}
      groupId={resolvedGroupId}
      focused={focused}
      height={height}
      wordWrap={wordWrap}
      onCursorChange={onCursorChange}
    />
  )
}

type EditorTextareaProps = {
  doc: Document
  /** Group this pane renders, so a user edit promotes the tab in THIS group. */
  groupId: string
  focused: boolean
  height: number | `${number}%` | "auto"
  wordWrap: "word" | "none"
  onCursorChange?: (pos: CursorPosition) => void
}

/**
 * The editable view over a Document. The `<textarea>` is uncontrolled — it owns a
 * native rope buffer seeded once from `initialValue` — so we bridge it to the
 * shared Document model by hand: user edits flow textarea → Document via
 * `onContentChange`, and external changes (disk/save) flow Document → textarea by
 * pushing text into the buffer on non-'edit' change events.
 */
function EditorTextarea({ doc, groupId, focused, height, wordWrap, onCursorChange }: EditorTextareaProps) {
  const renderer = useRenderer()
  const { isOverlayOpen } = useOverlay()
  const taRef = useRef<EditorTextareaRenderable | null>(null)
  const vScrollRef = useRef<ScrollBarRenderable | null>(null)
  const hScrollRef = useRef<ScrollBarRenderable | null>(null)
  const docRef = useRef(doc)
  docRef.current = doc
  // useKeyboard is a global subscription; this ref lets the handler act only
  // when THIS editor has focus (so split groups don't all copy at once).
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  // OpenTUI focus is singular: an overlay's <input focused> steals the native
  // focus away from this textarea, and closing it leaves focus null because this
  // pane's `focused` prop never changed. Re-focus imperatively on overlay close.
  useOverlayFocusRestore(taRef, focused)

  // Live tree-sitter highlighting for the editable buffer. OpenTUI only
  // auto-highlights read-only components (`<code>` etc.); the editable
  // EditBuffer has no `language` prop, so spans are pushed manually here.
  //
  // Uses TreeSitterClient.highlightOnce — a whole-buffer re-parse per debounce
  // tick, not the stateful incremental createBuffer/updateBuffer API. It is far
  // simpler to get correct and sufficient for the MVP; revisit with the
  // incremental API if large-file typing latency becomes a real problem.
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic id stamped when a request FIRES; a resolved request only applies
  // if it is still the latest, so a slow parse can't clobber a newer edit.
  const highlightReqId = useRef(0)

  const scheduleHighlight = useCallback(() => {
    // No known grammar (e.g. `.txt`/extensionless): leave it unhighlighted.
    const language = docRef.current.language
    if (language === undefined) return
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => {
      highlightTimer.current = null
      const ta = taRef.current
      if (!ta) return
      const text = ta.plainText
      const reqId = ++highlightReqId.current
      // Fire-and-forget: never block input, never throw out of a parse failure.
      getTreeSitterClient()
        .highlightOnce(text, language)
        .then((result) => {
          if (reqId !== highlightReqId.current) return // a newer edit won
          const editBuffer = taRef.current?.editBuffer
          if (!editBuffer) return
          const syntaxStyle = getSharedSyntaxStyle()
          editBuffer.removeHighlightsByRef(HIGHLIGHT_REF)
          // highlightOnce's spans are JS string (UTF-16) offsets; the highlight API
          // wants display-width columns excluding newlines — convert per span.
          const toNative = createNativeOffsetConverter(text)
          // TreeSitterClient.highlightOnce can emit multiple overlapping captures
          // for the exact same range (predicate-gated nvim-treesitter captures
          // leak through the worker unfiltered — e.g. an identifier can get
          // "variable", "type", "constant", AND "function" all spanning the same
          // [start, end)). Deduping to one winner per range up front means only
          // ONE addHighlightByCharRange call is ever made per range, so the
          // native buffer's undefined tie-break for equal-priority overlapping
          // spans never comes into play.
          for (const [start, end, scopeName] of dedupeHighlightsByRange(result.highlights ?? [])) {
            const styleId = resolveStyleId(syntaxStyle, scopeName)
            if (styleId === null) continue
            editBuffer.addHighlightByCharRange({
              start: toNative(start),
              end: toNative(end),
              styleId,
              hlRef: HIGHLIGHT_REF,
            })
          }
        })
        .catch(() => {
          // Best-effort: a failed parse just skips this round's highlights.
        })
    }, HIGHLIGHT_DEBOUNCE_MS)
  }, [])

  // Seed the buffer's SyntaxStyle (so pushed styleIds resolve to the same colors
  // as the read-only preview) and highlight the initial contents on mount.
  useEffect(() => {
    taRef.current?.editBuffer.setSyntaxStyle(getSharedSyntaxStyle())
    scheduleHighlight()
    return () => {
      if (highlightTimer.current) {
        clearTimeout(highlightTimer.current)
        highlightTimer.current = null
      }
      taRef.current?.editBuffer.removeHighlightsByRef(HIGHLIGHT_REF)
    }
  }, [scheduleHighlight])

  // Mirror the buffer into the Document. Wired to BOTH content- and
  // cursor-change: the native buffer's undo/redo repositions the cursor without
  // emitting a content-change event, so cursor-change is the only signal that
  // catches those reverts. The string compare makes redundant calls a no-op.
  const syncFromBuffer = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const text = ta.plainText
    if (text !== docRef.current.getText()) {
      docRef.current.setText(text, "edit")
      // This branch is a genuine LOCAL edit: inbound disk/save sync writes the
      // buffer to already match the Document, so it fails this compare and never
      // reaches here — meaning promotion fires only on real typing/paste/cut,
      // exactly as VSCode promotes a preview tab the moment you edit it.
      workbenchStore.promoteTabInGroup(groupId, docRef.current.uri)
      scheduleHighlight()
    }
  }, [scheduleHighlight, groupId])

  /**
   * The caret and selection as of the LAST report — read by shift+click, which
   * needs the state from BEFORE this mousedown: the renderer's selection bridge
   * has already moved the caret to the clicked cell AND reset the buffer
   * selection to an empty range there by the time the (bubbled) mousedown
   * reaches the app handler. The native cursor-changed echo of that move
   * arrives asynchronously, after the synchronous mouse dispatch, so these refs
   * still hold the pre-click state inside handleMouseDown.
   */
  const lastCaretRef = useRef<{ row: number; col: number } | null>(null)
  const lastSelectionRef = useRef<{ start: number; end: number } | null>(null)

  /**
   * The offset the LAST Option/Ctrl+Shift+Left/Right word-nav press set as the
   * moving (focus) end of the selection. `ta.setSelection()` does not move the
   * native caret `editorView.getCursor()` reads, so a chained press can't rely
   * on that to find where the previous press left off — this ref is the only
   * record of it. Only trusted if it still matches one end of the LIVE
   * selection (guards against a stale value from an unrelated mouse/click
   * selection change in between); otherwise the next press starts fresh from
   * the caret. Stored as the raw (possibly leftward) focus offset even though
   * the live selection is always written in sorted (min, max) order — the
   * match above is against whichever end it lands on, so sort order is moot.
   */
  const wordNavFocusRef = useRef<number | null>(null)

  // Status-bar hookup: report the 1-based line/column on every content- or
  // cursor-change. `editorView.getCursor()` is 0-based logical row/col. Always
  // records into the pre-click refs, even with no onCursorChange consumer.
  const reportCursor = useCallback(() => {
    const ta = taRef.current
    const cursor = ta?.editorView.getCursor()
    if (!ta || !cursor) return
    lastCaretRef.current = { row: cursor.row, col: cursor.col }
    const sel = ta.getSelection()
    lastSelectionRef.current = sel && sel.end > sel.start ? { start: sel.start, end: sel.end } : null
    onCursorChange?.({ line: cursor.row + 1, column: cursor.col + 1 })
  }, [onCursorChange])

  // Lets the effects/handlers that must re-report (nav keys, inbound clamp, the
  // go-to-line control) always call the LATEST reportCursor without listing it as
  // a dep — so they never re-subscribe / re-register just because it changed.
  const reportCursorRef = useRef(reportCursor)
  reportCursorRef.current = reportCursor

  const handleContentChange = useCallback(() => {
    syncFromBuffer()
    reportCursor()
  }, [syncFromBuffer, reportCursor])

  const handleCursorChange = useCallback(() => {
    syncFromBuffer()
    reportCursor()
  }, [syncFromBuffer, reportCursor])

  useEffect(() => {
    if (focused) reportCursor()
  }, [focused, reportCursor])

  useEffect(() => {
    return doc.onDidChange((e) => {
      // The focused pane owns the live edit; skipping its own 'edit' events keeps
      // the native cursor from resetting mid-type. An UNfocused pane viewing the
      // same Document (split view) must still apply edits so both panes stay in
      // sync. Disk/save changes always apply regardless of focus.
      if (e.source === "edit" && focusedRef.current) return
      const ta = taRef.current
      const nextText = doc.getText()
      if (!ta || ta.plainText === nextText) return
      // The change originates elsewhere (another split pane or disk/save), so
      // preserve THIS pane's view: `replaceText` keeps the buffer's undo history
      // (`setText` would wipe it — see EditBufferRenderable), and the cursor/scroll
      // are captured and restored so an external edit never yanks us to home.
      const cursor = ta.editorView.getCursor()
      const viewport = ta.editorView.getViewport()
      ta.replaceText(nextText)
      // Content may have shifted; clamp the restored cursor to the new bounds.
      const lines = nextText.split("\n")
      const row = Math.min(cursor.row, Math.max(0, lines.length - 1))
      const col = Math.min(cursor.col, lines[row]?.length ?? 0)
      ta.setCursor(row, col)
      ta.editorView.setViewport(viewport.offsetX, viewport.offsetY, viewport.width, viewport.height, false)
      // An external edit can shift/clamp the restored cursor; report the (possibly
      // new) position so the status bar reflects the clamp rather than going stale.
      reportCursorRef.current()
      scheduleHighlight()
    })
  }, [doc, scheduleHighlight])

  // Reads the clipboard (pbpaste) and inserts at the cursor, replacing any
  // active selection. Async so the pbpaste spawn never blocks the render loop.
  const pasteFromClipboard = useCallback(async () => {
    const text = await clipboard.read()
    if (!text) return
    const ta = taRef.current
    if (!ta) return
    if (ta.hasSelection()) ta.deleteSelection()
    ta.insertText(text)
    // The native mutation emits onContentChange, but sync explicitly too so the
    // Document (and re-highlight) update deterministically, not just via the event.
    syncFromBuffer()
  }, [syncFromBuffer])

  // TextareaAction is a closed union with no copy/cut/paste verbs, so these
  // can't be expressed as textarea keyBindings — intercept the keys directly.
  // Ctrl+C copies the selection (no-op without one), Ctrl+X copies then deletes
  // it, Ctrl+V pastes from our clipboard service. Ctrl+C only acts as copy
  // because main.tsx disables exitOnCtrlC; workbench.quit (Ctrl+Q) is the exit.
  useKeyboard((key) => {
    // An open overlay owns the keyboard; don't let clipboard keys leak into the
    // still-mounted (nominally focused) editor underneath it.
    if (isOverlayOpen) return
    if (!focusedRef.current || !key.ctrl || key.shift) return
    const ta = taRef.current
    if (!ta) return
    switch (key.name) {
      case "c": {
        // Prefer the focused buffer's own selection; otherwise fall back to the
        // last renderer-level selection (a drag over a diff/preview/panel that
        // never lands in an edit buffer). Copy-on-select usually already wrote
        // that text — this re-copy is harmless and idempotent.
        //
        // hasSelection() alone is NOT a reliable "there's text to copy" check: a
        // reversed offset range (start > end — can come from anywhere a
        // setSelection call isn't sorted) is stored verbatim, paints nothing,
        // and getSelectedText() returns "", yet hasSelection() still reports
        // true. Reading getSelectedText() up front and gating on non-empty text
        // means that pathological state falls through to the renderer-selection
        // fallback instead of clobbering the clipboard with "".
        const selectedText = ta.hasSelection() ? ta.getSelectedText() : ""
        if (selectedText !== "") {
          void clipboard.write(selectedText, renderer)
        } else {
          const rendererSelection = getLastRendererSelection()
          if (rendererSelection) void clipboard.write(rendererSelection, renderer)
        }
        break
      }
      case "x": {
        const selectedText = ta.hasSelection() ? ta.getSelectedText() : ""
        if (selectedText !== "") {
          void clipboard.write(selectedText, renderer)
          ta.deleteSelection()
          syncFromBuffer()
        }
        break
      }
      case "v":
        void pasteFromClipboard()
        break
    }
  })

  // VSCode's Alt+Up / Alt+Down (Option on macOS) moves the caret's line — or the
  // whole selected block of lines — up or down. TextareaAction has no line-swap
  // verb, so this is userland. The entire swap is applied through `replaceText`
  // (the buffer's only documented single-undo-point mutation, and the same
  // primitive the external-sync path uses) so ONE Ctrl+Z reverts the whole move.
  useKeyboard((key) => {
    if (isOverlayOpen) return
    if (!focusedRef.current) return
    // Alt-arrows arrive as CSI 1;3A/B, which the parser flags as both option and
    // meta; key on `option` and reject ctrl/shift so only a bare Alt+Up/Down fires.
    if (!key.option || key.ctrl || key.shift) return
    if (key.name !== "up" && key.name !== "down") return
    const ta = taRef.current
    if (!ta) return

    const dir = key.name === "up" ? -1 : 1
    const lines = ta.plainText.split("\n")
    const lastRow = lines.length - 1

    // Rows to move: a non-empty selection carries its whole block; otherwise just
    // the caret's line. VSCode excludes a trailing row the selection only touches
    // at column 0 (its newline isn't actually inside the selection).
    const selection = ta.getSelection()
    const hasSelection = selection !== null && selection.end > selection.start
    const startPos = hasSelection ? ta.editBuffer.offsetToPosition(selection.start) : null
    const endPos = hasSelection ? ta.editBuffer.offsetToPosition(selection.end) : null
    const cursor = ta.editorView.getCursor()

    let rowStart: number
    let rowEnd: number
    if (startPos && endPos) {
      rowStart = startPos.row
      rowEnd = endPos.row > startPos.row && endPos.col === 0 ? endPos.row - 1 : endPos.row
    } else {
      rowStart = cursor.row
      rowEnd = cursor.row
    }

    // At the document edge there's nowhere to swap: swallow the key (no beep).
    if (dir === -1 && rowStart === 0) return
    if (dir === 1 && rowEnd === lastRow) return

    // Splice the block out and reinsert it one row past the neighbor it swaps with.
    const block = lines.splice(rowStart, rowEnd - rowStart + 1)
    lines.splice(rowStart + dir, 0, ...block)
    const nextText = lines.join("\n")
    ta.replaceText(nextText)

    if (startPos && endPos) {
      // Both endpoints shift by the move distance; clamp to the new buffer bounds.
      const clamp = (o: number) => Math.max(0, Math.min(o, nextText.length))
      const newStart = clamp(ta.editBuffer.positionToOffset(startPos.row + dir, startPos.col))
      const newEnd = clamp(ta.editBuffer.positionToOffset(endPos.row + dir, endPos.col))
      ta.setSelection(newStart, newEnd)
    } else {
      // Sticky column: the caret's line moved intact (its length is unchanged), so
      // its own column is still valid — keep it at the same column on the moved line.
      ta.setCursor(rowStart + dir, cursor.col)
    }

    // replaceText updated the buffer; mirror it into the Document (dirty state, tab
    // promotion, re-highlight) and refresh the status bar's Ln/Col.
    syncFromBuffer()
    reportCursorRef.current()
  })

  // Option/Ctrl+Left/Right word navigation (plain move and Shift-select),
  // replacing the native word-forward/backward actions disabled above via
  // DISABLE_NATIVE_ACTION.
  //
  // Option-as-Meta terminals send ESC b / ESC f for Option+Left/Right, which
  // parse to {name:"b"/"f", meta:true} rather than {name:"left"/"right"} — so
  // b/f are accepted here as direction aliases, but ONLY when key.meta is set
  // (ctrl+b / ctrl+f must NOT trigger word-nav; they're unrelated bindings).
  // Deliberately unsupported (explicit product decision, not a bug to fix): a
  // SHIFTED Option+Left/Right on these terminals sends `ESC B` / `ESC F`, which
  // this parser turns into {name:"left"/"right", meta:true, shift:false,
  // option:false} — the shift flag is lost entirely, so shift+option+arrow acts
  // as a plain (non-selecting) word move there. Terminals wanting shift-select
  // word-nav need CSI/kitty keyboard encoding enabled.
  useKeyboard((key) => {
    if (isOverlayOpen) return
    if (!focusedRef.current) return
    const isRight = key.name === "right" || (key.meta && key.name === "f")
    const isLeft = key.name === "left" || (key.meta && key.name === "b")
    if (!isRight && !isLeft) return
    if (!key.meta && !key.ctrl) return
    const ta = taRef.current
    if (!ta) return

    const lines = ta.plainText.split("\n")

    if (key.shift) {
      const selection = ta.getSelection()
      const hasLiveSelection = selection !== null && selection.end > selection.start
      const remembered = wordNavFocusRef.current
      // Continue a chained press only if the live selection still has our last
      // focus offset as one of its ends; otherwise (first press of a new
      // selection, or the selection moved via a click/drag in between) start
      // fresh from the caret.
      const continuingChain =
        hasLiveSelection && remembered !== null && (remembered === selection!.start || remembered === selection!.end)
      const cursor = ta.editorView.getCursor()
      const focusPos = continuingChain ? ta.editBuffer.offsetToPosition(remembered!) : cursor
      if (!focusPos) return
      const anchorOffset = continuingChain
        ? remembered === selection!.start
          ? selection!.end
          : selection!.start
        : ta.editBuffer.positionToOffset(cursor.row, cursor.col)
      const target = isRight
        ? nextWordBoundary(lines, focusPos.row, focusPos.col)
        : prevWordBoundary(lines, focusPos.row, focusPos.col)
      const focusOffset = ta.editBuffer.positionToOffset(target.row, target.col)
      // setSelection does NOT normalize a reversed range (verified against the
      // native buffer): start > end paints nothing and getSelectedText() returns
      // "", yet hasSelection() still reports true — an invisible empty selection.
      // Selecting leftward puts focusOffset < anchorOffset, so sort explicitly;
      // wordNavFocusRef still stores the raw (unsorted) focus, since the chained-
      // press check above only cares which live-selection END it matches.
      ta.setSelection(Math.min(anchorOffset, focusOffset), Math.max(anchorOffset, focusOffset))
      wordNavFocusRef.current = focusOffset
    } else {
      const cursor = ta.editorView.getCursor()
      const target = isRight
        ? nextWordBoundary(lines, cursor.row, cursor.col)
        : prevWordBoundary(lines, cursor.row, cursor.col)
      ta.editorView.resetSelection()
      ta.setCursor(target.row, target.col)
      wordNavFocusRef.current = null
    }
    reportCursorRef.current()
  })

  // Option+Backspace / Option+D word-delete (VSCode convention), replacing the
  // native meta+backspace/meta+d delete-word-backward/forward actions disabled
  // above via DISABLE_NATIVE_ACTION — those share the same buggy boundary
  // functions as the native word-nav actions the handler above replaces.
  useKeyboard((key) => {
    if (isOverlayOpen) return
    if (!focusedRef.current) return
    if (!key.meta) return
    if (key.name !== "backspace" && key.name !== "d") return
    const ta = taRef.current
    if (!ta) return

    // A non-empty selection is already active: VSCode deletes just that,
    // ignoring word boundaries entirely.
    if (ta.hasSelection() && ta.getSelectedText() !== "") {
      ta.deleteSelection()
      syncFromBuffer()
      reportCursorRef.current()
      return
    }

    const lines = ta.plainText.split("\n")
    const cursor = ta.editorView.getCursor()
    const cursorOffset = ta.editBuffer.positionToOffset(cursor.row, cursor.col)
    const boundary =
      key.name === "backspace"
        ? prevWordBoundary(lines, cursor.row, cursor.col)
        : nextWordBoundary(lines, cursor.row, cursor.col)
    const boundaryOffset = ta.editBuffer.positionToOffset(boundary.row, boundary.col)
    // There's no TextareaAction for an arbitrary-range delete (same gap the
    // Ctrl+X handler works around above): select the [cursor, boundary) span,
    // then deleteSelection(). Same reversed-range hazard as every other
    // setSelection call in this file (backward delete puts boundaryOffset <
    // cursorOffset) — sort explicitly before handing it to setSelection.
    ta.setSelection(Math.min(cursorOffset, boundaryOffset), Math.max(cursorOffset, boundaryOffset))
    ta.deleteSelection()
    syncFromBuffer()
    reportCursorRef.current()
  })

  /**
   * A plain nav key (no shift/ctrl/meta/super/option) with an active selection
   * collapses the caret to the selection's edge — VSCode convention — instead
   * of moving relative to wherever the native caret happens to sit.
   *
   * OpenTUI has TWO selection stores. Native shift+arrow / mouse-drag
   * selections live in the renderer coordinator's `currentSelection`, and
   * native plain-move handlers clear it via `_ctx.clearSelection()`. But
   * `ta.setSelection(start, end)` — the offset API used everywhere else in
   * this file (word-nav shift-select, clicks, find-widget reveal) — never
   * populates that store, so those selections survive a plain arrow forever;
   * the highlight just stays painted. `hasSelection()` also lies true for an
   * empty inverted range (see the clipboard-guard comment above), so gate on
   * non-empty `getSelectedText()` too.
   */
  useKeyboard((key) => {
    if (isOverlayOpen) return
    if (!focusedRef.current) return
    if (key.shift || key.ctrl || key.meta || key.super || key.option) return
    if (!CURSOR_NAV_KEYS.has(key.name)) return
    const ta = taRef.current
    if (!ta) return
    if (!ta.hasSelection() || ta.getSelectedText() === "") return

    const selection = ta.getSelection()
    if (!selection) return
    const startPos = ta.editBuffer.offsetToPosition(selection.start)
    const endPos = ta.editBuffer.offsetToPosition(selection.end)
    if (!startPos || !endPos) return
    const isBackward = key.name === "left" || key.name === "up" || key.name === "home" || key.name === "pageup"
    const edge = isBackward ? startPos : endPos

    // ta.clearSelection() is the only method that resets BOTH the offset slot
    // (editorView.resetSelection) and the local/native slot (resetLocalSelection)
    // AND clears the renderer coordinator's currentSelection (via its own
    // `_ctx.clearSelection()` call) — the stale anchor a later native
    // shift+arrow would otherwise extend from if only the offset slot were reset.
    ta.clearSelection()
    ta.setCursor(edge.row, edge.col)
    // Left/Right: the collapse IS the whole move (VSCode convention), so consume
    // the key — otherwise the native handler would move one more step past the
    // edge we just landed on. Up/Down/Home/End/PageUp/PageDown: let native
    // motion continue from the now-collapsed caret (e.g. Down still moves a
    // line, it doesn't just collapse in place).
    if (key.name === "left" || key.name === "right") key.preventDefault()
    reportCursorRef.current()
  })

  // Belt-and-suspenders cursor reporting for keys the native onCursorChange path
  // misses (vertical/page/home-end navigation, and undo/redo which reposition the
  // caret). queueMicrotask defers past the synchronous key dispatch so the
  // textarea has already moved the caret before we read it. Report-only — this
  // never resyncs the buffer — so the extra call on top of the native path is cheap.
  useKeyboard((key) => {
    if (isOverlayOpen) return
    if (!focusedRef.current) return
    const isNav = CURSOR_NAV_KEYS.has(key.name)
    const isUndoRedo =
      ((key.ctrl || key.super) && (key.name === "z" || key.name === "y")) ||
      (key.ctrl && (key.name === "-" || key.name === "."))
    if (!isNav && !isUndoRedo) return
    queueMicrotask(() => reportCursorRef.current())
  })

  // Matches last painted by the find widget, so revealMatch can select the idx-th
  // without the widget re-sending the ranges. Lives in a ref (imperative side-channel).
  const findMatchesRef = useRef<FindMatch[]>([])

  // Expose this pane's cursor + find controls to the workbench chrome (Quick Open
  // go-to-line, the find widget). Native focus/scroll follow is handled on render;
  // overlay-close focus-restore returns keyboard focus to this textarea, so these
  // only position the cursor / paint highlights.
  useEffect(() => {
    const controls: EditorControls = {
      gotoLine: (line, column) => {
        const ta = taRef.current
        if (!ta) return
        const targetRow = Math.min(Math.max(0, line - 1), Math.max(0, ta.lineCount - 1))
        const lineText = ta.plainText.split("\n")[targetRow] ?? ""
        const targetCol = column === undefined ? 0 : Math.min(Math.max(0, column - 1), lineText.length)
        ta.setCursor(targetRow, targetCol)
        // setCursor on the view pointer doesn't emit the buffer's cursor-changed
        // event, so report explicitly to keep the status bar's Ln/Col in step.
        reportCursorRef.current()
      },
      getText: () => taRef.current?.plainText ?? "",
      getSelectedText: () => {
        const ta = taRef.current
        return ta?.hasSelection() ? ta.getSelectedText() : ""
      },
      setFindMatches: (matches, currentIdx) => {
        const ta = taRef.current
        if (!ta) return
        const eb = ta.editBuffer
        const { match, current } = getFindStyleIds()
        // Repaint from scratch each call; refs 2/3 are ours alone, so this never
        // touches the tree-sitter syntax spans (ref 1).
        eb.removeHighlightsByRef(FIND_MATCH_REF)
        eb.removeHighlightsByRef(FIND_CURRENT_REF)
        findMatchesRef.current = matches
        // findInFile's matches are JS string offsets into ta.plainText, same space
        // as tree-sitter's spans — same conversion applies before the highlight API.
        const toNative = createNativeOffsetConverter(ta.plainText)
        for (const m of matches) {
          eb.addHighlightByCharRange({
            start: toNative(m.start),
            end: toNative(m.end),
            styleId: match,
            hlRef: FIND_MATCH_REF,
            priority: FIND_MATCH_PRIORITY,
          })
        }
        const cur = matches[currentIdx]
        if (cur) {
          eb.addHighlightByCharRange({
            start: toNative(cur.start),
            end: toNative(cur.end),
            styleId: current,
            hlRef: FIND_CURRENT_REF,
            priority: FIND_CURRENT_PRIORITY,
          })
        }
      },
      revealMatch: (idx) => {
        const ta = taRef.current
        const m = findMatchesRef.current[idx]
        if (!ta || !m) return
        // Selecting the match parks the caret on it, so Esc (which restores focus
        // here) lands the caret at the current match — VSCode's behavior.
        ta.setSelection(m.start, m.end)
        // The find input holds native focus, so the buffer's caret-follow won't
        // scroll for us; nudge the viewport explicitly. The viewport (offsetY /
        // height) and setViewport work in VISUAL/virtual rows — the same units
        // syncScrollbars mirrors onto the scrollbars — while offsetToPosition
        // returns a LOGICAL row (newline-split, no wrap concept). Under word wrap
        // (the default) the two diverge, so the logical row MUST be mapped to its
        // visual row before comparing; comparing raw logical rows scrolled the
        // wrong direction whenever wrapped lines sat above the match.
        const pos = ta.editBuffer.offsetToPosition(m.start)
        if (!pos) return
        const view = ta.editorView
        // getLogicalLineInfo() spans the WHOLE document (it is the source
        // syncScrollbars reads for the scrollbar sizes); lineSources[v] is the
        // logical line of visual row v, so the first v with that source is the
        // match's visual row. Wrap-off yields an identity mapping, so this stays
        // correct in both wrap modes; -1 (info unavailable) falls back to logical.
        const visualRow = view.getLogicalLineInfo().lineSources.indexOf(pos.row)
        const targetRow = visualRow === -1 ? pos.row : visualRow
        const vp = view.getViewport()
        if (targetRow < vp.offsetY || targetRow >= vp.offsetY + vp.height) {
          const maxOffset = Math.max(0, view.getTotalVirtualLineCount() - vp.height)
          const targetY = Math.min(Math.max(0, targetRow - Math.floor(vp.height / 2)), maxOffset)
          view.setViewport(vp.offsetX, targetY, vp.width, vp.height, false)
        }
      },
      clearFind: () => {
        findMatchesRef.current = []
        const ta = taRef.current
        if (!ta) return
        ta.editBuffer.removeHighlightsByRef(FIND_MATCH_REF)
        ta.editBuffer.removeHighlightsByRef(FIND_CURRENT_REF)
      },
    }
    const dispose = registerEditorControls(groupId, controls)
    // A file just opened by the Search view (or any async opener) stashed a
    // reveal target keyed by this doc's path; now that the editor is mounted,
    // drain it and jump to the match. Nothing pending → a normal open.
    const pending = consumePendingGoto(doc.uri)
    if (pending) controls.gotoLine(pending.line, pending.column)
    return dispose
  }, [groupId, doc.uri])

  // Distinguishes single/double/triple clicks. A gesture continues only when the
  // pointer lands on the same cell (row exact, col within ±1) within MULTI_CLICK_MS;
  // otherwise it restarts at 1. 4+ clicks cycle back to 1.
  const clickTracker = useRef({ row: -1, col: -1, count: 0, time: 0 })

  /**
   * Active multi-click drag gesture: after a double(word)/triple(line) click,
   * dragging extends the selection in whole word/line units from the clicked
   * anchor unit (VSCode behavior). Armed on the multi-click mousedown, disarmed
   * on drag-end or the next plain mousedown.
   */
  const multiClickGesture = useRef<
    | { mode: "word"; anchorStart: number; anchorEnd: number }
    | { mode: "line"; anchorRow: number }
    | null
  >(null)

  // Mouse cursor positioning + word/line selection. The textarea's built-in
  // onMouseEvent only handles scroll; single-click caret placement and multi-click
  // selection are entirely app-level.
  const handleMouseDown = useCallback((event: CoreMouseEvent) => {
    const ta = taRef.current
    if (!ta) return
    const viewport = ta.editorView.getViewport()
    // A click BELOW the last content line is a complete no-op in the native
    // hit-testing (the caret doesn't move and getCursorPosition() stays STALE), so
    // detect it and derive the target ourselves — VSCode drops the caret on the last
    // line at the clicked column. This is common now that Task 1 lets blank space sit
    // below the content. The clicked VIRTUAL row is `event.y - ta.y + offsetY` (same
    // screen→content math handleMouseDrag uses); at/beyond the whole-buffer virtual
    // total it's a below-content click.
    let row: number
    let col: number
    const clickedVirtualRow = event.y - ta.y + viewport.offsetY
    if (clickedVirtualRow >= ta.editorView.getTotalVirtualLineCount()) {
      row = Math.max(0, ta.lineCount - 1)
      const lineLen = (ta.plainText.split("\n")[row] ?? "").length
      // ta.x already excludes the gutter; add the horizontal scroll only under wrap
      // "none" (the sole mode with offsetX). Under word wrap the last logical line may
      // span several visual rows — clamping the raw click x to the line length keeps
      // this a simple, VSCode-close first pass rather than resolving the exact visual row.
      const clickedCol = event.x - ta.x + (ta.wrapMode === "none" ? viewport.offsetX : 0)
      col = Math.max(0, Math.min(clickedCol, lineLen))
    } else {
      // In-content click: the renderer's selection machinery services this same
      // mousedown BEFORE this handler and has already moved the buffer cursor to the
      // clicked cell via native (wrap-aware) hit-testing. Read that position instead
      // of re-deriving screen→content coordinates, which would be wrong under wrap "word".
      ;({ row, col } = ta.editBuffer.getCursorPosition())
    }

    // Shift+click extends the selection from the pre-click caret (or the far end
    // of an existing selection) to the clicked cell — VSCode semantics. Never
    // participates in multi-click counting. Known deviation: a shift+DRAG after
    // this is taken over by the renderer's char-wise gesture anchored at the
    // click point (the gesture starts before this handler and can't be stopped
    // from userland), so the anchor migrates — plain shift+click is exact.
    if (event.modifiers.shift) {
      multiClickGesture.current = null
      clickTracker.current = { row, col, count: 1, time: Date.now() }
      const focusOffset = ta.editBuffer.positionToOffset(row, col)
      // The live buffer selection was already reset by the renderer's bridge on
      // this same mousedown — the pre-click selection lives in lastSelectionRef.
      const selection = lastSelectionRef.current
      let anchorOffset: number
      if (selection && selection.end > selection.start) {
        // Keep whichever end of the existing selection is farther from the click.
        anchorOffset =
          Math.abs(focusOffset - selection.start) >= Math.abs(focusOffset - selection.end)
            ? selection.start
            : selection.end
      } else {
        const prevCaret = lastCaretRef.current ?? { row, col }
        anchorOffset = ta.editBuffer.positionToOffset(prevCaret.row, prevCaret.col)
      }
      if (anchorOffset !== focusOffset) ta.setSelection(anchorOffset, focusOffset)
      reportCursorRef.current()
      return
    }

    const now = Date.now()
    const prev = clickTracker.current
    const sameSpot = row === prev.row && Math.abs(col - prev.col) <= 1
    const count =
      sameSpot && now - prev.time <= MULTI_CLICK_MS ? (prev.count % 3) + 1 : 1
    clickTracker.current = { row, col, count, time: now }

    const lines = ta.plainText.split("\n")
    if (count === 2) {
      const { start, end } = wordRangeAt(lines[row] ?? "", col)
      if (end > start) {
        const anchorStart = ta.editBuffer.positionToOffset(row, start)
        const anchorEnd = ta.editBuffer.positionToOffset(row, end)
        multiClickGesture.current = { mode: "word", anchorStart, anchorEnd }
        ta.setSelection(anchorStart, anchorEnd)
      } else {
        // Same rationale as the single-click branch below: buffer-only reset,
        // never `clearSelection()` (it aborts the renderer's live drag gesture).
        multiClickGesture.current = null
        ta.editorView.resetSelection()
        ta.setCursor(row, col)
      }
    } else if (count === 3) {
      // Whole line INCLUDING its trailing newline; the last line (no newline) ends
      // at end-of-line instead.
      const startOffset = ta.editBuffer.positionToOffset(row, 0)
      const endOffset =
        row + 1 < ta.lineCount
          ? ta.editBuffer.positionToOffset(row + 1, 0)
          : ta.editBuffer.positionToOffset(row, (lines[row] ?? "").length)
      if (endOffset > startOffset) {
        multiClickGesture.current = { mode: "line", anchorRow: row }
        ta.setSelection(startOffset, endOffset)
      } else {
        multiClickGesture.current = null
        ta.setCursor(row, col)
      }
    } else {
      // Single click. The renderer's mousedown clears only the *local* (drag)
      // selection, not the buffer selection, so a prior word/line selection would
      // linger — reset the BUFFER selection only, then place the caret.
      //
      // Deliberately NOT `ta.clearSelection()`: that also invokes the renderer's
      // own clearSelection (via the render context), aborting the drag-selection
      // gesture the renderer armed on this very mousedown — which killed all
      // mouse drag-selection. `editorView.resetSelection()` clears just the
      // buffer selection and leaves the in-flight gesture alive.
      multiClickGesture.current = null
      ta.editorView.resetSelection()
      ta.setCursor(row, col)
    }
    reportCursorRef.current()
  }, [])

  /**
   * Word-/line-wise drag extension for an active multi-click gesture. On every
   * drag event the renderer's selection bridge FIRST re-applies a char-wise
   * selection anchored at the last mousedown, THEN dispatches the drag to this
   * renderable (same-event ordering, verified in the 0.4.2 dispatch) — so the
   * unit-snapped setSelection here always wins the frame. Selection is the hull
   * of the anchor unit and the unit under the pointer, recomputed per event, so
   * it grows AND shrinks as the pointer moves (VSCode behavior). Plain char-wise
   * drags (no multi-click gesture) are left entirely to the renderer.
   */
  const handleMouseDrag = useCallback((event: CoreMouseEvent) => {
    const gesture = multiClickGesture.current
    const ta = taRef.current
    if (!gesture || !ta) return
    const viewport = ta.editorView.getViewport()
    const lines = ta.plainText.split("\n")
    const row = Math.max(
      0,
      Math.min(event.y - ta.y + viewport.offsetY, ta.lineCount - 1),
    )
    const lineText = lines[row] ?? ""
    const col = Math.max(0, Math.min(event.x - ta.x + viewport.offsetX, lineText.length))

    if (gesture.mode === "word") {
      const focusWord = wordRangeAt(lineText, col)
      // On whitespace/punctuation (empty word range) the pointer cell itself is
      // the focus unit, so the selection still reaches the pointer.
      const focusStart = ta.editBuffer.positionToOffset(
        row,
        focusWord.end > focusWord.start ? focusWord.start : col,
      )
      const focusEnd = ta.editBuffer.positionToOffset(
        row,
        focusWord.end > focusWord.start ? focusWord.end : col,
      )
      ta.setSelection(
        Math.min(gesture.anchorStart, focusStart),
        Math.max(gesture.anchorEnd, focusEnd),
      )
    } else {
      const startRow = Math.min(gesture.anchorRow, row)
      const endRow = Math.max(gesture.anchorRow, row)
      const startOffset = ta.editBuffer.positionToOffset(startRow, 0)
      const endOffset =
        endRow + 1 < ta.lineCount
          ? ta.editBuffer.positionToOffset(endRow + 1, 0)
          : ta.editBuffer.positionToOffset(endRow, lines[endRow]?.length ?? 0)
      ta.setSelection(startOffset, endOffset)
    }
    reportCursorRef.current()
  }, [])

  const handleMouseDragEnd = useCallback(() => {
    multiClickGesture.current = null
  }, [])

  // Wheel routing (OpenTUI dispatches scroll hit-test-first and only bubbles to
  // PARENTS, and only the textarea has a scroll handler — so a wheel over the gutter
  // or either scrollbar does nothing on its own). Forward those to the textarea's
  // overscroll-aware applyScroll. The textarea's own handleScroll calls
  // stopPropagation, so a wheel directly over the text never reaches the gutter
  // forwarder below (no double-scroll). Shift→horizontal is handled inside applyScroll.
  const forwardScroll = useCallback((event: CoreMouseEvent) => {
    taRef.current?.applyScroll(event)
  }, [])
  // The horizontal bar maps a plain vertical wheel to horizontal scroll — where users
  // most expect the wheel to move the content sideways.
  const forwardScrollHorizontal = useCallback((event: CoreMouseEvent) => {
    taRef.current?.applyScroll(event, true)
  }, [])

  // Apply the workbench word-wrap setting to the live buffer. `wrapMode` is a
  // runtime setter on the edit buffer (drives editorView.setWrapMode and marks
  // layout dirty, no remount), so a toggle re-lays-out the current text in place.
  // Runs on mount too, which just re-affirms the default "word".
  useEffect(() => {
    const ta = taRef.current
    if (ta) ta.wrapMode = wordWrap
  }, [wordWrap])

  // Keep the scrollbars and the editor viewport in step. The edit buffer emits NO
  // scroll/viewport event — wheel and caret-follow fire nothing — so, like
  // OpenTUI's own gutter, we poll each rendered frame via setFrameCallback.
  //
  // We deliberately DON'T use the bar's onChange: a thumb drag updates the bar's
  // own `scrollPosition`, and we detect that here by comparing it to both the live
  // viewport and the value we last reflected. A user-driven divergence is applied
  // to the viewport; otherwise we mirror the viewport onto the bar.
  //
  // Scroll is applied with moveCursor=TRUE. This OpenTUI edit buffer ties the
  // viewport to the caret — its own wheel scroll uses moveCursor=true, and a
  // moveCursor=false setViewport issued from a frame callback is undone by the
  // ensuing render — so true is the only offset that actually sticks. The caret
  // travels with the view exactly as it does when you wheel-scroll.
  const lastReflected = useRef({ y: -1, x: -1 })
  const syncScrollbars = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const view = ta.editorView
    let vp = view.getViewport()

    // Only treat a thumb move as a user drag when the bar is actually scrollable
    // (content overflows). When it fits, ScrollBar clamps scrollPosition to a
    // negative `scrollSize - viewportSize`, which must never be mistaken for a drag.
    const vBar = vScrollRef.current
    const vScrollable = vBar !== null && vBar.scrollSize > vBar.viewportSize
    if (vScrollable && vBar!.scrollPosition !== vp.offsetY && vBar!.scrollPosition !== lastReflected.current.y) {
      view.setViewport(vp.offsetX, vBar!.scrollPosition, vp.width, vp.height, true)
      vp = view.getViewport()
    }
    const hBar = hScrollRef.current
    const hScrollable = hBar !== null && hBar.scrollSize > hBar.viewportSize
    if (hScrollable && hBar!.scrollPosition !== vp.offsetX && hBar!.scrollPosition !== lastReflected.current.x) {
      view.setViewport(hBar!.scrollPosition, vp.offsetY, vp.width, vp.height, true)
      vp = view.getViewport()
    }

    if (vBar) {
      // Overscroll allowance (VSCode scrollBeyondLastLine): an overflowing buffer now
      // scrolls until the last line sits at the TOP row (max offsetY = total - 1).
      // ScrollBar clamps scrollPosition to `scrollSize - viewportSize`, so pad
      // scrollSize by `height - 1` for the thumb to reach that max instead of the old
      // bottom-pinned `total - height`. Only when the content overflows — a buffer
      // that fits keeps scrollSize == total so the bar still auto-hides.
      const totalLines = view.getTotalVirtualLineCount()
      const total = totalLines + (totalLines > vp.height ? vp.height - 1 : 0)
      if (vBar.scrollSize !== total) vBar.scrollSize = total
      if (vBar.viewportSize !== vp.height) vBar.viewportSize = vp.height
      if (vBar.scrollPosition !== vp.offsetY) vBar.scrollPosition = vp.offsetY
      lastReflected.current.y = vp.offsetY
    }
    if (hBar) {
      const maxCols = view.getLogicalLineInfo().lineWidthColsMax
      if (hBar.scrollSize !== maxCols) hBar.scrollSize = maxCols
      if (hBar.viewportSize !== vp.width) hBar.viewportSize = vp.width
      if (hBar.scrollPosition !== vp.offsetX) hBar.scrollPosition = vp.offsetX
      lastReflected.current.x = vp.offsetX
    }
  }, [])

  // Per-frame poll (see above). setFrameCallback is the renderer's sanctioned
  // frame hook; the cleanup removes it so an unmounted pane leaves nothing behind.
  useEffect(() => {
    const frame = async () => {
      syncScrollbars()
    }
    renderer.setFrameCallback(frame)
    return () => renderer.removeFrameCallback(frame)
  }, [renderer, syncScrollbars])

  // Gutter width. The built-in `<line-number>` sizes its width from
  // `target.virtualLineCount`, but for an editable buffer that getter reports the
  // *visible* line count, not the document total — so left to itself the gutter
  // under-sizes and clips multi-digit numbers once you scroll down. `minWidth` is
  // the only lever (there is no post-mount setter), so we floor it to the document's
  // real digit count: digits + one padding col each side. Computed once per mounted
  // Document (this pane is keyed by uri); a mid-session cross of a digit boundary
  // (e.g. growing a 99-line file to 100) won't widen until reopen — a rare, cosmetic
  // deviation not worth remounting the textarea (and losing its undo/cursor) over.
  const gutterMinWidth = useMemo(
    () => Math.max(3, String(doc.getText().split("\n").length).length + 2),
    [doc],
  )

  return (
    <box flexDirection="column" height={height}>
      {/* row: [ gutter+textarea column (+ horizontal bar), vertical bar ] */}
      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" flexGrow={1}>
          <line-number
            flexGrow={1}
            minWidth={gutterMinWidth}
            fg={theme.dimForeground}
            bg={theme.background}
            onMouseScroll={forwardScroll}
          >
            <editor-textarea-input
              id="editor-textarea"
              ref={taRef}
              focused={focused}
              initialValue={doc.getText()}
              keyBindings={EXTRA_KEY_BINDINGS}
              onContentChange={handleContentChange}
              onCursorChange={handleCursorChange}
              onMouseDown={handleMouseDown}
              onMouseDrag={handleMouseDrag}
              onMouseDragEnd={handleMouseDragEnd}
              flexGrow={1}
              textColor={theme.foreground}
              backgroundColor={theme.background}
              cursorStyle={CURSOR_STYLE}
            />
          </line-number>
          {/* Horizontal wheel-scroll only works with wrap off, so the bar is
              meaningful (and shown) only then. */}
          {wordWrap === "none" && (
            <thin-hscrollbar
              id="editor-hscrollbar"
              ref={hScrollRef}
              orientation="horizontal"
              height={1}
              flexShrink={0}
              onMouseScroll={forwardScrollHorizontal}
              trackOptions={{
                backgroundColor: theme.scrollbarTrack,
                foregroundColor: theme.scrollbarThumb,
              }}
            />
          )}
        </box>
        <scrollbar
          id="editor-vscrollbar"
          ref={vScrollRef}
          orientation="vertical"
          width={1}
          flexShrink={0}
          onMouseScroll={forwardScroll}
          trackOptions={{
            width: 1,
            backgroundColor: theme.scrollbarTrack,
            foregroundColor: theme.scrollbarThumb,
          }}
        />
      </box>
    </box>
  )
}
