import { expect, test } from "bun:test"
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "./sidebarWidth"

const TERM = 100 // ceiling = 100 - 40 = 60

test("passes an in-range delta through unchanged", () => {
  expect(clampSidebarWidth(32, 8, TERM)).toBe(40)
  expect(clampSidebarWidth(32, -5, TERM)).toBe(27)
  expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 0, TERM)).toBe(DEFAULT_SIDEBAR_WIDTH)
})

test("clamps at the minimum-width floor", () => {
  expect(clampSidebarWidth(32, -100, TERM)).toBe(MIN_SIDEBAR_WIDTH)
  expect(clampSidebarWidth(MIN_SIDEBAR_WIDTH, -1, TERM)).toBe(MIN_SIDEBAR_WIDTH)
})

test("clamps at the (termWidth - editor reserve) ceiling", () => {
  expect(clampSidebarWidth(32, 1000, TERM)).toBe(60)
  expect(clampSidebarWidth(59, 5, TERM)).toBe(60)
})

test("keeps the floor authoritative when the terminal is too narrow for the reserve", () => {
  // termWidth - 40 = 10 would fall below the floor; the floor must win.
  expect(clampSidebarWidth(32, 100, 50)).toBe(MIN_SIDEBAR_WIDTH)
  expect(clampSidebarWidth(32, -100, 50)).toBe(MIN_SIDEBAR_WIDTH)
})
