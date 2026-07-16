/**
 * Injectable clock for multi-click (double/triple-click) gesture detection in
 * {@link EditorPane}, mirroring {@link ./scrollAxisLock.ts}'s `now` injection.
 *
 * Multi-click counting genuinely needs real wall-clock time in production — a
 * double-click is defined by how fast a real user's two clicks land, and that
 * has to be actual elapsed time, not a fake tick. But a TEST that simulates a
 * double-click by firing two mouse events in quick succession is asserting
 * "these count as one gesture," not "these landed within some race against the
 * real clock" — and under a starved event loop, the real wall-clock gap
 * between two `await`ed simulated clicks can occasionally exceed the
 * production threshold even though the test's intent was unambiguous, making
 * the test flaky for a reason that has nothing to do with the behavior it's
 * checking. Freezing this clock in tests removes that race entirely.
 */
let clock: () => number = Date.now

export function now(): number {
  return clock()
}

/** Test-only: override the clock this module returns from {@link now}. */
export function setClickClock(fn: () => number): void {
  clock = fn
}

/** Test-only: restore the real wall clock. */
export function resetClickClock(): void {
  clock = Date.now
}
