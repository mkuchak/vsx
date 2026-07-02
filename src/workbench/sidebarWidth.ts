export const MIN_SIDEBAR_WIDTH = 20
export const DEFAULT_SIDEBAR_WIDTH = 32
/** Columns kept for the editor area so the sidebar can never swallow the whole viewport. */
const EDITOR_RESERVE = 40

/** Clamp a drag-resized sidebar width to [MIN_SIDEBAR_WIDTH, termWidth - EDITOR_RESERVE]. */
export function clampSidebarWidth(start: number, delta: number, termWidth: number): number {
  // Guard tiny terminals: the ceiling must never drop below the floor.
  const max = Math.max(MIN_SIDEBAR_WIDTH, termWidth - EDITOR_RESERVE)
  return Math.min(Math.max(start + delta, MIN_SIDEBAR_WIDTH), max)
}
