import { expect, test } from "bun:test"
import { equalFractions, removeFraction, resizeFraction, splitFraction } from "./splitSizes"

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

test("equalFractions spreads 1 evenly and handles the degenerate count", () => {
  expect(equalFractions(1)).toEqual([1])
  expect(equalFractions(2)).toEqual([0.5, 0.5])
  expect(sum(equalFractions(3))).toBeCloseTo(1)
  expect(equalFractions(3)[0]).toBeCloseTo(1 / 3)
  expect(equalFractions(0)).toEqual([])
})

test("splitFraction halves the source and inserts the other half after it (1→2→3)", () => {
  const two = splitFraction([1], 0)
  expect(two).toEqual([0.5, 0.5])

  // Split the 0.6 slot of an uneven pair.
  const three = splitFraction([0.6, 0.4], 0)
  expect(three).toEqual([0.3, 0.3, 0.4])
  expect(sum(three)).toBeCloseTo(1)

  // Splitting the second slot inserts after index 1.
  expect(splitFraction([0.5, 0.5], 1)).toEqual([0.5, 0.25, 0.25])

  // Repeated splits of the newly-active (rightmost) slot: 3 → 4 groups.
  const four = splitFraction([0.5, 0.25, 0.25], 2)
  expect(four).toEqual([0.5, 0.25, 0.125, 0.125])
  expect(sum(four)).toBeCloseTo(1)
})

test("removeFraction returns the removed slot's fraction to the nearest neighbor", () => {
  // Removing a middle group gives its fraction to the LEFT neighbor.
  expect(removeFraction([0.3, 0.3, 0.4], 1)).toEqual([0.6, 0.4])
  // Removing the FIRST group gives its fraction to the new first (former right).
  expect(removeFraction([0.3, 0.3, 0.4], 0)).toEqual([0.6, 0.4])
  // Removing the LAST group gives its fraction to the left neighbor.
  expect(removeFraction([0.3, 0.3, 0.4], 2)).toEqual([0.3, 0.7])
  // Removing down to a single group collapses back to [1].
  expect(removeFraction([0.5, 0.5], 0)).toEqual([1])

  // Four groups, remove a middle one: its fraction folds into the left neighbor.
  const four = removeFraction([0.25, 0.25, 0.25, 0.25], 2)
  expect(four).toEqual([0.25, 0.5, 0.25])
  expect(sum(four)).toBeCloseTo(1)
})

test("resizeFraction moves fraction across a divider, preserving the pair's sum", () => {
  const next = resizeFraction([0.5, 0.5], 0, 0.2, 0.1)
  expect(next[0]).toBeCloseTo(0.7)
  expect(next[1]).toBeCloseTo(0.3)
  expect(sum(next)).toBeCloseTo(1)

  // A three-group array: only the targeted pair moves, the rest is untouched.
  const three = resizeFraction([0.3, 0.3, 0.4], 1, 0.1, 0.1)
  expect(three[0]).toBeCloseTo(0.3)
  expect(three[1]).toBeCloseTo(0.4)
  expect(three[2]).toBeCloseTo(0.3)
})

test("resizeFraction clamps so neither side drops below minFraction", () => {
  // Huge positive delta clamps the right side to the floor.
  const hi = resizeFraction([0.5, 0.5], 0, 5, 0.2)
  expect(hi[0]).toBeCloseTo(0.8)
  expect(hi[1]).toBeCloseTo(0.2)

  // Huge negative delta clamps the left side to the floor.
  const lo = resizeFraction([0.5, 0.5], 0, -5, 0.2)
  expect(lo[0]).toBeCloseTo(0.2)
  expect(lo[1]).toBeCloseTo(0.8)
})

test("resizeFraction is a no-op when the divider has no right neighbor", () => {
  expect(resizeFraction([1], 0, 0.2, 0.1)).toEqual([1])
  expect(resizeFraction([0.5, 0.5], 1, 0.2, 0.1)).toEqual([0.5, 0.5])
})

test("resizeFraction never produces a negative fraction for a sub-floor pair", () => {
  // A pair whose combined fraction (0.2) can't seat two 0.3 floors: returning a
  // clamped split would drive the right side negative, so it stays unchanged.
  expect(resizeFraction([0.1, 0.1], 0, 5, 0.3)).toEqual([0.1, 0.1])
  // A deep split's thin middle pair (0.08 combined) against a 0.645 floor.
  expect(resizeFraction([0.5, 0.04, 0.04, 0.42], 1, 5, 0.645)).toEqual([0.5, 0.04, 0.04, 0.42])
})

test("resizeFraction always preserves the pair's sum and stays non-negative", () => {
  const cases: Array<{ sizes: number[]; divider: number; delta: number; min: number }> = [
    { sizes: [0.5, 0.5], divider: 0, delta: 0.2, min: 0.1 },
    { sizes: [0.5, 0.5], divider: 0, delta: 5, min: 0.2 },
    { sizes: [0.5, 0.5], divider: 0, delta: -5, min: 0.2 },
    { sizes: [0.1, 0.1], divider: 0, delta: 5, min: 0.3 },
    { sizes: [0.1, 0.1], divider: 0, delta: -5, min: 0.3 },
    { sizes: [0.3, 0.3, 0.4], divider: 1, delta: 0.1, min: 0.1 },
    { sizes: [0.5, 0.04, 0.04, 0.42], divider: 1, delta: 5, min: 0.645 },
    { sizes: [0.5, 0.25, 0.125, 0.125], divider: 2, delta: -3, min: 0.17 },
    { sizes: [0.02, 0.98], divider: 0, delta: -1, min: 0.5 },
  ]
  for (const { sizes, divider, delta, min } of cases) {
    const next = resizeFraction(sizes, divider, delta, min)
    expect(sum(next)).toBeCloseTo(sum(sizes))
    for (const f of next) expect(f).toBeGreaterThanOrEqual(0)
  }
})
