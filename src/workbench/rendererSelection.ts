/**
 * Bridges the renderer's mouse-selection system to the clipboard. The renderer
 * emits a `selection` event on mouse-up carrying the finished selection; this
 * covers surfaces with no edit buffer of their own — the diff pane, commit log,
 * SCM panel, and the too-large-file preview — which the textarea copy path can't
 * reach. Two behaviors hang off that event: copy-on-select (the terminal
 * convention of copying a selection the moment the drag ends) and caching the
 * last selection so Ctrl+C can fall back to it (see EditorPane's copy handler).
 */

import type { Osc52Writer } from "../services/clipboard"
import * as clipboard from "../services/clipboard"

/** Copy a finished mouse selection to the clipboard on mouse-up. Configurable. */
export const COPY_ON_SELECT = true

/**
 * Text of the most recent NON-empty renderer selection, kept so a later Ctrl+C
 * with no live textarea selection can still copy it. An empty selection (a plain
 * click clears the drag) resets it so the fallback never copies stale text.
 */
let lastRendererSelection = ""

export function getLastRendererSelection(): string {
  return lastRendererSelection
}

/** The slice of the renderer's `Selection` payload this module reads. */
export interface RendererSelection {
  getSelectedText(): string
}

/**
 * Service the renderer's `selection` event. Caches the selected text for the
 * Ctrl+C fallback and, when copy-on-select is enabled, writes it to the
 * clipboard immediately. A soft `clipboard.write` (never throws) keeps a copy
 * hiccup out of the render loop.
 */
export function handleRendererSelection(
  selection: RendererSelection,
  renderer?: Osc52Writer,
): void {
  const text = selection.getSelectedText()
  if (!text) {
    lastRendererSelection = ""
    return
  }
  lastRendererSelection = text
  if (COPY_ON_SELECT) void clipboard.write(text, renderer)
}
