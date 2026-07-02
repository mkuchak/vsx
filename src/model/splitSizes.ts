/**
 * Pure fraction-array helpers for editor-group split sizes. Each array holds one
 * fraction per group and always sums to 1 (a single group → `[1]`). Kept
 * framework-agnostic and side-effect-free so the store can delegate to them and
 * they can be unit-tested for N groups independently of the 2-group UI cap.
 */

/** Equal fractions across `count` groups (e.g. 3 → `[1/3, 1/3, 1/3]`). */
export function equalFractions(count: number): number[] {
  if (count <= 0) return []
  return new Array(count).fill(1 / count)
}

/**
 * Split the group at `sourceIndex` in two: halve its fraction and insert the
 * other half immediately after it (e.g. `[0.6, 0.4]` split at 0 → `[0.3, 0.3, 0.4]`).
 */
export function splitFraction(sizes: number[], sourceIndex: number): number[] {
  const next = sizes.slice()
  const half = next[sourceIndex] / 2
  next[sourceIndex] = half
  next.splice(sourceIndex + 1, 0, half)
  return next
}

/**
 * Remove the group at `index`, returning its fraction to the nearest remaining
 * neighbor (the left neighbor when one exists, else the new first group). Sum is
 * preserved. Falls back to `[1]` if the last group is removed.
 */
export function removeFraction(sizes: number[], index: number): number[] {
  const next = sizes.slice()
  const [removed] = next.splice(index, 1)
  if (next.length === 0) return [1]
  const neighbor = index > 0 ? index - 1 : 0
  next[neighbor] += removed
  return next
}

/**
 * Move fraction across the divider between `dividerIndex` and `dividerIndex + 1`
 * by `delta`, clamping so NEITHER side drops below `minFraction`. The pair's
 * combined fraction (and thus the whole array's sum) is preserved, and both
 * outputs are guaranteed non-negative. A no-op (returns the input unchanged) when
 * the divider index has no right neighbor, or when the pair's combined fraction
 * cannot seat both minimums (`left + right < 2 * minFraction`) — forcing a split
 * there would drive one side negative, so we leave the pair as-is instead.
 */
export function resizeFraction(
  sizes: number[],
  dividerIndex: number,
  delta: number,
  minFraction: number,
): number[] {
  const left = sizes[dividerIndex]
  const right = sizes[dividerIndex + 1]
  if (right === undefined) return sizes.slice()
  const total = left + right
  // Degenerate pair: no split honors both floors, so any clamp would go negative.
  if (total < 2 * minFraction) return sizes.slice()
  // total >= 2*minFraction, so hi >= minFraction and both sides land in
  // [minFraction, total - minFraction]: non-negative, sum preserved.
  const hi = total - minFraction
  const newLeft = Math.min(Math.max(left + delta, minFraction), hi)
  const next = sizes.slice()
  next[dividerIndex] = newLeft
  next[dividerIndex + 1] = total - newLeft
  return next
}
