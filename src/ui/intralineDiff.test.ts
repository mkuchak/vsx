import { describe, expect, test } from "bun:test"
import {
  computeEmphasisRanges,
  computeIntralineForHunk,
  mergeRanges,
  pairChangeLines,
  smoothRanges,
} from "./intralineDiff"

describe("computeEmphasisRanges", () => {
  test("the motivating regression: a sub-word append is emphasized as exactly the appended chars", () => {
    // This is the case that forced the word-level -> char-level rewrite: with
    // diffWordsWithSpace, "source" -> "sourceasd" reads as a whole word
    // removed + a whole word added (no emphasis possible on the shared
    // "source" prefix). Char-level diffing recovers VSCode's real behavior:
    // only the trailing "asd" is new.
    const result = computeEmphasisRanges("### From source", "### From sourceasd")
    expect(result).toEqual({
      removed: [],
      added: [{ start: 15, end: 18 }],
    })
  })

  test("single-char change emphasizes exactly the changed character on each side", () => {
    const result = computeEmphasisRanges("const a = 1", "const a = 2")
    expect(result).toEqual({
      removed: [{ start: 10, end: 11 }],
      added: [{ start: 10, end: 11 }],
    })
  })

  test("appending a parameter emphasizes exactly the inserted span on the added side", () => {
    // Nothing was deleted, only inserted — the removed side has no changed spans.
    const result = computeEmphasisRanges(
      "function resolveDiff(service: GitService, tab: DiffTab)",
      "function resolveDiff(service: GitService, tab: DiffTab, oldPath?: string)",
    )
    expect(result?.removed).toEqual([])
    expect(result?.added).toEqual([{ start: 54, end: 72 }])
  })

  test("a single-word swap is not suppressed and stays confined to the changed word", () => {
    // "Started" and "Finished" share the suffix "ed", so diffChars aligns on
    // it; smoothing may or may not bridge that shared tail depending on its
    // length, so we assert containment within the word's region rather than
    // exact sub-ranges.
    const result = computeEmphasisRanges("# Getting Started", "# Getting Finished")
    expect(result).not.toBeNull()
    const removedWordStart = "# Getting ".length // 10
    const addedWordStart = "# Getting ".length // 10
    for (const r of result!.removed) {
      expect(r.start).toBeGreaterThanOrEqual(removedWordStart)
      expect(r.end).toBeLessThanOrEqual("# Getting Started".length)
    }
    for (const r of result!.added) {
      expect(r.start).toBeGreaterThanOrEqual(addedWordStart)
      expect(r.end).toBeLessThanOrEqual("# Getting Finished".length)
    }
    expect(result!.removed.length).toBeGreaterThan(0)
    expect(result!.added.length).toBeGreaterThan(0)
  })

  test("whitespace-only change doesn't crash and yields a sane result", () => {
    // "   " (3 spaces) vs "\t": entirely distinct single-char content on a
    // 3-char line -> removed side ratio 3/3 = 1.0 > MAX_CHANGED_RATIO.
    const result = computeEmphasisRanges("   ", "\t")
    expect(result).toBeNull()
  })

  test("similarity guard: exact per-side-ratio threshold boundary", () => {
    // Shared 3-char prefix "abc" + a fully-distinct x-char run on each side.
    // ratio = x / (3 + x) computed independently per side (both sides equal
    // length here, so removedRatio === addedRatio).
    // x=7: ratio = 7/10 = 0.7 exactly -> guard only fires on strictly >, so
    // this is kept.
    const atBoundary = computeEmphasisRanges("abc1111111", "abc2222222")
    expect(atBoundary).toEqual({
      removed: [{ start: 3, end: 10 }],
      added: [{ start: 3, end: 10 }],
    })
    // x=8: ratio = 8/11 ~= 0.727 > 0.7 -> guard fires.
    const overBoundary = computeEmphasisRanges("abc11111111", "abc22222222")
    expect(overBoundary).toBeNull()
  })

  test("a mostly-rewritten line is nulled out entirely", () => {
    const result = computeEmphasisRanges("hello world foo bar", "zzzz yyyy xxxx wwww")
    expect(result).toBeNull()
  })

  test("smoothing: single-char edits separated by a 1-char gap collapse into one span per side", () => {
    // A long, mostly-unchanged prefix keeps the per-side ratio low (so the
    // guard doesn't fire), followed by "abcdef" -> "aXcYeZ": b/d/f each
    // replaced, each separated from the next by exactly one unchanged char
    // (c, e) -> gap 1 <= the smoothing max gap of 2, so all three merge into
    // a single span per side instead of three 1-character shards.
    const prefix = "prefix_of_twenty_ch_" // 20 chars, unchanged on both sides
    const result = computeEmphasisRanges(prefix + "abcdef", prefix + "aXcYeZ")
    expect(result).toEqual({
      removed: [{ start: 21, end: 26 }],
      added: [{ start: 21, end: 26 }],
    })
  })

  test("smoothing: changes separated by more than the max gap stay as distinct spans", () => {
    // "cat" -> "car" and, well past it (12 unchanged chars later), "dog" ->
    // "dot": the gap between the two changed spans is far more than the
    // smoothing max gap, so they remain two separate spans.
    const result = computeEmphasisRanges("cat is here, dog runs", "car is here, dot runs")
    expect(result).toEqual({
      removed: [
        { start: 2, end: 3 },
        { start: 15, end: 16 },
      ],
      added: [
        { start: 2, end: 3 },
        { start: 15, end: 16 },
      ],
    })
  })

  test("mergeRanges combines touching and overlapping ranges into one contiguous span", () => {
    // Touching: [0,3) and [3,6) share the boundary at 3 -> one span [0,6).
    expect(mergeRanges([{ start: 0, end: 3 }, { start: 3, end: 6 }])).toEqual([
      { start: 0, end: 6 },
    ])
    // Overlapping: [0,4) and [2,6) -> one span [0,6).
    expect(mergeRanges([{ start: 0, end: 4 }, { start: 2, end: 6 }])).toEqual([
      { start: 0, end: 6 },
    ])
    // Out of order input is sorted first, still merges correctly.
    expect(mergeRanges([{ start: 5, end: 8 }, { start: 0, end: 5 }])).toEqual([
      { start: 0, end: 8 },
    ])
    // A real gap must NOT merge.
    expect(mergeRanges([{ start: 0, end: 2 }, { start: 5, end: 7 }])).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ])
  })

  test("multi-byte / wide character line doesn't crash and ranges are UTF-16 code units", () => {
    const result = computeEmphasisRanges("const rocket = '🚀'", "const rocket = '🔥'")
    // Both emoji are astral (2 UTF-16 code units each); start/end must reflect
    // JS string indices, not code points or terminal display width.
    expect(result).toEqual({
      removed: [{ start: 16, end: 18 }],
      added: [{ start: 16, end: 18 }],
    })
  })
})

describe("smoothRanges", () => {
  test("merges ranges separated by a gap <= maxGap", () => {
    expect(
      smoothRanges([{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 5, end: 6 }], 2),
    ).toEqual([{ start: 1, end: 6 }])
  })

  test("leaves ranges separated by a gap > maxGap distinct", () => {
    expect(smoothRanges([{ start: 2, end: 3 }, { start: 15, end: 16 }], 2)).toEqual([
      { start: 2, end: 3 },
      { start: 15, end: 16 },
    ])
  })

  test("a gap exactly equal to maxGap still merges (inclusive boundary)", () => {
    expect(smoothRanges([{ start: 0, end: 1 }, { start: 3, end: 4 }], 2)).toEqual([
      { start: 0, end: 4 },
    ])
  })

  test("a gap of maxGap + 1 does not merge", () => {
    expect(smoothRanges([{ start: 0, end: 1 }, { start: 4, end: 5 }], 2)).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ])
  })

  test("touching and overlapping ranges also merge (gap <= 0)", () => {
    expect(smoothRanges([{ start: 0, end: 3 }, { start: 3, end: 6 }], 2)).toEqual([
      { start: 0, end: 6 },
    ])
    expect(smoothRanges([{ start: 0, end: 4 }, { start: 2, end: 6 }], 2)).toEqual([
      { start: 0, end: 6 },
    ])
  })

  test("empty input yields empty output", () => {
    expect(smoothRanges([], 2)).toEqual([])
  })
})

describe("pairChangeLines", () => {
  test("pairs by index within a change block; surplus adds are unpaired", () => {
    const hunkLines = ["-r0", "-r1", "+a0", "+a1", "+a2"]
    expect(pairChangeLines(hunkLines)).toEqual([
      { removedIdx: 0, addedIdx: 2 },
      { removedIdx: 1, addedIdx: 3 },
    ])
  })

  test("context lines split and reset change blocks", () => {
    const hunkLines = [" ctx0", "-r0", "+a0", " ctx1", "-r1", "+a1"]
    expect(pairChangeLines(hunkLines)).toEqual([
      { removedIdx: 1, addedIdx: 2 },
      { removedIdx: 4, addedIdx: 5 },
    ])
  })

  test('"\\ No newline at end of file" markers are skipped and do not corrupt indices', () => {
    // A trailing-line edit where both old and new lack a final newline: the
    // marker line ends the remove-run before the add is seen, and again ends
    // the add-run — mirroring @opentui/core's buildSplitView, this means the
    // remove and add do NOT get paired (each becomes its own unbalanced block).
    const hunkLines = [
      "-old last line",
      "\\ No newline at end of file",
      "+new last line",
      "\\ No newline at end of file",
    ]
    expect(pairChangeLines(hunkLines)).toEqual([])
  })

  test("a normal pair before a marker-interrupted trailing pair keeps correct indices", () => {
    const hunkLines = ["-r0", "+a0", "-r1", "\\ No newline at end of file", "+a1"]
    // r1/a1 straddle the marker and do not pair; r0/a0 pairs correctly at its
    // own (unshifted) indices.
    expect(pairChangeLines(hunkLines)).toEqual([{ removedIdx: 0, addedIdx: 1 }])
  })
})

describe("computeIntralineForHunk", () => {
  test("combines pairing + emphasis, keyed by index within hunkLines, for both sides", () => {
    const hunkLines = [" context", "-const a = 1", "+const a = 2"]
    const map = computeIntralineForHunk(hunkLines)
    expect(map.get(1)).toEqual([{ start: 10, end: 11 }])
    expect(map.get(2)).toEqual([{ start: 10, end: 11 }])
    expect(map.has(0)).toBe(false)
  })

  test("a similarity-guarded pair contributes no entries for either line", () => {
    const hunkLines = ["-foo bar baz qux corge", "+zzz yyy xxx www vvv"]
    const map = computeIntralineForHunk(hunkLines)
    expect(map.size).toBe(0)
  })
})
