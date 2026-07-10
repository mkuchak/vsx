import { beforeEach, describe, expect, test } from "bun:test"
import { admitScrollEvent, resetScrollAxisLock } from "./scrollAxisLock"

beforeEach(() => {
  resetScrollAxisLock()
})

describe("scrollAxisLock", () => {
  test("first event locks its axis; same-axis events pass", () => {
    expect(admitScrollEvent("left", 0)).toBe(true)
    expect(admitScrollEvent("left", 10)).toBe(true)
    expect(admitScrollEvent("right", 20)).toBe(true) // both directions of the locked axis
  })

  test("off-axis strays inside a gesture are suppressed", () => {
    expect(admitScrollEvent("left", 0)).toBe(true)
    expect(admitScrollEvent("down", 10)).toBe(false)
    expect(admitScrollEvent("left", 20)).toBe(true)
    expect(admitScrollEvent("up", 30)).toBe(false)
  })

  test("vertical-locked gesture suppresses horizontal strays symmetrically", () => {
    expect(admitScrollEvent("down", 0)).toBe(true)
    expect(admitScrollEvent("left", 10)).toBe(false)
    expect(admitScrollEvent("down", 20)).toBe(true)
  })

  test("a decisive off-axis takeover flips the lock mid-gesture", () => {
    // Gesture opens with 1 vertical stray (amplified terminals do this), then the
    // user's real horizontal motion accumulates: h must reach v + 3 to flip.
    expect(admitScrollEvent("down", 0)).toBe(true) // v=1, locks v
    expect(admitScrollEvent("left", 10)).toBe(false) // h=1
    expect(admitScrollEvent("left", 20)).toBe(false) // h=2
    expect(admitScrollEvent("left", 30)).toBe(false) // h=3
    expect(admitScrollEvent("left", 40)).toBe(true) // h=4 = v+3 → flip, applied
    expect(admitScrollEvent("left", 50)).toBe(true)
    expect(admitScrollEvent("down", 60)).toBe(false) // now v is the stray
  })

  test("a pause longer than the gesture gap starts a fresh gesture", () => {
    expect(admitScrollEvent("left", 0)).toBe(true)
    expect(admitScrollEvent("down", 10)).toBe(false)
    // 250ms of silence → new gesture; vertical locks immediately.
    expect(admitScrollEvent("down", 260)).toBe(true)
    expect(admitScrollEvent("left", 270)).toBe(false)
  })

  test("events at exactly the gap boundary continue the gesture", () => {
    expect(admitScrollEvent("left", 0)).toBe(true)
    expect(admitScrollEvent("down", 200)).toBe(false) // 200ms later = same gesture
  })

  test("resetScrollAxisLock forgets the gesture", () => {
    expect(admitScrollEvent("left", 0)).toBe(true)
    resetScrollAxisLock()
    expect(admitScrollEvent("down", 10)).toBe(true) // fresh lock, not a stray
  })
})
