import {
  RGBA,
  ScrollBarRenderable,
  type OptimizedBuffer,
  type RenderContext,
  type ScrollBarOptions,
  type SliderRenderable,
} from "@opentui/core"
import { extend } from "@opentui/react"

/** A fully transparent bg so a half-block glyph composites over the pane beneath it. */
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)

/**
 * The [startX, endX] cell range the horizontal slider's thumb covers, recomputed from
 * the slider's public state. Mirrors OpenTUI's own SliderRenderable geometry
 * (getVirtualThumbSize/Start → realStartCell/realEndCell in renderHorizontal), minus
 * the sub-cell ▌▐ end-cap finesse — with half-HEIGHT glyphs there's no quarter-block
 * to express a partial end cap, so thumb ends stay cell-granular.
 */
function thumbCellRange(slider: SliderRenderable): { startX: number; endX: number } {
  const width = slider.width
  const virtualTrackSize = width * 2
  const range = slider.max - slider.min

  let virtualThumbSize: number
  if (range === 0) {
    virtualThumbSize = virtualTrackSize
  } else {
    const viewportSize = Math.max(1, slider.viewPortSize)
    const contentSize = range + viewportSize
    if (contentSize <= viewportSize) {
      virtualThumbSize = virtualTrackSize
    } else {
      const thumbRatio = viewportSize / contentSize
      virtualThumbSize = Math.max(1, Math.min(Math.floor(virtualTrackSize * thumbRatio), virtualTrackSize))
    }
  }

  const virtualThumbStart =
    range === 0 ? 0 : Math.round(((slider.value - slider.min) / range) * (virtualTrackSize - virtualThumbSize))
  const virtualThumbEnd = virtualThumbStart + virtualThumbSize
  return {
    startX: Math.max(0, Math.floor(virtualThumbStart / 2)),
    endX: Math.min(width - 1, Math.ceil(virtualThumbEnd / 2) - 1),
  }
}

/**
 * Replacement horizontal render for the slider (bound as `this`). Paints EVERY cell of
 * the 1-row bar as `▄` — the bottom half-block — instead of the stock full-block `█`
 * body + solid track fillRect: the thumb's `▄` is in the thumb color, the track's `▄`
 * is in the track color, both over a transparent bg so the pane shows through the TOP
 * half. That makes the bar read half-a-row tall, giving visual parity with the 1-COLUMN
 * vertical bar (a terminal cell is ~2:1 tall:wide, so a full-height horizontal row looks
 * ~2× thicker than the vertical bar). Vertical sliders are never patched, so their
 * render is untouched.
 */
function renderThinHorizontal(this: SliderRenderable, buffer: OptimizedBuffer): void {
  const { startX, endX } = thumbCellRange(this)
  const trackColor = this.backgroundColor
  const thumbColor = this.foregroundColor
  for (let realX = 0; realX < this.width; realX++) {
    const fg = realX >= startX && realX <= endX ? thumbColor : trackColor
    for (let y = 0; y < this.height; y++) {
      buffer.setCellWithAlphaBlending(this.x + realX, this.y + y, "▄", fg, TRANSPARENT)
    }
  }
}

/**
 * A ScrollBar whose horizontal thumb/track render half-a-row tall (see
 * {@link renderThinHorizontal}). ScrollBarRenderable builds its Slider internally, so
 * rather than reconstruct it (duplicating the min/max/value/onChange/mouse wiring) the
 * least-invasive seam is to instance-patch the already-wired slider's `renderSelf` —
 * that changes ONLY how the thumb paints, reusing every other behavior intact.
 */
export class ThinHScrollBarRenderable extends ScrollBarRenderable {
  constructor(ctx: RenderContext, options: ScrollBarOptions) {
    super(ctx, options)
    if (this.orientation === "horizontal") {
      ;(this.slider as unknown as { renderSelf: (buffer: OptimizedBuffer) => void }).renderSelf =
        renderThinHorizontal
    }
  }
}

// Not in @opentui/react's default component catalogue, so register it once at module
// load. Every pane that renders `<thin-hscrollbar>` must side-effect-import THIS
// module itself (`import "./ThinHScrollBar"`) — Bun elides type-only imports, so a
// pane relying on some OTHER pane's import would throw "Unknown component type" the
// moment it renders alone (e.g. under a test that mounts only that pane).
declare module "@opentui/react" {
  interface OpenTUIComponents {
    "thin-hscrollbar": typeof ThinHScrollBarRenderable
  }
}
extend({
  "thin-hscrollbar": ThinHScrollBarRenderable,
})
