/**
 * Imperative side-channel from the workbench chrome (Quick Open's go-to-line) to
 * the mounted editor of a given group. The editor textarea owns a native buffer
 * ref that React can't address declaratively, so it registers a small controls
 * object here keyed by groupId; callers resolve the ACTIVE group's controls and
 * drive the cursor directly. Absent entry (diff pane, no file open) → caller no-ops.
 */
export type EditorControls = {
  /** Move the cursor to a 1-based line (and optional 1-based column), revealing it. */
  gotoLine: (line: number, column?: number) => void
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
