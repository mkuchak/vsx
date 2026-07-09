import {
  DiffRenderable,
  parseColor,
  RGBA,
  type ChunkRenderContext,
  type DiffRenderableOptions,
  type MouseEvent as CoreMouseEvent,
  type RenderContext,
  type TextChunk,
} from "@opentui/core"
import { extend } from "@opentui/react"
import type { StructuredPatch } from "diff"
import { computeIntralineForHunk, type Range } from "./intralineDiff"

/**
 * `DiffRenderable.buildView` (and the `_parsedDiff`/`leftCodeRenderable`/
 * `rightCodeRenderable` fields it populates) is TS-`private` in
 * @opentui/core@0.4.2 — there is no public API for intra-line emphasis, nor for
 * driving horizontal scroll (`DiffRenderableOptions`/`DiffRenderable` expose no
 * `scrollX`), so this renders and scrolls on top of the compiled JS internals via
 * `as unknown as ...`/prototype access. MUST be re-verified against
 * `node_modules/@opentui/core/index.js` (search `class DiffRenderable`,
 * `buildUnifiedView`, `buildSplitView`) on any `@opentui/core` version bump — a
 * rename or reshuffle of those internals will silently drop emphasis rendering
 * and/or horizontal scroll without a type error.
 */

type EmphasisRange = Range & { bg: RGBA }
type EmphasisMap = Map<number, EmphasisRange[]>

/**
 * Walks `parsedDiff.hunks` twice, mirroring exactly the two line-accumulation
 * loops `buildUnifiedView`/`buildSplitView` use internally (same skip-on-`\`,
 * same remove/add run grouping as `pairChangeLines`), to translate the
 * per-hunk-local-index ranges from {@link computeIntralineForHunk} into
 * per-rendered-row-index ranges for each of the three code surfaces a
 * `DiffRenderable` can show: the single unified surface, and the split view's
 * left/right surfaces.
 */
function buildEmphasisModel(
  parsedDiff: StructuredPatch,
  addedBg: RGBA,
  removedBg: RGBA,
): { unified: EmphasisMap; left: EmphasisMap; right: EmphasisMap } {
  const unified: EmphasisMap = new Map()
  const left: EmphasisMap = new Map()
  const right: EmphasisMap = new Map()

  let unifiedIdx = 0
  let leftIdx = 0
  let rightIdx = 0

  for (const hunk of parsedDiff.hunks) {
    const hunkRanges = computeIntralineForHunk(hunk.lines)

    // Unified: every non-"\" line becomes one row on the single surface.
    for (let i = 0; i < hunk.lines.length; i++) {
      const marker = hunk.lines[i][0]
      if (marker === "\\") continue
      const ranges = hunkRanges.get(i)
      if (ranges && ranges.length > 0) {
        const bg = marker === "+" ? addedBg : removedBg
        unified.set(
          unifiedIdx,
          ranges.map((r) => ({ ...r, bg })),
        )
      }
      unifiedIdx++
    }

    // Split: context lines advance both sides together; a run of "-"/"+" lines
    // (broken by " " or "\", exactly like pairChangeLines) zips removes[j] with
    // adds[j], padding the shorter side with an unranged filler row.
    let i = 0
    while (i < hunk.lines.length) {
      const marker = hunk.lines[i][0]
      if (marker === " ") {
        leftIdx++
        rightIdx++
        i++
        continue
      }
      if (marker === "\\") {
        i++
        continue
      }
      const removedIdxs: number[] = []
      const addedIdxs: number[] = []
      while (i < hunk.lines.length) {
        const cur = hunk.lines[i][0]
        if (cur === " " || cur === "\\") break
        if (cur === "-") removedIdxs.push(i)
        else addedIdxs.push(i)
        i++
      }
      const max = Math.max(removedIdxs.length, addedIdxs.length)
      for (let j = 0; j < max; j++) {
        if (j < removedIdxs.length) {
          const ranges = hunkRanges.get(removedIdxs[j])
          if (ranges && ranges.length > 0) {
            left.set(
              leftIdx,
              ranges.map((r) => ({ ...r, bg: removedBg })),
            )
          }
        }
        leftIdx++
        if (j < addedIdxs.length) {
          const ranges = hunkRanges.get(addedIdxs[j])
          if (ranges && ranges.length > 0) {
            right.set(
              rightIdx,
              ranges.map((r) => ({ ...r, bg: addedBg })),
            )
          }
        }
        rightIdx++
      }
    }
  }

  return { unified, left, right }
}

/**
 * Split `chunks` at every emphasis-range boundary within `content`, setting
 * `bg` only on the emphasized slice(s) while every other slice keeps the
 * originating chunk's `fg`/`attributes` untouched. Assumes (matches DiffPane's
 * usage, which never sets `conceal`) that `chunks` losslessly partitions
 * `content` in order — concealment can replace slices of `content` with
 * different-length replacement text, which would desync this offset math.
 */
function emphasizeChunks(chunks: TextChunk[], content: string, emphasisMap: EmphasisMap): TextChunk[] {
  if (emphasisMap.size === 0) return chunks

  const absRanges: EmphasisRange[] = []
  const lines = content.split("\n")
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const ranges = emphasisMap.get(i)
    if (ranges) {
      for (const r of ranges) absRanges.push({ start: offset + r.start, end: offset + r.end, bg: r.bg })
    }
    offset += lines[i].length + 1
  }
  if (absRanges.length === 0) return chunks

  const result: TextChunk[] = []
  let rangeIdx = 0
  let pos = 0
  for (const chunk of chunks) {
    const text = chunk.text
    const chunkStart = pos
    const chunkEnd = pos + text.length
    let cursor = chunkStart
    while (rangeIdx < absRanges.length && absRanges[rangeIdx].end <= chunkStart) rangeIdx++
    let k = rangeIdx
    while (k < absRanges.length && absRanges[k].start < chunkEnd) {
      const r = absRanges[k]
      const segStart = Math.max(r.start, chunkStart)
      const segEnd = Math.min(r.end, chunkEnd)
      if (segStart > cursor) {
        result.push({ ...chunk, text: text.slice(cursor - chunkStart, segStart - chunkStart) })
      }
      if (segEnd > segStart) {
        result.push({ ...chunk, text: text.slice(segStart - chunkStart, segEnd - chunkStart), bg: r.bg })
      }
      cursor = segEnd
      if (r.end > chunkEnd) break // range continues into the next chunk; revisit it there
      k++
    }
    if (cursor < chunkEnd) {
      result.push({ ...chunk, text: text.slice(cursor - chunkStart) })
    }
    rangeIdx = k
    pos = chunkEnd
  }
  return result
}

export interface IntralineDiffOptions extends DiffRenderableOptions {
  addedEmphasisBg?: string | RGBA
  removedEmphasisBg?: string | RGBA
}

const DEFAULT_ADDED_EMPHASIS_BG = "#2ea043"
const DEFAULT_REMOVED_EMPHASIS_BG = "#f85149"

/**
 * The slice of `CodeRenderable`'s (genuinely public, per Code.d.ts/TextBufferRenderable.d.ts)
 * API this file drives directly: emphasis chunk rewriting, plus horizontal-scroll state and
 * the wheel handler that mutates it. `handleScroll` is `protected` in the .d.ts (not
 * `private`, unlike the fields below), but TS still forbids assigning to a protected member
 * from outside the class, so it needs the same `as unknown as` treatment as everything else
 * reached through `DiffRenderableInternals`.
 */
interface CodeRenderableInternals {
  onChunks: (chunks: TextChunk[], ctx: ChunkRenderContext) => TextChunk[]
  scrollX: number
  scrollY: number
  readonly maxScrollX: number
  /** Content width in cols (`lineInfo.lineWidthColsMax`) — the scrollbar's `scrollSize`. */
  readonly scrollWidth: number
  /** Layout (viewport) width in cols — the scrollbar's `viewportSize`. */
  readonly width: number
  readonly wrapMode: "none" | "char" | "word"
  handleScroll: (event: CoreMouseEvent) => void
  /** Own-instance marker so a rebuild's repeat `applyEmphasis()` call doesn't re-wrap an already-patched `handleScroll`. */
  __shiftScrollPatched?: boolean
}

/** TS-private internals of `DiffRenderable` this subclass reaches into — see the file-level comment. */
interface DiffRenderableInternals {
  _parsedDiff: StructuredPatch | null
  _view: "unified" | "split"
  leftCodeRenderable: CodeRenderableInternals | null
  rightCodeRenderable: CodeRenderableInternals | null
}

/**
 * Replacement `handleScroll` for each side's `CodeRenderable`, patched in once per
 * instance (see {@link patchScrollBehavior}). Identical to the stock behavior
 * (`@opentui/core`'s `TextBufferRenderable.handleScroll`) except a Shift-held wheel
 * remaps up/down into left/right — the conventional "shift+wheel = horizontal scroll"
 * gesture, which the stock handler never recognizes (it only reacts to a genuine
 * native left/right wheel report, which real trackpads/mice rarely send). Horizontal
 * movement stays gated on `wrapMode === "none"` — the only mode where a line can be
 * wider than the viewport in the first place — matching the stock guard.
 */
function shiftAwareHandleScroll(this: CodeRenderableInternals, event: CoreMouseEvent): void {
  if (!event.scroll) return
  let direction = event.scroll.direction
  const delta = event.scroll.delta
  if (event.modifiers.shift && (direction === "up" || direction === "down")) {
    direction = direction === "up" ? "left" : "right"
  }
  if (direction === "up") this.scrollY -= delta
  else if (direction === "down") this.scrollY += delta
  else if (this.wrapMode === "none") {
    if (direction === "left") this.scrollX -= delta
    else if (direction === "right") this.scrollX += delta
  }
}

/** Instance-patch each side's `handleScroll` once so a plain object identity check survives rebuilds. */
function patchScrollBehavior(self: DiffRenderableInternals): void {
  for (const side of [self.leftCodeRenderable, self.rightCodeRenderable]) {
    if (side && !side.__shiftScrollPatched) {
      side.__shiftScrollPatched = true
      side.handleScroll = shiftAwareHandleScroll
    }
  }
}

export class IntralineDiffRenderable extends DiffRenderable {
  private _addedEmphasisBg: RGBA
  private _removedEmphasisBg: RGBA

  constructor(ctx: RenderContext, options: IntralineDiffOptions) {
    super(ctx, options)
    this._addedEmphasisBg = parseColor(options.addedEmphasisBg ?? DEFAULT_ADDED_EMPHASIS_BG)
    this._removedEmphasisBg = parseColor(options.removedEmphasisBg ?? DEFAULT_REMOVED_EMPHASIS_BG)
    // The base constructor already built the initial view (synchronously, since
    // `_diff` was set from `options.diff`) before these fields could be assigned —
    // apply emphasis once now that they're ready.
    this.applyEmphasis()
  }

  get addedEmphasisBg(): RGBA {
    return this._addedEmphasisBg
  }
  set addedEmphasisBg(value: string | RGBA) {
    this._addedEmphasisBg = parseColor(value)
    this.applyEmphasis()
  }

  get removedEmphasisBg(): RGBA {
    return this._removedEmphasisBg
  }
  set removedEmphasisBg(value: string | RGBA) {
    this._removedEmphasisBg = parseColor(value)
    this.applyEmphasis()
  }

  // `buildView`/`rebuildView`/`requestRebuild` are TS-private on DiffRenderable, so
  // this can't override them directly (TS2415: a subclass may not redeclare a
  // same-named private base member, even at a different visibility). Instead,
  // re-run `applyEmphasis()` after every PUBLIC setter that can change what
  // `buildView` produces (`diff`, `view`, `filetype`) — each accessor pair must be
  // overridden together (a lone `set` shadows the inherited `get` with `undefined`).
  // `view`'s rebuild is synchronous but `diff`/`filetype` defer to a queued
  // microtask when the current view is "split" (`requestRebuild`); queuing our own
  // reapplication on a microtask too guarantees it runs strictly after theirs
  // (FIFO), so it always sees the post-rebuild CodeRenderables. This does NOT cover
  // the wrap-driven `onResize` rebuild path, which is unreachable because DiffPane
  // pins `wrapMode="none"` (that rebuild only fires under "word"/"char").

  get diff(): string {
    return super.diff
  }
  set diff(value: string) {
    super.diff = value
    this.scheduleApplyEmphasis()
  }

  get view(): "unified" | "split" {
    return super.view
  }
  set view(value: "unified" | "split") {
    const changed = super.view !== value
    super.view = value
    // Reset horizontal scroll on a real view change. The base class KEEPS the
    // no-longer-rendered side's CodeRenderable (with its scroll state) alive across
    // toggles, so without this a split-view scroll would survive detached on the
    // right side: the max-based `scrollX` getter would read it back in unified view
    // (teleporting the surface on the next keypress), and toggling back to split
    // would restore desynced sides — the shorter one clamped to 0, rendering blank.
    if (changed) this.scrollX = 0
    this.scheduleApplyEmphasis()
  }

  get filetype(): string | undefined {
    return super.filetype
  }
  set filetype(value: string | undefined) {
    super.filetype = value
    this.scheduleApplyEmphasis()
  }

  /**
   * Horizontal scroll offset, mirrored across both sides in split view (so the two
   * panes never drift apart regardless of which one a mouse/keyboard scroll targets).
   * The getter takes the LARGER of the two sides' own (self-clamped) `scrollX`
   * values rather than e.g. always preferring the left side: a modified line's two
   * sides are rarely the same width (an add/remove-heavy hunk can leave one side
   * far shorter than the other), and the shorter side's own setter clamps itself to
   * ITS OWN lower `maxScrollX` — reading that side unconditionally would report a
   * stuck 0 even while the other, longer side (and the diff as a whole) has scrolled.
   * Since a set always pushes the same value to both sides (below), and `DiffRenderable`'s
   * own `onMouseEvent` mirror does the same for a direct wheel scroll on one side, the
   * longer side's value is always the authoritative "current position" to read back.
   */
  get scrollX(): number {
    const self = this as unknown as DiffRenderableInternals
    return Math.max(self.leftCodeRenderable?.scrollX ?? 0, self.rightCodeRenderable?.scrollX ?? 0)
  }
  set scrollX(value: number) {
    const self = this as unknown as DiffRenderableInternals
    if (self.leftCodeRenderable) self.leftCodeRenderable.scrollX = value
    if (self.rightCodeRenderable) self.rightCodeRenderable.scrollX = value
  }

  /** The larger of the two sides' `maxScrollX` — in split view a shorter side clamps its own `scrollX` lower, but the mirror above still lets the longer side keep scrolling. */
  get maxScrollX(): number {
    const self = this as unknown as DiffRenderableInternals
    return Math.max(self.leftCodeRenderable?.maxScrollX ?? 0, self.rightCodeRenderable?.maxScrollX ?? 0)
  }

  /**
   * Per-side horizontal scroll state, for driving one external scrollbar per code
   * surface (the aggregate `scrollX`/`maxScrollX` above intentionally hide which
   * side is which). Returns `null` while that side's CodeRenderable doesn't exist
   * (`right` is null until the first split build; both are null before any diff).
   * Note this reports whatever the side OBJECT says, attached or not: in unified
   * view only the left side is rendered, but a `rightCodeRenderable` left over
   * from an earlier split build stays alive DETACHED with stale state — the
   * caller decides which sides to consult for the current view.
   */
  getHorizontalScrollState(side: "left" | "right"): { scrollX: number; maxScrollX: number; scrollWidth: number; width: number } | null {
    const self = this as unknown as DiffRenderableInternals
    const code = side === "left" ? self.leftCodeRenderable : self.rightCodeRenderable
    if (!code) return null
    return { scrollX: code.scrollX, maxScrollX: code.maxScrollX, scrollWidth: code.scrollWidth, width: code.width }
  }

  private scheduleApplyEmphasis(): void {
    queueMicrotask(() => {
      if (!this.isDestroyed) this.applyEmphasis()
    })
  }

  private applyEmphasis(): void {
    const self = this as unknown as DiffRenderableInternals
    patchScrollBehavior(self)
    // Re-clamp horizontal scroll after any rebuild: the core never re-clamps a
    // side's stored scrollX when its content changes, so a background reload that
    // shortens the longest line would otherwise leave the surface stranded past
    // maxScrollX (visibly blank) until the next scroll input. Assigning through
    // the setter pushes the current position through each side's own clamp.
    this.scrollX = this.scrollX
    const parsedDiff = self._parsedDiff
    if (!parsedDiff || parsedDiff.hunks.length === 0) return

    const model = buildEmphasisModel(parsedDiff, this._addedEmphasisBg, this._removedEmphasisBg)

    if (self._view === "unified") {
      if (self.leftCodeRenderable) {
        self.leftCodeRenderable.onChunks = (chunks, ctx) => emphasizeChunks(chunks, ctx.content, model.unified)
      }
      return
    }

    if (self.leftCodeRenderable) {
      self.leftCodeRenderable.onChunks = (chunks, ctx) => emphasizeChunks(chunks, ctx.content, model.left)
    }
    if (self.rightCodeRenderable) {
      self.rightCodeRenderable.onChunks = (chunks, ctx) => emphasizeChunks(chunks, ctx.content, model.right)
    }
  }
}

// Not in @opentui/react's default component catalogue, so register it once at
// module load — same pattern as EditorPane.tsx's `scrollbar` and ThinHScrollBar.ts.
declare module "@opentui/react" {
  interface OpenTUIComponents {
    "intraline-diff": typeof IntralineDiffRenderable
  }
}
extend({
  "intraline-diff": IntralineDiffRenderable,
})
