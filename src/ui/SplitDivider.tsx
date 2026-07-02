import type { MouseEvent as TuiMouseEvent } from "@opentui/core"
import { useRef, useState } from "react"
import { theme } from "../theme"
import {
  applyArmedDrag,
  armDrag,
  disarmDrag,
  endArmedDrag,
  type DragGestureKind,
} from "./dragManager"

const DOUBLE_CLICK_MS = 350

export type SplitDividerProps = {
  /** Which gesture domain this sash arms; ancestors of the same kind service the drag. */
  kind: DragGestureKind
  /** Fired per drag event with the signed column offset from where the drag began. */
  onDelta: (deltaCells: number) => void
  /** Fired once the drag ends (mouse released). */
  onCommit?: () => void
  /** Fired on a double-click, for resetting to a default size. */
  onReset?: () => void
}

/**
 * A reusable 1-column draggable sash. A real drag moves off this single column
 * before the renderer captures the pointer, so the captured target is a neighbor,
 * not this sash — the drag is serviced by the matching ANCESTOR container via the
 * shared {@link armDrag} manager. Mousedown here only ARMS the gesture (records the
 * start column + delta/commit closures). The sash also keeps its own drag handlers
 * as a fast path for the slow-drag case where capture DOES land on it; both paths
 * apply the same absolute offset, so double-application is idempotent. Highlights
 * on hover/drag.
 */
export function SplitDivider({ kind, onDelta, onCommit, onReset }: SplitDividerProps) {
  const lastDown = useRef<number | null>(null)
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)

  const handleMouseDown = (event: TuiMouseEvent) => {
    // Grabbing the sash must not steal keyboard focus from the active pane.
    event.preventDefault()
    armDrag({ kind, startX: event.x, applyDelta: onDelta, commit: () => onCommit?.() })
    const now = Date.now()
    if (lastDown.current !== null && now - lastDown.current < DOUBLE_CLICK_MS) {
      onReset?.()
      lastDown.current = null
    } else {
      lastDown.current = now
    }
  }

  const handleMouseDrag = (event: TuiMouseEvent) => {
    // A gesture that actually drags is not a click — don't let the next mousedown
    // pair with it and misfire as a double-click reset.
    lastDown.current = null
    setDragging(true)
    applyArmedDrag(kind, event.x)
  }

  const handleMouseDragEnd = () => {
    setDragging(false)
    endArmedDrag(kind)
  }

  // A pure click (down then up with no drag) never fires drag-end, so disarm here
  // to avoid leaving a stale gesture armed for the next, unrelated drag.
  const handleMouseUp = () => {
    disarmDrag()
  }

  return (
    <box
      width={1}
      flexShrink={0}
      height="100%"
      backgroundColor={hovered || dragging ? theme.accent : theme.border}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseDrag={handleMouseDrag}
      onMouseDragEnd={handleMouseDragEnd}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    />
  )
}
