import { diffChars } from "diff"

/**
 * A half-open column range `[start, end)` in JS string indices (UTF-16 code
 * units) of a line's raw text, WITHOUT the leading `+`/`-`/` ` marker char.
 * Multi-byte / wide (CJK, emoji) characters occupy 1-2 UTF-16 units here
 * regardless of their terminal display width; mapping onto display columns is
 * the rendering layer's job (the text buffer already handles wide-char width),
 * not this module's.
 */
export type Range = { start: number; end: number }

/**
 * Emphasize a paired line only when the changed portion of THAT SIDE is at
 * most this fraction of that side's own raw length — mirrors VSCode's own
 * gating heuristic: a mostly-rewritten line reads better as a plain
 * solid-color replacement than as a sea of tiny emphasized shards. The ratio
 * is computed per side (removed vs. added independently, see
 * {@link computeEmphasisRanges}) rather than as one combined fraction: a
 * combined fraction double-counts every replaced token (once as removed-side
 * length, once as added-side length), which pushed even a clean single-word
 * swap like `Started` -> `Finished` over threshold and wrongly suppressed it.
 */
export const MAX_CHANGED_RATIO = 0.7

/**
 * Pair consecutive `-`/`+` runs within a hunk by index, mirroring exactly how
 * the installed @opentui/core 0.4.2 `DiffRenderable.buildSplitView` zips
 * `removes[j]` <-> `adds[j]` per change block (node_modules/@opentui/core/index.js,
 * `buildSplitView`): within each contiguous run of `-`/`+` lines, remove-line
 * `j` pairs with add-line `j` (0-indexed within that run); surplus lines on
 * either side (more removes than adds, or vice versa) get no partner and are
 * left out of the result. A ` ` (context) or `\` ("No newline") line always
 * ends the current run, same as in buildSplitView's line-collection loop —
 * notably a run interrupted by a `\` marker line is NOT resumed afterward,
 * so a remove immediately followed by a marker and then an add do NOT pair
 * (they become the start of two separate, individually-unbalanced runs).
 */
export function pairChangeLines(
  hunkLines: string[],
): Array<{ removedIdx: number; addedIdx: number }> {
  const pairs: Array<{ removedIdx: number; addedIdx: number }> = []
  let i = 0
  while (i < hunkLines.length) {
    const c = hunkLines[i][0]
    if (c !== "-" && c !== "+") {
      i++
      continue
    }
    const removes: number[] = []
    const adds: number[] = []
    while (i < hunkLines.length) {
      const cur = hunkLines[i][0]
      if (cur === "-") {
        removes.push(i)
        i++
      } else if (cur === "+") {
        adds.push(i)
        i++
      } else {
        break
      }
    }
    const n = Math.min(removes.length, adds.length)
    for (let j = 0; j < n; j++) {
      pairs.push({ removedIdx: removes[j], addedIdx: adds[j] })
    }
  }
  return pairs
}

/**
 * Merge adjacent (touching) and overlapping ranges into contiguous spans.
 * Exported mainly for direct unit testing: in practice {@link smoothRanges}
 * already absorbs everything within `maxGap` (which subsumes touching/
 * overlapping, gap <= 0) before this runs, so this rarely has work left to
 * do on real diff output — it's a defensive correctness guarantee for
 * whatever raw ranges a caller hands it, not a routinely-exercised path.
 */
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: Range[] = [{ ...sorted[0] }]
  for (const r of sorted.slice(1)) {
    const last = merged[merged.length - 1]
    if (r.start <= last.end) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}

/**
 * Merge same-side ranges separated by a small unchanged gap (Monaco/VSCode-
 * style "smoothing"), so that a run of nearby single-character edits reads
 * as one emphasized span instead of a shard per character. Two consecutive
 * ranges are merged (absorbing the unchanged gap between them into the
 * emphasized span) whenever that gap is <= `maxGap` columns; a gap of 0 or
 * negative (touching/overlapping) also merges, so this is a superset of
 * {@link mergeRanges} for a single side — callers should still run
 * `mergeRanges` afterward for defense-in-depth, but it's normally a no-op
 * here since sorted+merged-as-we-go already leaves no touching pairs behind.
 */
export function smoothRanges(ranges: Range[], maxGap: number): Range[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const smoothed: Range[] = [{ ...sorted[0] }]
  for (const r of sorted.slice(1)) {
    const last = smoothed[smoothed.length - 1]
    if (r.start - last.end <= maxGap) {
      last.end = Math.max(last.end, r.end)
    } else {
      smoothed.push({ ...r })
    }
  }
  return smoothed
}

/** Max unchanged-character gap that still gets bridged by {@link smoothRanges}. */
const SMOOTHING_MAX_GAP = 2

/**
 * Character-level diff (VSCode-parity — see below) between a paired
 * removed/added line, returning the changed column ranges on each side, or
 * `null` when the similarity guard says the line was mostly rewritten (see
 * {@link MAX_CHANGED_RATIO}).
 *
 * This used to be word-level (`diffWordsWithSpace`), on the theory that
 * char-level diffs were "too noisy". That theory was wrong: word-level diffing
 * treats a sub-word edit like `source` -> `sourceasd` as a whole-word removal
 * plus a whole-word addition, so it can never emphasize just the appended
 * `asd` — exactly the case VSCode itself highlights precisely. Char-level
 * diffing plus {@link smoothRanges} recovers VSCode's actual behavior: fine
 * enough to catch sub-word edits, coarse enough (after smoothing bridges
 * small gaps) to avoid a shard per changed character.
 *
 * The similarity guard is evaluated PER SIDE, after smoothing:
 * `removedRatio = (smoothed removed chars) / removedText.length` and
 * likewise for `addedRatio`, each defined as 0 when that side's text is
 * empty. Either side exceeding {@link MAX_CHANGED_RATIO} suppresses the
 * whole result. A combined (both-sides-summed) ratio was tried first and
 * rejected: it double-counts every replacement (once as removed length, once
 * as added length), so even a clean single-word swap like `Started` ->
 * `Finished` (removed=7, added=8, combined ratio (7+8)/8 ~ 1.9 on a
 * same-length line) scored as if the whole line changed. Per-side scoring
 * only suppresses when a side is *itself* mostly rewritten, which is what
 * "mostly rewritten line" should actually mean.
 */
export function computeEmphasisRanges(
  removedText: string,
  addedText: string,
): { removed: Range[]; added: Range[] } | null {
  const parts = diffChars(removedText, addedText)
  const removedRanges: Range[] = []
  const addedRanges: Range[] = []
  let removedPos = 0
  let addedPos = 0

  for (const part of parts) {
    const len = part.value.length
    if (part.added) {
      addedRanges.push({ start: addedPos, end: addedPos + len })
      addedPos += len
    } else if (part.removed) {
      removedRanges.push({ start: removedPos, end: removedPos + len })
      removedPos += len
    } else {
      removedPos += len
      addedPos += len
    }
  }

  const smoothedRemoved = mergeRanges(smoothRanges(removedRanges, SMOOTHING_MAX_GAP))
  const smoothedAdded = mergeRanges(smoothRanges(addedRanges, SMOOTHING_MAX_GAP))

  const changedRemovedChars = smoothedRemoved.reduce((sum, r) => sum + (r.end - r.start), 0)
  const changedAddedChars = smoothedAdded.reduce((sum, r) => sum + (r.end - r.start), 0)
  const removedRatio = removedText.length > 0 ? changedRemovedChars / removedText.length : 0
  const addedRatio = addedText.length > 0 ? changedAddedChars / addedText.length : 0
  if (removedRatio > MAX_CHANGED_RATIO || addedRatio > MAX_CHANGED_RATIO) return null

  return { removed: smoothedRemoved, added: smoothedAdded }
}

/**
 * The single entry point the rendering layer consumes: for every paired
 * remove/add line in a hunk (see {@link pairChangeLines}), strip the leading
 * marker char and compute intra-line emphasis ranges, keyed by each line's
 * index within `hunkLines`. A pair skipped by the similarity guard
 * contributes no entries for either of its two lines.
 */
export function computeIntralineForHunk(hunkLines: string[]): Map<number, Range[]> {
  const result = new Map<number, Range[]>()
  for (const { removedIdx, addedIdx } of pairChangeLines(hunkLines)) {
    const removedText = hunkLines[removedIdx].slice(1)
    const addedText = hunkLines[addedIdx].slice(1)
    const ranges = computeEmphasisRanges(removedText, addedText)
    if (!ranges) continue
    result.set(removedIdx, ranges.removed)
    result.set(addedIdx, ranges.added)
  }
  return result
}
