import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { documentRegistry } from "../model/documents.ts"
import { workbenchStore, type Group } from "../model/workbench.ts"
import { theme } from "../theme"
import { useCommands } from "../workbench/CommandsProvider.tsx"
import { useWorkbenchStore } from "../workbench/useWorkbenchStore.ts"
import { DiffPane } from "./DiffPane.tsx"
import { EditorPane, type CursorPosition } from "./EditorPane.tsx"
import { applyArmedDrag, disarmDrag, endArmedDrag } from "./dragManager.ts"
import { SplitDivider } from "./SplitDivider.tsx"
import { TabBar } from "./TabBar.tsx"

/** Minimum columns a pane may shrink to; the divider clamp is derived from it. */
const MIN_PANE_CELLS = 20
/** Cells a single Grow/Shrink command nudge shifts the active group by. */
const NUDGE_CELLS = 2

export type EditorGroupsProps = {
  /** Fires with the FOCUSED pane's cursor position; unset while a diff pane (no cursor) is focused. */
  onCursorChange?: (pos: CursorPosition) => void
  /**
   * Whether the editor area (vs the sidebar) currently holds workbench focus.
   * When false, EVERY pane's textarea is blurred so keystrokes/arrows don't leak
   * into the open document while the user is navigating the sidebar.
   */
  editorFocused?: boolean
  /**
   * Cell width of the whole editor area (terminal minus sidebar minus its sash),
   * used to convert drag/keyboard deltas into size fractions. Falls back to the
   * full terminal width when unset (e.g. standalone in tests without a sidebar).
   */
  containerWidth?: number
}

/**
 * Side-by-side editor groups (VSCode's split editors). Renders each group as a
 * flex column sized by the store's `sizes` fraction, with a draggable
 * {@link SplitDivider} between every adjacent pair. At most ONE pane is focused at
 * a time — the group whose id matches `activeGroupId`, and only while
 * `editorFocused` — so a keystroke never reaches more than one textarea, and none
 * while the sidebar holds focus.
 */
export function EditorGroups({
  onCursorChange,
  editorFocused = true,
  containerWidth,
}: EditorGroupsProps = {}) {
  const state = useWorkbenchStore()
  const commands = useCommands()
  const { width: termWidth } = useTerminalDimensions()
  const areaWidth = containerWidth ?? termWidth

  // Workbench-wide word-wrap, applied to every editor textarea so splits stay
  // consistent and a newly-opened pane inherits the current setting. Defaults to
  // "word" (VSCode's default). The toggle command flips this via a functional
  // update, so its run closure never captures a stale value and the command
  // registration below stays one-shot.
  const [wordWrap, setWordWrap] = useState<"word" | "none">("word")

  // Read live values inside command closures without re-registering commands
  // (registration must stay one-shot — see the "registers ... exactly once" test).
  const areaWidthRef = useRef(areaWidth)
  areaWidthRef.current = areaWidth

  // Cell width available to panes = editor area minus the interior divider columns.
  const dividerCount = Math.max(0, state.groups.length - 1)
  const paneCells = Math.max(1, areaWidth - dividerCount)

  // A single live drag against one divider. Tracks the last cumulative fraction so
  // deltas (which SplitDivider reports cumulative-from-gesture-start) are applied
  // to the store incrementally rather than compounding.
  const gesture = useRef<{ dividerIndex: number; last: number } | null>(null)

  const handleDividerDelta = (dividerIndex: number) => (deltaCells: number) => {
    const cells = Math.max(1, areaWidthRef.current - dividerCount)
    const minFraction = MIN_PANE_CELLS / cells
    const cumulative = deltaCells / cells
    if (gesture.current?.dividerIndex !== dividerIndex) {
      gesture.current = { dividerIndex, last: 0 }
    }
    const incremental = cumulative - gesture.current.last
    gesture.current.last = cumulative
    workbenchStore.resizeSplit(dividerIndex, incremental, minFraction)
  }
  const handleDividerCommit = () => {
    gesture.current = null
  }

  useEffect(() => {
    const nudgeActive = (sign: 1 | -1) => {
      const s = workbenchStore.getState()
      if (s.groups.length < 2) return
      const cells = Math.max(1, areaWidthRef.current - (s.groups.length - 1))
      const minFraction = MIN_PANE_CELLS / cells
      const delta = (sign * NUDGE_CELLS) / cells
      const activeIndex = s.groups.findIndex((g) => g.id === s.activeGroupId)
      // Grow/shrink the ACTIVE group: use its right divider when it has one, else
      // borrow from the left neighbor (invert the delta so the active grows).
      if (activeIndex < s.groups.length - 1) {
        workbenchStore.resizeSplit(activeIndex, delta, minFraction)
      } else {
        workbenchStore.resizeSplit(activeIndex - 1, -delta, minFraction)
      }
    }

    const disposers = [
      commands.registerCommand({
        id: "workbench.splitEditor",
        title: "Split Editor",
        category: "View",
        keybinding: "ctrl+\\",
        // Cap the split so panes never fall below the ~20-cell floor: derive the
        // limit from the live editor-area width minus its interior dividers. A
        // refused split is a silent no-op (the store returns without mutating).
        run: () => {
          const groupCount = workbenchStore.getState().groups.length
          const cells = Math.max(1, areaWidthRef.current - (groupCount - 1))
          const maxGroups = Math.max(1, Math.floor(cells / MIN_PANE_CELLS))
          workbenchStore.splitGroup({ maxGroups })
        },
      }),
      // Ctrl+1..9 focus the Nth editor group. Indices past the current group
      // count are silent no-ops (focusGroupByIndex bounds-checks), so binding all
      // nine never crashes on a layout with fewer panes. focusGroupByIndex →
      // focusGroup also flips workbench focus into the editor, so from the sidebar
      // Ctrl+<n> both selects the group AND routes keystrokes to it.
      ...Array.from({ length: 9 }, (_, i) =>
        commands.registerCommand({
          id: `workbench.focusGroup${i + 1}`,
          title: `Focus Editor Group ${i + 1}`,
          category: "View",
          keybinding: `ctrl+${i + 1}`,
          run: () => workbenchStore.focusGroupByIndex(i),
        }),
      ),
      // Palette-only (no keybinding): cycle ALL groups, useful past the ctrl+1..4 range.
      commands.registerCommand({
        id: "workbench.focusNextGroup",
        title: "Focus Next Editor Group",
        category: "View",
        run: () => workbenchStore.focusNextGroup(),
      }),
      commands.registerCommand({
        id: "workbench.focusPreviousGroup",
        title: "Focus Previous Editor Group",
        category: "View",
        run: () => workbenchStore.focusPrevGroup(),
      }),
      commands.registerCommand({
        id: "workbench.growEditorGroup",
        title: "Grow Editor Group",
        category: "View",
        run: () => nudgeActive(1),
      }),
      commands.registerCommand({
        id: "workbench.shrinkEditorGroup",
        title: "Shrink Editor Group",
        category: "View",
        run: () => nudgeActive(-1),
      }),
      commands.registerCommand({
        id: "workbench.resetEditorGroupSizes",
        title: "Reset Editor Group Sizes",
        category: "View",
        run: () => workbenchStore.resetSplitSizes(),
      }),
      // Alt+Z (VSCode's chord) flips word wrap for EVERY editor pane. "alt" is the
      // correct keymap token — @opentui/keymap collapses alt/option/meta to one
      // meta flag, matching the option-carrying key event; "cmd" would throw.
      commands.registerCommand({
        id: "editor.toggleWordWrap",
        title: "Toggle Word Wrap",
        category: "View",
        keybinding: "alt+z",
        run: () => setWordWrap((mode) => (mode === "word" ? "none" : "word")),
      }),
      // Ctrl+Tab is stolen by many terminals; Ctrl+PageUp/Down is the reliable pair.
      commands.registerCommand({
        id: "editor.closeActiveTab",
        title: "Close Editor",
        category: "Editor",
        keybinding: "ctrl+w",
        run: () => void workbenchStore.closeActiveTab(),
      }),
      // Save is registered ONCE here, not per editor pane: a per-pane binding
      // duplicates under a split and Ctrl+S could then save the UNfocused file.
      // Resolve the active group's active tab and save only real file tabs.
      commands.registerCommand({
        id: "editor.save",
        title: "Save",
        category: "File",
        keybinding: "ctrl+s",
        run: () => {
          const s = workbenchStore.getState()
          const group = s.groups.find((g) => g.id === s.activeGroupId)
          const active = group?.tabs.find((t) => t.path === group.activeTabPath)
          if (active?.kind !== "file") return
          // Never let a failed save throw out of the command run(); the doc just
          // stays dirty and the user can retry.
          void documentRegistry.get(active.path)?.save().catch((err) => {
            console.error(`Failed to save ${active.path}:`, err)
          })
        },
      }),
      commands.registerCommand({
        id: "editor.nextTab",
        title: "Open Next Editor",
        category: "Editor",
        keybinding: "ctrl+pagedown",
        run: () => workbenchStore.activateNextTab(),
      }),
      commands.registerCommand({
        id: "editor.previousTab",
        title: "Open Previous Editor",
        category: "Editor",
        keybinding: "ctrl+pageup",
        run: () => workbenchStore.activatePrevTab(),
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [commands])

  return (
    <box
      flexDirection="row"
      width="100%"
      height="100%"
      // A divider drag captures a neighboring pane (not the 1-col sash), whose drag
      // events bubble up to this row. Service the armed "split" gesture here; the
      // kind guard keeps a sidebar drag (which also bubbles through here) out.
      onMouseDrag={(e) => applyArmedDrag("split", e.x)}
      onMouseDragEnd={() => endArmedDrag("split")}
      onMouseUp={() => disarmDrag()}
    >
      {state.groups.flatMap((group, i) => {
        const pane = (
          <EditorGroupPane
            key={group.id}
            group={group}
            grow={state.sizes[i] ?? 1}
            focused={group.id === state.activeGroupId && editorFocused}
            wordWrap={wordWrap}
            onCursorChange={group.id === state.activeGroupId ? onCursorChange : undefined}
          />
        )
        if (i === 0) return [pane]
        return [
          <SplitDivider
            key={`divider-${i - 1}`}
            kind="split"
            onDelta={handleDividerDelta(i - 1)}
            onCommit={handleDividerCommit}
            onReset={() => workbenchStore.resetSplitSizes()}
          />,
          pane,
        ]
      })}
    </box>
  )
}

function EditorGroupPane({
  group,
  grow,
  focused,
  wordWrap,
  onCursorChange,
}: {
  group: Group
  grow: number
  focused: boolean
  wordWrap: "word" | "none"
  onCursorChange?: (pos: CursorPosition) => void
}) {
  const active = group.tabs.find((t) => t.path === group.activeTabPath)
  const isDiff = active?.kind === "diff" || active?.kind === "commitDiff"

  return (
    <box
      id={`editor-group-${group.id}`}
      flexDirection="column"
      flexBasis={0}
      flexGrow={grow}
      flexShrink={1}
      height="100%"
      border={["right"]}
      // The focused pane — active group AND editor holding workbench focus (exactly
      // what `focused` encodes) — gets an accent border so the user can see which
      // split will receive keystrokes; inactive panes and every pane while the
      // sidebar is focused stay on the neutral border color.
      borderColor={focused ? theme.accent : theme.border}
      // Clicking anywhere in the pane body (not just its tab strip) focuses this
      // group AND takes editor focus (focusGroup sets focusArea='editor'). No
      // stopPropagation: it composes with the textarea's own click-to-focus
      // underneath, keeping the single-focus invariant.
      onMouseDown={() => workbenchStore.focusGroup(group.id)}
    >
      <TabBar groupId={group.id} />
      {isDiff ? (
        <DiffPane focused={focused} groupId={group.id} height="100%" />
      ) : (
        <EditorPane
          focused={focused}
          groupId={group.id}
          height="100%"
          wordWrap={wordWrap}
          onCursorChange={onCursorChange}
        />
      )}
    </box>
  )
}
