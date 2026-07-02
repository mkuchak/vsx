/**
 * Shared drag-gesture state for divider sashes.
 *
 * The renderer only captures the pointer on the FIRST drag event's hit-test, not
 * on mousedown. A real drag has already moved ≥1 cell by then, so that first drag
 * hit-tests whichever renderable now sits under the cursor — the neighboring pane,
 * not the 1-column sash — and the pane (not the sash) gets captured. Because
 * `Renderable.processMouseEvent` bubbles up the parent chain, the captured pane's
 * drag events still reach the sash's ANCESTOR container. So the ancestor, not the
 * sash, is where a real drag is serviced.
 *
 * A sash arms a gesture on mousedown (recording its own starting column and the
 * delta/commit closures). Ancestor containers of the matching `kind` then feed the
 * absolute column into {@link applyArmedDrag}, which converts it to a signed offset
 * from the gesture start. Applying an ABSOLUTE offset (not accumulated increments)
 * keeps it idempotent: on a slow drag BOTH the sash's own captured handlers and the
 * bubbled ancestor handlers fire for the same motion, and applying the same offset
 * twice is a no-op the second time.
 */
export type DragGestureKind = "sidebar" | "split"

type DragGesture = {
  kind: DragGestureKind
  startX: number
  applyDelta: (deltaCells: number) => void
  commit: () => void
}

let active: DragGesture | null = null

export function armDrag(gesture: DragGesture): void {
  active = gesture
}

/** Feed a drag's absolute column; routes to the armed gesture iff kinds match. */
export function applyArmedDrag(kind: DragGestureKind, x: number): boolean {
  if (!active || active.kind !== kind) return false
  active.applyDelta(x - active.startX)
  return true
}

/** End the armed gesture (commit + disarm) iff kinds match. */
export function endArmedDrag(kind: DragGestureKind): boolean {
  if (!active || active.kind !== kind) return false
  active.commit()
  active = null
  return true
}

export function disarmDrag(): void {
  active = null
}

export function isDragArmed(): boolean {
  return active !== null
}
