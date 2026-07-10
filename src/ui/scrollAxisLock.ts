/**
 * Gesture-scoped scroll axis locking.
 *
 * Terminals deliver trackpad/wheel scrolling as a flat stream of discrete
 * single-axis events (SGR wheel buttons 64-67) with no gesture grouping — and
 * the two axes arrive UNEVENLY amplified: e.g. Ghostty applies its
 * `mouse-scroll-multiplier` (default 3) plus a hardcoded 2× trackpad boost to
 * the VERTICAL axis only, while horizontal deltas pass through raw. A
 * two-finger swipe that isn't perfectly straight therefore emits an interleaved
 * mix (`left, down, left, down, down, left, …` — captured verbatim from Ghostty
 * 1.3.1), and applying every event verbatim makes a horizontal-intent swipe
 * mostly scroll vertically. Native apps never see this because NSScrollView
 * axis-locks gestures at the OS level; a terminal app has to reconstruct that
 * intent itself.
 *
 * Model: consecutive scroll events separated by less than {@link GESTURE_GAP_MS}
 * form one gesture. The gesture's FIRST event locks its axis; off-axis events
 * within the gesture are suppressed, unless the off-axis accumulates a decisive
 * lead ({@link FLIP_MARGIN} more events than the locked axis) — the user changed
 * direction without pausing, or the gesture opened with amplified strays — in
 * which case the lock flips. A pause longer than the gap starts a fresh gesture.
 *
 * State is module-global on purpose: there is one pointer and at most one live
 * scroll gesture per process, and the same lock must span every wheel consumer
 * (editor text, diff code surfaces) so a gesture that crosses surfaces keeps its
 * axis. Explicit horizontal affordances (wheel over a horizontal scrollbar)
 * bypass this filter entirely — hovering the bar IS the intent signal.
 */

export type ScrollDirection = "up" | "down" | "left" | "right"
type ScrollAxis = "h" | "v"

/** Longest silence, in ms, that still continues the current gesture (momentum tails included). */
const GESTURE_GAP_MS = 200
/** Off-axis events must LEAD the locked axis by this many to steal the lock mid-gesture. */
const FLIP_MARGIN = 3

let lastEventAt = Number.NEGATIVE_INFINITY
let counts = { h: 0, v: 0 }
let locked: ScrollAxis | null = null

/** Forget any in-flight gesture (tests: call between simulated bursts). */
export function resetScrollAxisLock(): void {
  lastEventAt = Number.NEGATIVE_INFINITY
  counts = { h: 0, v: 0 }
  locked = null
}

/**
 * Record one incoming scroll event and decide whether it should be applied.
 * Returns false when the event is an off-axis stray of the current gesture and
 * must be dropped (including not letting it bubble to outer scroll containers).
 * `now` is injectable for deterministic unit tests.
 */
export function admitScrollEvent(direction: ScrollDirection, now: number = performance.now()): boolean {
  const axis: ScrollAxis = direction === "left" || direction === "right" ? "h" : "v"
  if (now - lastEventAt > GESTURE_GAP_MS) {
    counts = { h: 0, v: 0 }
    locked = null
  }
  lastEventAt = now
  counts[axis]++
  if (locked === null) {
    locked = axis
    return true
  }
  if (axis === locked) return true
  if (counts[axis] >= counts[locked] + FLIP_MARGIN) {
    locked = axis
    return true
  }
  return false
}
