import { useRef } from "react"
import { workbenchStore, type Group, type Tab } from "../model/workbench.ts"
import { theme } from "../theme"
import { useDocument } from "../workbench/useDocument.ts"
import { useWorkbenchStore } from "../workbench/useWorkbenchStore.ts"

const DOUBLE_CLICK_MS = 350

function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

/** The real underlying file path (diff tabs key identity on a synthetic string). */
function tabFilePath(tab: Tab): string {
  return tab.kind === "diff" ? tab.filePath : tab.path
}

/** Diff tabs get a VSCode-style side suffix so they read distinctly from the file tab. */
function tabLabel(tab: Tab): string {
  const name = basename(tabFilePath(tab))
  if (tab.kind === "diff") {
    return `${name} (${tab.diffKind === "staged" ? "Index" : "Working Tree"})`
  }
  return name
}

export type TabBarProps = {
  /** The editor group whose tab strip this renders. */
  groupId: string
}

/**
 * VSCode-like tab strip for a single editor group. Active tab highlighted,
 * preview tabs italic, dirty documents prefixed with "●". Single-click
 * activates, double-click promotes a preview tab to permanent. Purely
 * presentational — the editor tab commands (close/next/previous) are owned by
 * {@link EditorGroups} so they are bound exactly once regardless of pane count.
 */
export function TabBar({ groupId }: TabBarProps) {
  const state = useWorkbenchStore()
  const group = state.groups.find((g) => g.id === groupId)
  if (!group) return null

  return (
    <box flexDirection="column" width="100%">
      <TabRow group={group} isActiveGroup={group.id === state.activeGroupId} />
    </box>
  )
}

function TabRow({ group, isActiveGroup }: { group: Group; isActiveGroup: boolean }) {
  const lastClick = useRef<{ path: string; time: number } | null>(null)

  const handleClick = (path: string) => {
    const now = Date.now()
    const prev = lastClick.current
    // Focus this group first so clicking a tab in a non-focused split pane both
    // focuses that pane and activates the tab WITHIN it (not the active group's).
    workbenchStore.focusGroup(group.id)
    workbenchStore.activateTab(path, group.id)
    if (prev && prev.path === path && now - prev.time < DOUBLE_CLICK_MS) {
      workbenchStore.promoteTabInGroup(group.id, path)
    }
    lastClick.current = { path, time: now }
  }

  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      backgroundColor={theme.sidebarBackground}
      border={["bottom"]}
      borderColor={theme.border}
    >
      {group.tabs.map((tab) => {
        const active = tab.path === group.activeTabPath
        const label = tabLabel(tab)
        // Close affordance only on the active tab of the active group: closeTab
        // targets the active group, so a ✕ on any other tab would close the
        // wrong one. Non-active-group ✕ is a separate task.
        const showClose = active && isActiveGroup
        const fg = active ? theme.accentForeground : theme.foreground
        return (
          <box
            key={tab.path}
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={active ? theme.selectionBackground : theme.sidebarBackground}
            onMouseDown={() => handleClick(tab.path)}
          >
            {/* Only file tabs show the dirty dot — VSCode never dots diff views. */}
            {tab.kind === "file" && <TabDirtyDot path={tab.path} fg={fg} />}
            <text fg={fg}>{tab.preview ? <em>{label}</em> : label}</text>
            {showClose && (
              <box
                onMouseDown={(event) => {
                  // stopPropagation so the ✕ closes without the parent tab's
                  // activate handler also firing (OpenTUI mouse events bubble).
                  event.stopPropagation()
                  // closeTab runs the dirty guard internally; mouse handlers can't
                  // await, so fire-and-forget.
                  void workbenchStore.closeTab(tab.path, group.id)
                }}
              >
                <text fg={fg}> ✕</text>
              </box>
            )}
          </box>
        )
      })}
    </box>
  )
}

/**
 * Live "●" dirty indicator for a single file tab. Subscribes directly to the
 * underlying Document via {@link useDocument} so it repaints the moment an edit
 * makes the doc dirty and clears the moment a save cleans it — the workbench
 * store never fires for those transitions.
 */
function TabDirtyDot({ path, fg }: { path: string; fg: string }) {
  const doc = useDocument(path)
  if (!doc?.isDirty) return null
  return <text fg={fg}>● </text>
}
