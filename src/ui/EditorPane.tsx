import {
  getTreeSitterClient,
  ScrollBarRenderable,
  SyntaxStyle,
  type MouseEvent as CoreMouseEvent,
  type ScrollBoxRenderable,
  type TextareaAction,
  type TextareaRenderable,
  type ThemeTokenStyle,
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
import { theme } from "../theme"
import { registerEditorControls } from "../workbench/editorControls"
import { useOverlay, useOverlayFocusRestore } from "../workbench/OverlayProvider"
import { getLastRendererSelection } from "../workbench/rendererSelection"
import { useWorkbenchStore } from "../workbench/useWorkbenchStore"

// ScrollBarRenderable isn't in @opentui/react's default component catalogue, so
// register it once at module load to make `<scrollbar>` a valid element. The
// module augmentation gives it typed intrinsic props (orientation, trackOptions…).
declare module "@opentui/react" {
  interface OpenTUIComponents {
    scrollbar: typeof ScrollBarRenderable
  }
}
extend({ scrollbar: ScrollBarRenderable })

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

/**
 * VSCode "Dark+"-ish tree-sitter token colors. `<code>`/`<line-number>` require a
 * SyntaxStyle even for the unhighlighted fallback, so one shared instance backs both.
 */
const SYNTAX_THEME: ThemeTokenStyle[] = [
  { scope: ["keyword", "keyword.control", "conditional", "repeat"], style: { foreground: "#c586c0" } },
  { scope: ["string", "string.special"], style: { foreground: "#ce9178" } },
  { scope: ["comment"], style: { foreground: "#6a9955", italic: true } },
  { scope: ["function", "function.call", "function.method"], style: { foreground: "#dcdcaa" } },
  { scope: ["type", "type.builtin", "constructor"], style: { foreground: "#4ec9b0" } },
  { scope: ["number", "constant", "constant.builtin", "boolean"], style: { foreground: "#b5cea8" } },
  { scope: ["variable", "variable.parameter"], style: { foreground: "#9cdcfe" } },
  { scope: ["property"], style: { foreground: "#9cdcfe" } },
  { scope: ["operator", "punctuation", "punctuation.delimiter", "punctuation.bracket"], style: { foreground: "#d4d4d4" } },
  { scope: ["tag"], style: { foreground: "#569cd6" } },
  { scope: ["attribute"], style: { foreground: "#9cdcfe" } },
]

let sharedSyntaxStyle: SyntaxStyle | undefined
function getSyntaxStyle(): SyntaxStyle {
  if (!sharedSyntaxStyle) sharedSyntaxStyle = SyntaxStyle.fromTheme(SYNTAX_THEME)
  return sharedSyntaxStyle
}

/** Tag shared by every highlight span we push, so a whole pass clears in one call. */
const HIGHLIGHT_REF = 1
/** Debounce window between an edit settling and the re-parse it triggers. */
const HIGHLIGHT_DEBOUNCE_MS = 160

/**
 * tree-sitter capture names are dotted/hierarchical (e.g. `"function.call"`) but
 * SYNTAX_THEME only registers coarse roots (`"function"`). Try the exact name,
 * then fall back to its first dot-segment; unregistered names yield `null` (skip).
 */
function resolveStyleId(syntaxStyle: SyntaxStyle, scopeName: string): number | null {
  const direct = syntaxStyle.getStyleId(scopeName)
  if (direct !== null) return direct
  const dot = scopeName.indexOf(".")
  if (dot > 0) return syntaxStyle.getStyleId(scopeName.slice(0, dot))
  return null
}

/**
 * The textarea's built-in undo/redo default to Ctrl+- / Ctrl+. (and super+z on
 * mac); add the familiar Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z. Merged over the
 * upstream defaults, so all built-in selection/word-nav bindings still apply.
 */
const EXTRA_KEY_BINDINGS: {
  name: string
  ctrl?: boolean
  shift?: boolean
  action: TextareaAction
}[] = [
  { name: "z", ctrl: true, action: "undo" },
  { name: "z", ctrl: true, shift: true, action: "redo" },
  { name: "y", ctrl: true, action: "redo" },
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
          <code content={load.text} syntaxStyle={getSyntaxStyle()} />
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
  const taRef = useRef<TextareaRenderable | null>(null)
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
          const syntaxStyle = getSyntaxStyle()
          editBuffer.removeHighlightsByRef(HIGHLIGHT_REF)
          for (const [start, end, scopeName] of result.highlights ?? []) {
            const styleId = resolveStyleId(syntaxStyle, scopeName)
            if (styleId === null) continue
            editBuffer.addHighlightByCharRange({ start, end, styleId, hlRef: HIGHLIGHT_REF })
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
    taRef.current?.editBuffer.setSyntaxStyle(getSyntaxStyle())
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
      case "c":
        // Prefer the focused buffer's own selection; otherwise fall back to the
        // last renderer-level selection (a drag over a diff/preview/panel that
        // never lands in an edit buffer). Copy-on-select usually already wrote
        // that text — this re-copy is harmless and idempotent.
        if (ta.hasSelection()) {
          void clipboard.write(ta.getSelectedText(), renderer)
        } else {
          const rendererSelection = getLastRendererSelection()
          if (rendererSelection) void clipboard.write(rendererSelection, renderer)
        }
        break
      case "x":
        if (ta.hasSelection()) {
          void clipboard.write(ta.getSelectedText(), renderer)
          ta.deleteSelection()
          syncFromBuffer()
        }
        break
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

  // Expose this pane's cursor to the workbench chrome (Quick Open go-to-line).
  // Native focus/scroll follow is handled on render; overlay-close focus-restore
  // returns keyboard focus to this textarea, so gotoLine only positions the cursor.
  useEffect(() => {
    return registerEditorControls(groupId, {
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
    })
  }, [groupId])

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
    // The renderer's selection machinery services this same mousedown BEFORE this
    // handler and has already moved the buffer cursor to the clicked cell via native
    // (wrap-aware) hit-testing. Read that position instead of re-deriving
    // screen→content coordinates, which would be wrong under wrapMode "word".
    const { row, col } = ta.editBuffer.getCursorPosition()

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
      const total = view.getTotalVirtualLineCount()
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
          <line-number flexGrow={1} minWidth={gutterMinWidth} fg={theme.dimForeground} bg={theme.background}>
            <textarea
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
            />
          </line-number>
          {/* Horizontal wheel-scroll only works with wrap off, so the bar is
              meaningful (and shown) only then. */}
          {wordWrap === "none" && (
            <scrollbar
              id="editor-hscrollbar"
              ref={hScrollRef}
              orientation="horizontal"
              height={1}
              flexShrink={0}
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
