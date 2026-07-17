/**
 * Injectable long-press timer for the FileTree's mouse context-menu trigger,
 * mirroring {@link ./clickClock.ts}'s injection.
 *
 * A long-press is defined by real elapsed wall-clock time — the user holds the
 * button down for ~{@link LONG_PRESS_MS} without moving — so production genuinely
 * needs a real `setTimeout`. But a TEST that exercises "held past the threshold"
 * is asserting the branch that fires when the timer elapses, not that a real
 * 450ms passed; sleeping 450ms per test would be slow and flaky under a starved
 * event loop. Swapping in a fake scheduler that captures the callback and fires
 * it on demand removes real time from those tests entirely.
 */
export const LONG_PRESS_MS = 450

export type LongPressScheduler = (callback: () => void, ms: number) => () => void

const realScheduler: LongPressScheduler = (callback, ms) => {
  const id = setTimeout(callback, ms)
  return () => clearTimeout(id)
}

let scheduler: LongPressScheduler = realScheduler

/** Arm a long-press timer; returns a canceller. */
export function scheduleLongPress(callback: () => void, ms: number): () => void {
  return scheduler(callback, ms)
}

/** Test-only: override the scheduler {@link scheduleLongPress} delegates to. */
export function setLongPressScheduler(fn: LongPressScheduler): void {
  scheduler = fn
}

/** Test-only: restore the real `setTimeout`-backed scheduler. */
export function resetLongPressScheduler(): void {
  scheduler = realScheduler
}
