/**
 * Imperative side-channel from the workbench chrome (Quick Open's go-to-line, the
 * find widget) to the mounted editor of a given group. The editor textarea owns a
 * native buffer ref that React can't address declaratively, so it registers a
 * small controls object here keyed by groupId; callers resolve the ACTIVE group's
 * controls and drive the cursor/highlights directly. Absent entry (diff pane, no
 * file open) → caller no-ops.
 */

/** A match's [start, end) character-offset range in the editor buffer's text. */
export type FindMatch = { start: number; end: number }

/**
 * Highlight refs the find widget paints on the edit buffer. These MUST differ
 * from the tree-sitter syntax pass's ref (1, see EditorPane HIGHLIGHT_REF) so a
 * `removeHighlightsByRef` from one never clears the other. 2 = every match,
 * 3 = the current match painted on top.
 */
export const FIND_MATCH_REF = 2
export const FIND_CURRENT_REF = 3

/**
 * Find spans out-prioritize the syntax pass (which sets no priority) so a match's
 * background wins the cell; the current match sits above the rest of the matches.
 */
export const FIND_MATCH_PRIORITY = 100
export const FIND_CURRENT_PRIORITY = 101

export type EditorControls = {
  /** Move the cursor to a 1-based line (and optional 1-based column), revealing it. */
  gotoLine: (line: number, column?: number) => void
  /** The buffer's full current text (source of truth for find, not the lagging Document). */
  getText: () => string
  /** The currently selected text, or "" when there is no selection (find seed). */
  getSelectedText: () => string
  /** Paint all matches (ref 2) and the current one (ref 3); remembers matches for revealMatch. */
  setFindMatches: (matches: FindMatch[], currentIdx: number) => void
  /** Select the idx-th remembered match and scroll it into view even while blurred. */
  revealMatch: (idx: number) => void
  /** Remove the find highlights (refs 2/3) and forget the remembered matches. */
  clearFind: () => void
}

const registry = new Map<string, EditorControls>()

export function registerEditorControls(groupId: string, controls: EditorControls): () => void {
  registry.set(groupId, controls)
  return () => {
    // Guard against a stale unmount clobbering a newer registration for the same
    // group (file switch remounts the textarea: new registers before old cleans up).
    if (registry.get(groupId) === controls) registry.delete(groupId)
  }
}

export function getEditorControls(groupId: string): EditorControls | undefined {
  return registry.get(groupId)
}

/**
 * Deferred "reveal this line once the file's editor mounts". Opening a file from
 * the Search view (or anywhere) is async: the textarea mounts and registers its
 * controls only after the Document loads, so an immediate `gotoLine` would hit no
 * controls and no-op. The opener stashes the target here; {@link consumePendingGoto}
 * is drained by the freshly-mounted editor for its own path.
 *
 * A SINGLE slot (not a per-path map): a new request replaces the previous one
 * wholesale, so a superseded open (activate match in A, then in B before A loads)
 * can never strand A's target to silently fire on a later, unrelated open of A.
 * A staleness window guards the other orphan path — a target whose editor never
 * mounts (the too-large-preview / load-error branch) is dropped on the next
 * consume once it has outlived {@link PENDING_GOTO_TTL_MS}.
 */
type PendingGoto = { path: string; line: number; column?: number; requestedAt: number }
let pendingGoto: PendingGoto | null = null

/** How long a stashed goto stays eligible to fire before it's treated as orphaned. */
const PENDING_GOTO_TTL_MS = 10_000

/** Stash a line/column to reveal when the editor for `path` next mounts (supersedes any prior). */
export function requestGoto(path: string, line: number, column?: number): void {
  pendingGoto = { path, line, column, requestedAt: Date.now() }
}

/** Take any pending goto for `path`; the mounting editor calls this on register. */
export function consumePendingGoto(path: string): { line: number; column?: number } | undefined {
  const pending = pendingGoto
  if (!pending) return undefined
  // Outlived its window → its target never mounted in time (too-large/error branch
  // or a superseded open); drop it so it can't fire on this or a later open.
  if (Date.now() - pending.requestedAt > PENDING_GOTO_TTL_MS) {
    pendingGoto = null
    return undefined
  }
  // For a different file — leave the slot; that file's editor may still mount.
  if (pending.path !== path) return undefined
  pendingGoto = null
  return { line: pending.line, column: pending.column }
}
