import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding, Command } from "@opentui/keymap"
import { useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { documentRegistry } from "../model/documents"
import { workbenchStore } from "../model/workbench"
import { withMacSuper } from "../services/commands"
import { findMatches, type FindMatch } from "../services/findInFile"
import { theme } from "../theme"
import { useCommands } from "../workbench/CommandsProvider"
import { getEditorControls } from "../workbench/editorControls"
import { useOverlay } from "../workbench/OverlayProvider"
import { useWorkbenchStore } from "../workbench/useWorkbenchStore"

/** Debounce before re-running matches after a keystroke or a buffer edit. */
const RECOMPUTE_DEBOUNCE_MS = 90

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

/**
 * VSCode-style in-document find bar (Ctrl+F). Absolute-positioned at the top-right
 * of the editor area, it drives the ACTIVE group's editor imperatively through
 * EditorControls: it computes matches from the buffer text, paints them (all + the
 * current one), and reveals/selects the current match so Esc lands the caret there.
 *
 * Scope: the bar targets the editor that was active when it opened. Switching group
 * OR file while open closes it — re-targeting would have to reconcile highlights
 * across buffers for a rare split-focus case; closing is the cheaper correct choice.
 * A diff tab has no textarea (no controls), so Ctrl+F is a silent no-op there.
 */
export function FindWidget() {
  const commands = useCommands()
  const { setOverlayOpen } = useOverlay()
  const workbench = useWorkbenchStore()

  const [visible, setVisible] = useState(false)
  const [query, setQuery] = useState("")
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [matches, setMatches] = useState<FindMatch[]>([])
  const [currentIdx, setCurrentIdx] = useState(0)
  const [error, setError] = useState(false)

  // The editor the bar is bound to, captured at open. Kept in refs so the keymap
  // layer and the debounced recompute (registered once per open) read live values.
  const targetGroupIdRef = useRef<string | null>(null)
  const targetPathRef = useRef<string | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const optsRef = useRef({ matchCase, wholeWord, regex })
  optsRef.current = { matchCase, wholeWord, regex }
  const matchesRef = useRef<FindMatch[]>([])
  const currentIdxRef = useRef(0)
  // The single pending "reset to first match" timer from a query/toggle change.
  // Held in a ref (not effect-local) so only one is ever outstanding, and so a
  // navigation can flush it first — otherwise a late reset could fire AFTER the
  // user stepped to another match and yank them back to the first.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const targetControls = () => getEditorControls(targetGroupIdRef.current ?? "")

  const clearResetTimer = () => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }

  // Re-run matches against the target buffer's CURRENT text and repaint. `resetIdx`
  // starts a fresh search at the first match (query/toggle change); otherwise the
  // current index is preserved and clamped (a buffer edit shifted offsets).
  const recompute = useCallback((resetIdx: boolean) => {
    const controls = targetControls()
    if (!controls) return
    const res = findMatches(controls.getText(), queryRef.current, optsRef.current)
    matchesRef.current = res.matches
    setMatches(res.matches)
    setError(res.error)
    const hint = resetIdx ? 0 : currentIdxRef.current
    const idx = res.matches.length === 0 ? 0 : Math.min(Math.max(0, hint), res.matches.length - 1)
    currentIdxRef.current = idx
    setCurrentIdx(idx)
    controls.setFindMatches(res.matches, idx)
    if (res.matches.length > 0) controls.revealMatch(idx)
  }, [])

  // Step to the next/previous match (wrap-around), repaint the current marker, and
  // reveal it. Pure index move — the match set is unchanged.
  const move = useCallback(
    (delta: number) => {
      // If the user typed then immediately navigated, flush the pending reset now
      // (compute the new query's matches at index 0) so this step lands on the
      // fresh set and no late timer can rewind us afterward.
      if (resetTimerRef.current) {
        clearResetTimer()
        recompute(true)
      }
      const controls = targetControls()
      const n = matchesRef.current.length
      if (!controls || n === 0) return
      const idx = (((currentIdxRef.current + delta) % n) + n) % n
      currentIdxRef.current = idx
      setCurrentIdx(idx)
      controls.setFindMatches(matchesRef.current, idx)
      controls.revealMatch(idx)
    },
    [recompute],
  )

  const close = useCallback(() => {
    targetControls()?.clearFind()
    setVisible(false)
    // Reset match state so a reopen can't flash the previous "N of M" for a frame
    // before the first debounced recompute runs.
    matchesRef.current = []
    currentIdxRef.current = 0
    setMatches([])
    setCurrentIdx(0)
    setError(false)
  }, [])

  // Ctrl+F (and Cmd+F on macOS) opens the bar for the active editor. A diff/empty
  // group has no controls → no-op. Seeds the query from a non-empty single-line
  // selection, VSCode-style.
  useEffect(() => {
    return commands.registerCommand({
      id: "editor.find",
      title: "Find",
      category: "Editor",
      keybinding: withMacSuper("ctrl+f"),
      run: () => {
        const state = workbenchStore.getState()
        const controls = getEditorControls(state.activeGroupId)
        if (!controls) return
        targetGroupIdRef.current = state.activeGroupId
        const group = state.groups.find((g) => g.id === state.activeGroupId)
        targetPathRef.current = group?.activeTabPath ?? null
        const selected = controls.getSelectedText()
        const seed = selected && !selected.includes("\n") ? selected : ""
        setQuery(seed)
        setCurrentIdx(0)
        currentIdxRef.current = 0
        setVisible(true)
      },
    })
  }, [commands])

  // Report open/closed into the shared overlay signal so the editor's key handlers
  // gate off (typing can't leak into the buffer) and its focus is restored on close.
  useEffect(() => {
    if (!visible) return
    setOverlayOpen("findInFile", true)
    return () => setOverlayOpen("findInFile", false)
  }, [visible, setOverlayOpen])

  // Recompute as the query/toggles change (debounced), resetting to the first match.
  // The timer lives in a ref so only one is ever pending and move() can flush it.
  useEffect(() => {
    if (!visible) return
    clearResetTimer()
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null
      recompute(true)
    }, RECOMPUTE_DEBOUNCE_MS)
    return clearResetTimer
  }, [visible, query, matchCase, wholeWord, regex, recompute])

  // Recompute (preserving the current index) when the bound buffer is edited while
  // the bar is open — offsets shift on every edit. Debounced off the Document's
  // change event, matching the editor's own re-highlight cadence.
  useEffect(() => {
    if (!visible) return
    const path = targetPathRef.current
    const doc = path ? documentRegistry.get(path) : undefined
    if (!doc) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = doc.onDidChange(() => {
      // The edit already landed in the buffer, but recompute is debounced — clear
      // find's ref-2/3 spans synchronously so none linger past a shrunk buffer in
      // that window. clearFind touches only find's own refs, never syntax (ref 1).
      targetControls()?.clearFind()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => recompute(false), RECOMPUTE_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [visible, recompute])

  // Close if the user switches to another group or another tab while the bar is
  // open: the bound buffer would no longer be the one on screen.
  useEffect(() => {
    if (!visible) return
    const group = workbench.groups.find((g) => g.id === targetGroupIdRef.current)
    const stillThere = group !== undefined && group.activeTabPath === targetPathRef.current
    if (workbench.activeGroupId !== targetGroupIdRef.current || !stillThere) close()
  }, [visible, workbench, close])

  // A focused <input> swallows arrow keys before a useKeyboard handler sees them,
  // so ↑/↓ (prev/next) route through a pushed keymap layer — the QuickInput pattern.
  // ctrl+q is shadowed so quit can't fire mid-find. Enter/Esc DO reach useKeyboard.
  useEffect(() => {
    if (!visible) return
    const layerCommands = [
      { name: "find.prev", run: () => move(-1) },
      { name: "find.next", run: () => move(1) },
      { name: "find.block", run: () => {} },
    ] as unknown as Command<Renderable, KeyEvent>[]
    const bindings = [
      { key: "up", cmd: "find.prev" },
      { key: "down", cmd: "find.next" },
      { key: "ctrl+q", cmd: "find.block" },
    ] as unknown as Binding<Renderable, KeyEvent>[]
    return commands.pushLayer({ commands: layerCommands, bindings })
  }, [visible, commands, move])

  // Enter → next, Shift+Enter → previous, Esc → close (these reach useKeyboard
  // even with the input focused). NOTE: without the kitty keyboard protocol a
  // terminal delivers Shift+Enter as a bare CR (indistinguishable from Enter), so
  // Shift+Enter only steps backward where kitty is active; ↑ is the reliable prev.
  useKeyboard((key) => {
    if (!visible) return
    if (key.name === "escape") {
      close()
      return
    }
    if (key.name === "return" || key.name === "enter") {
      move(key.shift ? -1 : 1)
    }
  })

  if (!visible) return null

  const count = error
    ? "Invalid regex"
    : matches.length === 0
      ? query === ""
        ? ""
        : "No results"
      : `${currentIdx + 1} of ${matches.length}`

  return (
    <box
      position="absolute"
      right={2}
      top={0}
      zIndex={100}
      flexDirection="row"
      alignItems="center"
      border
      borderColor={theme.border}
      backgroundColor={theme.sidebarBackground}
    >
      <input
        id="find-input"
        focused
        value={query}
        onInput={setQuery}
        placeholder="Find"
        width={24}
        backgroundColor={theme.background}
      />
      <ToggleCell label="Aa" active={matchCase} onToggle={() => setMatchCase((v) => !v)} />
      <ToggleCell label="ab" active={wholeWord} onToggle={() => setWholeWord((v) => !v)} />
      <ToggleCell label=".*" active={regex} onToggle={() => setRegex((v) => !v)} />
      <box width={12} height={1} paddingLeft={1}>
        <text fg={theme.dimForeground}>{count}</text>
      </box>
      <box height={1} paddingLeft={1} paddingRight={1} onMouseDown={() => move(-1)}>
        <text fg={theme.foreground}>↑</text>
      </box>
      <box height={1} paddingRight={1} onMouseDown={() => move(1)}>
        <text fg={theme.foreground}>↓</text>
      </box>
      <box height={1} paddingRight={1} onMouseDown={close}>
        <text fg={theme.foreground}>✕</text>
      </box>
    </box>
  )
}
