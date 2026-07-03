import { Fragment } from "react"
import { theme } from "../theme"

export type SidebarView = "explorer" | "scm" | "search" | "history"

// Concise labels so all FOUR tabs plus separators fit the default 32-col sidebar;
// at narrower widths the row clips rather than wrapping (height is pinned to 1).
// "SCM"/"Commits" abbreviate "Source Control"/"History". Only a single leading pad
// per tab (no trailing pad) is used so the four labels + separators stay ≤ 32.
const TABS: { view: SidebarView; label: string }[] = [
  { view: "explorer", label: "Explorer" },
  { view: "scm", label: "SCM" },
  { view: "search", label: "Search" },
  { view: "history", label: "Commits" },
]

/**
 * One-row clickable switcher at the top of the sidebar. Mirrors TabBar's active
 * styling (selection background + accent foreground); inactive labels are
 * dimmed. Clicking a label runs the same focus(view) action as the
 * Ctrl+Shift+E/G/H commands. Height is always exactly 1 row.
 */
export function SidebarTabs({
  active,
  onSelect,
}: {
  active: SidebarView
  onSelect: (view: SidebarView) => void
}) {
  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      flexShrink={0}
      backgroundColor={theme.sidebarBackground}
    >
      {TABS.map((tab, i) => {
        const isActive = tab.view === active
        return (
          <Fragment key={tab.view}>
            {i > 0 && <text fg={theme.border}>│</text>}
            <box
              paddingLeft={1}
              backgroundColor={isActive ? theme.selectionBackground : theme.sidebarBackground}
              onMouseDown={() => onSelect(tab.view)}
            >
              <text fg={isActive ? theme.accentForeground : theme.dimForeground}>{tab.label}</text>
            </box>
          </Fragment>
        )
      })}
    </box>
  )
}
