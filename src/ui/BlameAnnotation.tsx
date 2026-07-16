import type { LineBlame } from "../services/git"
import { theme } from "../theme"
import { formatRelativeDate } from "./CommitLog"

/**
 * Cells of breathing room between the end of the rendered line text and the
 * start of the annotation — matches GitLens' "a couple spaces after the code".
 */
const ANNOTATION_PADDING = 3

export type BlameAnnotationProps = {
  /**
   * The blame data to render, or null to render nothing (e.g. while loading, or
   * when the document is dirty — dirty-gating is a SEPARATE task's job; this
   * component renders whatever it is given, or nothing).
   */
  blame: LineBlame | null
  /**
   * The cursor's visual row within the currently visible viewport (0-based,
   * already adjusted for vertical scroll). The caller derives this from the
   * editor's viewport state; this component knows nothing about EditorPane.
   */
  visualRow: number
  /** Column (in cells) where the current line's rendered text ends — the anchor. */
  lineEndColumn: number
  /** Total width of the editor pane this overlays, for right-edge clamping. */
  paneWidth: number
  /** Total height of the editor pane, for the visible-row guard. */
  paneHeight: number
  /** Injectable clock so the relative date is deterministic in tests. */
  now?: Date
}

/** Build the annotation string, omitting the `#PR` segment when there is no PR. */
function annotationText(blame: LineBlame, now?: Date): string {
  if (blame.uncommitted) return "Uncommitted change"
  const parts = [blame.authorName, formatRelativeDate(blame.authorDate, now)]
  if (blame.prNumber !== null) parts.push(`#${blame.prNumber}`)
  return parts.join("  ")
}

/**
 * Given a natural anchor and the pane width, compute where the annotation sits
 * and (if it cannot fit even when pushed flush against the right edge) its
 * truncated text with a leading `…`.
 *
 * Columns are 0-based, so the last usable column is `paneWidth - 1`.
 * - If the full text fits at `naturalLeft`, keep it there.
 * - Otherwise slide left so the text's right edge lands on `paneWidth - 1`.
 * - If even a left edge of 0 is not enough room, truncate the head, prefixing
 *   `…`, so the (now `paneWidth`-wide) text fills the pane exactly.
 */
export function layoutAnnotation(
  text: string,
  naturalLeft: number,
  paneWidth: number,
): { left: number; text: string } {
  if (naturalLeft + text.length <= paneWidth) {
    return { left: naturalLeft, text }
  }
  const clampedLeft = paneWidth - text.length
  if (clampedLeft >= 0) {
    return { left: clampedLeft, text }
  }
  // Text is wider than the whole pane: keep the tail, prefix an ellipsis.
  const tailChars = Math.max(0, paneWidth - 1)
  return { left: 0, text: `…${text.slice(text.length - tailChars)}` }
}

/**
 * A floating, muted git-blame annotation drawn on top of the editor at the
 * cursor's line — OpenTUI has no inlay/virtual-text primitive, so this is a
 * genuine absolutely-positioned overlay rather than inline decoration.
 *
 * Pure "given these numbers, render this box": it holds no git/cursor/viewport
 * state, so a later integration task can compute and feed it real coordinates
 * without touching this file.
 */
export function BlameAnnotation({
  blame,
  visualRow,
  lineEndColumn,
  paneWidth,
  paneHeight,
  now,
}: BlameAnnotationProps) {
  if (!blame) return null
  // Defensive guard: the cursor's row should always be in view, but a caller
  // could pass a stale value between renders.
  if (visualRow < 0 || visualRow >= paneHeight) return null

  const text = annotationText(blame, now)
  const { left, text: rendered } = layoutAnnotation(
    text,
    lineEndColumn + ANNOTATION_PADDING,
    paneWidth,
  )

  return (
    <text position="absolute" left={left} top={visualRow} zIndex={50} fg={theme.dimForeground}>
      <em>{rendered}</em>
    </text>
  )
}
