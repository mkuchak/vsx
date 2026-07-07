import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { Binding, Command } from "@opentui/keymap"
import { useKeyboard } from "@opentui/react"
import { basename, relative } from "node:path"
import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { workbenchStore } from "../model/workbench"
import { searchWorkspace, type SearchResult } from "../services/search"
import { CURSOR_STYLE, theme } from "../theme"
import { useCommands } from "../workbench/CommandsProvider"
import { getEditorControls, requestGoto } from "../workbench/editorControls"
import { useOverlay } from "../workbench/OverlayProvider"

type Toggles = { matchCase: boolean; wholeWord: boolean; regex: boolean }

/** Debounce before the query/toggles re-run the workspace search as you type. */
const SEARCH_DEBOUNCE_MS = 250

/** One toggle cell (Match Case / Whole Word / Regex), clickable to flip. */
function ToggleCell({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  return (
    <box
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={active ? theme.accent : undefined}
      onMouseDown={onToggle}
    >
      <text fg={active ? theme.accentForeground : theme.dimForeground}>{label}</text>
    </box>
  )
}

/** Bold the matched span of a preview line; the rest renders dimmed-normal. */
function highlightPreview(preview: string, range: [number, number] | null): ReactNode {
  if (!range) return preview
  const [start, end] = range
  return (
    <>
      {preview.slice(0, start)}
      <strong>{preview.slice(start, end)}</strong>
      {preview.slice(end)}
    </>
  )
}

type Row =
  | { type: "file"; id: string; path: string; count: number }
  | { type: "match"; id: string; path: string; line: number; col: number; length: number; preview: string }
  | { type: "truncated"; id: string }

function buildRows(result: SearchResult | null, collapsed: Set<string>): Row[] {
  if (!result) return []
  const rows: Row[] = []
  for (const file of result.files) {
    rows.push({ type: "file", id: `file::${file.path}`, path: file.path, count: file.matches.length })
    if (collapsed.has(file.path)) continue
    for (const m of file.matches) {
      rows.push({
        type: "match",
        id: `match::${file.path}::${m.line}::${m.col}`,
        path: file.path,
        line: m.line,
        col: m.col,
        length: m.length,
        preview: m.preview,
      })
    }
  }
  if (result.truncated) rows.push({ type: "truncated", id: "truncated" })
  return rows
}

export type SearchPanelProps = {
  workspaceRoot: string
  focused: boolean
  /** Total match cap forwarded to the service; small values let tests hit "truncated". */
  maxResults?: number
}

/**
 * VSCode "Search" view: a query input + match-case/whole-word/regex toggles over
 * a results tree grouped by file. Search runs as you type (VSCode parity — the
 * user's call), debounced ~250ms so the heavier workspace scan fires once you
 * pause rather than per-keystroke; toggling a mode re-runs on the same debounce.
 * Enter bypasses the debounce for an immediate run (habit + a manual refresh). A
 * stale run is cancelled via the service's cooperative signal when a newer one
 * starts or the panel unmounts, so out-of-order results never flash.
 *
 * Focus model (a focused <input> swallows arrow keys): the input owns typing and
 * Enter (run search). ↓ or Tab from the input hands focus to the results LIST,
 * where this panel's own useKeyboard drives ↑/↓/Enter and ←/→ collapse. ↑ past
 * the top row returns focus to the input; Esc leaves the sidebar entirely (the
 * app-wide sidebar→editor handler), matching the other panels.
 *
 * Opening a match uses the pending-goto handshake: openFile is async (the editor
 * mounts after the doc loads), so we stash the target line via requestGoto and
 * the freshly-mounted editor drains it — an immediate gotoLine would no-op.
 */
export function SearchPanel({ workspaceRoot, focused, maxResults }: SearchPanelProps) {
  const commands = useCommands()
  const { isOverlayOpen } = useOverlay()

  const [query, setQuery] = useState("")
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selectedIndex, setSelectedIndex] = useState(0)
  // false = the input owns the keyboard; true = the results list does.
  const [listMode, setListMode] = useState(false)

  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const mountedRef = useRef(true)
  // The in-flight run's cancellation signal and a monotonic id, so a slow search
  // whose results arrive after a newer run (or after unmount) is discarded.
  const signalRef = useRef<{ cancelled: boolean }>({ cancelled: false })
  const runIdRef = useRef(0)
  // The single pending debounced search from a query/toggle change. Held in a ref
  // (not effect-local) so Enter can flush it: clearing it before an immediate run
  // stops a late timer from re-spawning the same search a beat after Enter did.
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Live mirrors so the keymap layer + useKeyboard read current values without
  // re-subscribing every render.
  const queryRef = useRef(query)
  queryRef.current = query
  const optsRef = useRef<Toggles>({ matchCase, wholeWord, regex })
  optsRef.current = { matchCase, wholeWord, regex }

  const rows = useMemo(() => buildRows(result, collapsed), [result, collapsed])
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Leaving the view cancels any in-flight scan.
      signalRef.current.cancelled = true
    }
  }, [])

  const runSearch = useCallback(() => {
    // Supersede any in-flight run so its late results can't render.
    signalRef.current.cancelled = true
    const signal = { cancelled: false }
    signalRef.current = signal
    const runId = ++runIdRef.current

    // Read the query + toggles at search START so a late result can't be run with
    // a query the user has since edited. Row highlighting comes straight from each
    // result record's (col, length) — a snapshot in itself — so no separate query
    // snapshot is needed for the bold spans.
    const q = queryRef.current
    const opts = { ...optsRef.current }
    setListMode(false)
    if (q === "") {
      setResult(null)
      setSearching(false)
      return
    }
    setSearching(true)
    void searchWorkspace(workspaceRoot, q, { ...opts, signal, maxResults })
      .then((res) => {
        if (runId !== runIdRef.current || !mountedRef.current || signal.cancelled) return
        setResult(res)
        setSearching(false)
        setCollapsed(new Set())
        setSelectedIndex(0)
      })
      .catch(() => {
        if (runId === runIdRef.current && mountedRef.current) setSearching(false)
      })
  }, [workspaceRoot, maxResults])

  const clearSearchTimer = useCallback(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
  }, [])

  // Search-as-you-type: re-run (debounced) whenever the query or a toggle changes.
  // queryRef/optsRef are already updated by the time the timer fires. An empty query
  // takes runSearch's clear-and-return path, so no git grep is spawned for "". This
  // one effect subsumes the old toggle-only re-run — toggles are in its deps.
  useEffect(() => {
    clearSearchTimer()
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null
      runSearch()
    }, SEARCH_DEBOUNCE_MS)
    return clearSearchTimer
  }, [query, matchCase, wholeWord, regex, runSearch, clearSearchTimer])

  useEffect(() => {
    setSelectedIndex((i) => (rows.length === 0 ? 0 : Math.min(Math.max(0, i), rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    const row = rows[selectedIndex]
    if (row && scrollRef.current) scrollRef.current.scrollChildIntoView(row.id)
  }, [selectedIndex, rows])

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // Open a match. The fast path (direct gotoLine) is taken ONLY when the file is
  // already the active tab AND its editor has actually registered controls —
  // controls register asynchronously after the doc loads, so `activeTabPath ===
  // path` alone (set synchronously by openFile) isn't enough: in that window
  // gotoLine would hit no controls and no-op. Otherwise ALWAYS stash a pending
  // goto (a single slot that supersedes any prior request, so a rapid second
  // activation of a still-loading file wins over the first) then open; the
  // mounting editor drains it. Opening also moves focus into the editor.
  const openMatch = (path: string, line: number, col: number) => {
    const state = workbenchStore.getState()
    const group = state.groups.find((g) => g.id === state.activeGroupId)
    const controls = getEditorControls(state.activeGroupId)
    if (group?.activeTabPath === path && controls) {
      workbenchStore.openFile(path, { preview: true })
      controls.gotoLine(line, col)
    } else {
      requestGoto(path, line, col)
      workbenchStore.openFile(path, { preview: true })
    }
  }

  const activateRow = (row: Row) => {
    if (row.type === "file") toggleCollapse(row.path)
    else if (row.type === "match") openMatch(row.path, row.line, row.col)
  }

  const enterList = () => {
    if (rowsRef.current.length === 0) return
    setListMode(true)
    setSelectedIndex(0)
  }

  // Input mode: the focused <input> eats arrows, so ↓/Tab (enter the list) route
  // through a keymap layer, exactly like Quick Open / the find widget. Enter (run
  // search) DOES reach useKeyboard below.
  useEffect(() => {
    if (!focused || listMode) return
    const layerCommands = [
      { name: "search.enterList", run: enterList },
      { name: "search.block", run: () => {} },
    ] as unknown as Command<Renderable, KeyEvent>[]
    const bindings = [
      { key: "down", cmd: "search.enterList" },
      { key: "tab", cmd: "search.enterList" },
    ] as unknown as Binding<Renderable, KeyEvent>[]
    return commands.pushLayer({ commands: layerCommands, bindings })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, listMode, commands])

  useKeyboard((key) => {
    if (!focused || isOverlayOpen) return
    if (!listMode) {
      // Input mode — only Enter is ours; everything else is typing. Enter forces
      // an immediate run, flushing the pending debounce so it can't fire again.
      if (key.name === "return" || key.name === "enter") {
        clearSearchTimer()
        runSearch()
      }
      return
    }
    switch (key.name) {
      case "up":
        // ↑ past the first row hands focus back to the query input.
        if (selectedIndexRef.current <= 0) setListMode(false)
        else setSelectedIndex(selectedIndexRef.current - 1)
        break
      case "down":
        setSelectedIndex(Math.min(rowsRef.current.length - 1, selectedIndexRef.current + 1))
        break
      case "return":
      case "enter": {
        const row = rowsRef.current[selectedIndexRef.current]
        if (row) activateRow(row)
        break
      }
      case "left": {
        const row = rowsRef.current[selectedIndexRef.current]
        if (row?.type === "file" && !collapsed.has(row.path)) toggleCollapse(row.path)
        break
      }
      case "right": {
        const row = rowsRef.current[selectedIndexRef.current]
        if (row?.type === "file" && collapsed.has(row.path)) toggleCollapse(row.path)
        break
      }
    }
  })

  const selectRow = (index: number) => {
    setSelectedIndex(index)
    setListMode(true)
  }

  const totalMatches = result?.files.reduce((n, f) => n + f.matches.length, 0) ?? 0
  const selectedId = rows[selectedIndex]?.id

  return (
    <box flexDirection="column" height="100%" backgroundColor={theme.sidebarBackground}>
      <box flexDirection="row" width="100%" height={1} flexShrink={0}>
        <input
          id="search-input"
          focused={focused && !listMode}
          value={query}
          onInput={setQuery}
          onMouseDown={() => setListMode(false)}
          placeholder="Search"
          flexGrow={1}
          backgroundColor={theme.background}
          cursorStyle={CURSOR_STYLE}
        />
        <ToggleCell label="Aa" active={matchCase} onToggle={() => setMatchCase((v) => !v)} />
        <ToggleCell label="ab" active={wholeWord} onToggle={() => setWholeWord((v) => !v)} />
        <ToggleCell label=".*" active={regex} onToggle={() => setRegex((v) => !v)} />
      </box>

      {searching ? (
        <box height={1} paddingLeft={1} flexShrink={0}>
          <text fg={theme.dimForeground}>Searching…</text>
        </box>
      ) : result ? (
        <box height={1} paddingLeft={1} flexShrink={0}>
          <text fg={theme.dimForeground}>
            {totalMatches === 0
              ? "No results"
              : `${totalMatches} result${totalMatches === 1 ? "" : "s"} in ${result.files.length} file${result.files.length === 1 ? "" : "s"}`}
          </text>
        </box>
      ) : null}

      <scrollbox ref={scrollRef} flexGrow={1}>
        {rows.map((row) => {
          if (row.type === "truncated") {
            return (
              <box key={row.id} id={row.id} height={1} paddingLeft={1}>
                <text fg={theme.warning}>Results truncated — refine your search</text>
              </box>
            )
          }
          if (row.type === "file") {
            const rel = relative(workspaceRoot, row.path)
            const name = basename(row.path)
            const dir = rel.slice(0, Math.max(0, rel.length - name.length - 1))
            const isCollapsed = collapsed.has(row.path)
            return (
              <box
                key={row.id}
                id={row.id}
                flexDirection="row"
                width="100%"
                height={1}
                paddingLeft={1}
                backgroundColor={selectedId === row.id ? theme.selectionBackground : undefined}
                onMouseDown={() => {
                  selectRow(rows.findIndex((r) => r.id === row.id))
                  toggleCollapse(row.path)
                }}
              >
                <text fg={theme.foreground}>{`${isCollapsed ? "▶" : "▼"} ${name}`}</text>
                {dir ? <text fg={theme.dimForeground}>{` ${dir}`}</text> : null}
                <box flexGrow={1} />
                <text fg={theme.dimForeground}>{`${row.count} `}</text>
              </box>
            )
          }
          // Bold exactly the engine-reported span [col-1, col-1+length). The
          // match is real content (never trailing whitespace), so it always
          // survives the trailing-whitespace strip; clamp the end anyway so a
          // pathological query that matches into the stripped tail can't overrun.
          const trimmed = row.preview.replace(/\s+$/, "")
          const start = row.col - 1
          const range: [number, number] | null =
            row.length > 0 && start < trimmed.length ? [start, Math.min(start + row.length, trimmed.length)] : null
          return (
            <box
              key={row.id}
              id={row.id}
              flexDirection="row"
              width="100%"
              height={1}
              paddingLeft={3}
              backgroundColor={selectedId === row.id ? theme.selectionBackground : undefined}
              onMouseDown={() => {
                selectRow(rows.findIndex((r) => r.id === row.id))
                openMatch(row.path, row.line, row.col)
              }}
            >
              <text fg={theme.foreground}>{highlightPreview(trimmed, range)}</text>
            </box>
          )
        })}
      </scrollbox>
    </box>
  )
}
