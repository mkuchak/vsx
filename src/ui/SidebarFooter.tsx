import { theme } from "../theme"

/**
 * One-row clickable footer pinned to the bottom of the sidebar (the sidebar
 * body's flexGrow pushes it down). Clicking it collapses the sidebar, mirroring
 * VSCode's hide-sidebar affordance; the status bar's ☰ cell re-expands it. Uses
 * SidebarTabs' clickable-box pattern (onMouseDown on a padded inner box). Height
 * is always exactly 1 row.
 */
export function SidebarFooter({
  onCollapse,
  overlayOpen,
}: {
  onCollapse: () => void
  /** When an overlay owns the screen, the collapse click is inert (mirrors Ctrl+B's dispatch gate). */
  overlayOpen?: boolean
}) {
  const handleCollapse = () => {
    // A click landing under an open overlay must not restructure the workbench —
    // mirrors Ctrl+B, which the command dispatch gate blocks while one is open.
    if (overlayOpen) return
    onCollapse()
  }

  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      flexShrink={0}
      backgroundColor={theme.sidebarBackground}
    >
      <box paddingLeft={1} paddingRight={1} onMouseDown={handleCollapse}>
        {/* Non-selectable: a bare click would otherwise start a renderer text
            selection whose empty mouse-up wipes the Ctrl+C copy cache
            (rendererSelection.ts) — the same cache global Ctrl+C copies from. */}
        <text fg={theme.dimForeground} selectable={false}>
          ◂ Hide Sidebar
        </text>
      </box>
    </box>
  )
}
