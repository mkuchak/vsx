import { expect, test } from "bun:test"
import { createNativeOffsetConverter } from "./highlightOffsets"

// Every expected number below was computed independently (see the task's
// verification step) by running createNativeOffsetConverter against the exact
// fixture and diffing against a live OpenTUI EditBuffer's getLineHighlights —
// these aren't guesses, they're the ground truth the native buffer agrees with.

test("a span entirely on line 1 (no preceding newline): JS offset equals native offset", () => {
  const toNative = createNativeOffsetConverter("hello world\n")
  // "llo" at [2, 5) — every char before it is single-width ASCII, so nothing
  // to subtract.
  expect(toNative(2)).toBe(2)
  expect(toNative(5)).toBe(5)
})

test("a span on line N>1: native offset is JS offset minus one per preceding newline", () => {
  const toNative = createNativeOffsetConverter("aaa\nbbb\nccc\n")
  // "ccc" starts at JS offset 8 (after "aaa\nbbb\n"); two preceding newlines
  // contribute zero width, so native = 8 - 2 = 6.
  expect(toNative(8)).toBe(6)
  // End of "ccc" (JS 11) → native 9.
  expect(toNative(11)).toBe(9)
})

test("a multi-line span (e.g. a 3-line block comment): start and end both convert correctly", () => {
  // Lines: 0 "a", 1 "/*", 2 "foo", 3 "*/", 4 "b". The "comment" spans from the
  // start of line 1 through the end of line 3: JS [2, 11) = "/*\nfoo\n*/".
  const text = "a\n/*\nfoo\n*/\nb\n"
  const toNative = createNativeOffsetConverter(text)
  expect(text.slice(2, 11)).toBe("/*\nfoo\n*/")
  // One newline precedes the start (after "a\n") → native = 2 - 1 = 1.
  expect(toNative(2)).toBe(1)
  // Three newlines precede the end (after "a\n", "/*\n", "foo\n") → native = 11 - 3 = 8.
  expect(toNative(11)).toBe(8)
})

test("a wide/double-width CJK character before the span shifts native offset by its display width, not UTF-16 length", () => {
  // "你" and "好" are each 1 UTF-16 unit but display-width 2 (Bun.stringWidth).
  const toNative = createNativeOffsetConverter("你好abc\n")
  // "abc" starts at JS offset 2, but native offset is 4 (2 chars * width 2 each).
  expect(toNative(2)).toBe(4)
  expect(toNative(5)).toBe(7)
})

test("an astral (surrogate-pair) emoji before the span maps by code point, not UTF-16 unit", () => {
  // "😀" is a surrogate pair: 2 UTF-16 units, but ONE code point of display width 2.
  const toNative = createNativeOffsetConverter("😀abc\n")
  // "abc" starts at JS offset 2 (past the 2-unit surrogate pair); native offset
  // is also 2 (the emoji's display width) — not 1 (if code points were
  // miscounted) and not 4 (if surrogate units were double-counted).
  expect(toNative(2)).toBe(2)
  expect(toNative(5)).toBe(5)
})

test("a tab character before the span contributes zero width (Bun.stringWidth('\\t') === 0)", () => {
  const toNative = createNativeOffsetConverter("\tabc\n")
  expect(Bun.stringWidth("\t")).toBe(0)
  // "abc" starts at JS offset 1 (past the tab), but native offset is 0 — the
  // tab didn't advance the native cursor at all.
  expect(toNative(1)).toBe(0)
  expect(toNative(4)).toBe(3)
})

test("offset exactly at end-of-file equals the total native width", () => {
  const text = "abc\n"
  const toNative = createNativeOffsetConverter(text)
  // 3 single-width chars + a zero-width newline = native width 3.
  expect(toNative(text.length)).toBe(3)
})

test("an out-of-range offset clamps instead of throwing or returning undefined", () => {
  const text = "abc\n"
  const toNative = createNativeOffsetConverter(text)
  expect(toNative(-5)).toBe(0)
  expect(toNative(100)).toBe(3)
  expect(toNative(100)).toBe(toNative(text.length))
})

test("an empty span (start === end) converts to an empty native span", () => {
  const toNative = createNativeOffsetConverter("abc\n")
  const start = toNative(2)
  const end = toNative(2)
  expect(end - start).toBe(0)
})
