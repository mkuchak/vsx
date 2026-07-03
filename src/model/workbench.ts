/**
 * Editor group + tab state model — vsx's clone of VSCode's editor groups.
 * Framework-agnostic: plain TS + a tiny emitter, no React imports here.
 *
 * Designed for N groups even though only ONE is exercised today; every operation
 * targets the active group so the split-editor task can add more groups later
 * without reworking the tab semantics.
 */

import { documentRegistry } from "./documents"
import { equalFractions, removeFraction, resizeFraction, splitFraction } from "./splitSizes"

export type DiffKind = "staged" | "unstaged"

/** Outcome of a dirty-close prompt, mirroring VSCode's three-choice ladder. */
export type DirtyCloseChoice = "save" | "discard" | "cancel"

/** Async prompt injected by the UI layer; the store stays framework-agnostic. */
export type ConfirmDirtyClose = (path: string) => Promise<DirtyCloseChoice>

/**
 * A tab is either a plain file editor or a before/after diff view. Both carry a
 * `path` that is the tab's IDENTITY (what dedup/activate/close/MRU key on) — for
 * file tabs it is the real filesystem path; for diff tabs it is a synthetic
 * composite (see {@link diffTabId}) so that "open file X" and "open diff of X"
 * are distinct tabs, exactly as VSCode treats them. A diff tab additionally
 * carries `filePath`, the REAL underlying file path used for document lookups
 * and label rendering.
 */
export interface FileTab {
  kind: "file"
  path: string
  /** Preview tabs are reused (single-click) and render italic until promoted. */
  preview: boolean
  pinned: boolean
}

export interface DiffTab {
  kind: "diff"
  /** Synthetic identity string; never a real filesystem path. */
  path: string
  /** The real underlying file path (for documentRegistry lookups + labels). */
  filePath: string
  diffKind: DiffKind
  repoRoot: string
  preview: boolean
  pinned: boolean
}

/**
 * A diff between two arbitrary git refs for a single file (a commit-vs-parent
 * comparison from the commit log). Distinct from {@link DiffTab}, which is
 * specific to the staged/unstaged working-tree comparisons. Content is always
 * historical/immutable, so there is no live-Document override on either side.
 */
export interface CommitDiffTab {
  kind: "commitDiff"
  /** Synthetic identity string; never a real filesystem path. */
  path: string
  /** The real underlying (absolute) file path, for labels + document lookups. */
  filePath: string
  repoRoot: string
  /** "before" ref (parent commit, or the empty-tree SHA for a root commit). */
  oldRef: string
  /** "after" ref (the commit being inspected). */
  newRef: string
  /** Human label shown in the diff header, e.g. `a.ts (a1b2c3d)`. */
  label: string
  preview: boolean
  pinned: boolean
}

export type Tab = FileTab | DiffTab | CommitDiffTab

/** Which half of the workbench owns keyboard focus: the sidebar or the editor area. */
export type FocusArea = "sidebar" | "editor"

/** Stable identity for a diff tab; distinct per (diffKind, repo, file). */
export function diffTabId(diffKind: DiffKind, repoRoot: string, filePath: string): string {
  return `diff::${diffKind}::${repoRoot}::${filePath}`
}

/** Stable identity for a commit-diff tab; distinct per (repo, commit, file). */
export function commitDiffTabId(repoRoot: string, newRef: string, filePath: string): string {
  return `commitDiff::${repoRoot}::${newRef}::${filePath}`
}

export interface Group {
  id: string
  tabs: Tab[]
  activeTabPath: string | null
  /** Most-recently-activated paths, most recent first. Drives close-then-activate. */
  mruOrder: string[]
}

export interface WorkbenchState {
  groups: Group[]
  activeGroupId: string
  /**
   * One flex fraction per group (positionally aligned with `groups`), always
   * summing to 1. A single group is `[1]`. Stored as FRACTIONS, never cell
   * widths, so terminal/sidebar resizes keep proportions with no extra work.
   */
  sizes: number[]
  /**
   * Which half of the workbench owns keyboard focus. The SINGLE source of truth
   * for focus: every group-focus mutation (focusGroup, split, open*) drives this
   * to "editor", and the sidebar view commands drive it to "sidebar", so a
   * command can never move the active group without also moving keyboard focus.
   */
  focusArea: FocusArea
}

export interface OpenFileOptions {
  preview?: boolean
}

export interface OpenDiffOptions {
  preview?: boolean
}

export interface OpenCommitDiffOptions {
  preview?: boolean
}

type Listener = () => void

let groupSeq = 0

function createGroup(): Group {
  return { id: `group-${++groupSeq}`, tabs: [], activeTabPath: null, mruOrder: [] }
}

function remove(list: string[], value: string): void {
  const i = list.indexOf(value)
  if (i !== -1) list.splice(i, 1)
}

export class WorkbenchStore {
  private state: WorkbenchState
  private version = 0
  private readonly listeners = new Set<Listener>()
  private confirmDirtyClose?: ConfirmDirtyClose
  private openRecorder?: (path: string) => void

  constructor() {
    const group = createGroup()
    this.state = { groups: [group], activeGroupId: group.id, sizes: [1], focusArea: "sidebar" }
  }

  getState(): WorkbenchState {
    return this.state
  }

  /** Monotonic snapshot for useSyncExternalStore; changes on every mutation. */
  getVersion(): number {
    return this.version
  }

  /**
   * Register (or clear with `undefined`) the async handler the UI wires up to
   * prompt before discarding a dirty file. When unset — e.g. in unit tests — the
   * store closes/replaces dirty tabs synchronously with no prompt.
   */
  setConfirmDirtyCloseHandler(fn: ConfirmDirtyClose | undefined): void {
    this.confirmDirtyClose = fn
  }

  /**
   * Register (or clear with `null`) a fire-and-forget hook invoked once per REAL
   * file open — a genuine switch to a different or freshly opened file, never a
   * no-op re-activation of the already-active tab. Keeps the store
   * service-agnostic: the UI layer injects the frecency file-history recorder
   * here. Faults are swallowed so a ranking-cache failure can never break opening
   * a file.
   */
  setOpenRecorder(fn: ((path: string) => void) | null): void {
    this.openRecorder = fn ?? undefined
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Reset to a single empty group. Intended for tests. */
  reset(): void {
    const group = createGroup()
    this.state = { groups: [group], activeGroupId: group.id, sizes: [1], focusArea: "sidebar" }
    this.notify()
  }

  private get activeGroup(): Group {
    const g = this.state.groups.find((group) => group.id === this.state.activeGroupId)
    if (!g) throw new Error("workbench: no active group")
    return g
  }

  /**
   * Resolve a tab operation's target group: the active group when `groupId` is
   * omitted (backward-compatible default for every existing caller), else the
   * group with that id. Returns `undefined` for an unknown id so callers no-op
   * gracefully rather than throwing.
   */
  private resolveGroup(groupId?: string): Group | undefined {
    if (groupId === undefined) return this.activeGroup
    return this.state.groups.find((g) => g.id === groupId)
  }

  /**
   * Split the active group into another side-by-side group: each split inserts a
   * new column adjacent to the source and halves the source's fraction
   * ({@link splitFraction}). Pass `maxGroups` to cap the count — the split is a
   * silent no-op once `groups.length` has reached it. This cap is NOT optional for
   * a sane layout: the ~20-cell floor in {@link resizeSplit} only applies DURING a
   * resize, never during a split, so an uncapped split keeps halving panes with no
   * lower bound until a later resize/nudge on a sub-floor pair misbehaves. Callers
   * derive `maxGroups` from live cell widths (`floor(paneCells / MIN_PANE_CELLS)`).
   * Matches VSCode: the new group takes focus, and by default the active tab's
   * identity is cloned into it (a fresh tab object — never a shared reference —
   * opened as a permanent, non-preview tab). Cloning only the `path`/`kind`
   * identity means both groups' file tabs resolve to the SAME shared Document.
   */
  splitGroup(opts?: { copyActiveTab?: boolean; maxGroups?: number }): void {
    const maxGroups = opts?.maxGroups
    if (maxGroups !== undefined && this.state.groups.length >= maxGroups) return
    const copyActiveTab = opts?.copyActiveTab ?? true
    const source = this.activeGroup
    const sourceIndex = this.state.groups.indexOf(source)
    const group = createGroup()
    // Insert directly after the source so `groups` stays positionally aligned with
    // `sizes`, whose new fraction is likewise inserted after the source slot.
    this.state.groups.splice(sourceIndex + 1, 0, group)
    this.state.sizes = splitFraction(this.state.sizes, sourceIndex)

    if (copyActiveTab && source.activeTabPath) {
      const active = source.tabs.find((t) => t.path === source.activeTabPath)
      if (active) {
        const clone: Tab = { ...active, preview: false, pinned: false }
        group.tabs.push(clone)
        group.activeTabPath = clone.path
        group.mruOrder.unshift(clone.path)
      }
    }

    this.state.activeGroupId = group.id
    // A split takes editor focus (VSCode focuses the new group), so keystrokes go
    // to the freshly created pane even when the split was triggered from the sidebar.
    this.state.focusArea = "editor"
    this.notify()
  }

  /**
   * Set which half of the workbench owns keyboard focus. The sidebar view
   * commands call this with "sidebar"; every editor-side entry point routes
   * through {@link focusGroup} / open* which set "editor" themselves.
   */
  setFocusArea(area: FocusArea): void {
    if (this.state.focusArea === area) return
    this.state.focusArea = area
    this.notify()
  }

  /**
   * Make an existing group the active (focused) one AND move keyboard focus into
   * the editor. Setting focusArea here is what makes the ctrl+1..9 / next/prev
   * commands (and a pane-body click) actually redirect keystrokes to the group
   * they select rather than silently switching the active group underneath the
   * sidebar. No-op if the id is unknown, or if this group is already the focused
   * editor group. Focusing the already-active group from the SIDEBAR still flips
   * focusArea to "editor".
   */
  focusGroup(groupId: string): void {
    if (!this.state.groups.some((g) => g.id === groupId)) return
    if (groupId === this.state.activeGroupId && this.state.focusArea === "editor") return
    this.state.activeGroupId = groupId
    this.state.focusArea = "editor"
    this.notify()
  }

  /** Focus the group at a positional index (0-based). No-op if out of range. */
  focusGroupByIndex(index: number): void {
    const id = this.state.groups[index]?.id
    if (id) this.focusGroup(id)
  }

  /** Cycle focus across groups in POSITIONAL order, wrapping around. */
  private cycleGroup(delta: number): void {
    const groups = this.state.groups
    if (groups.length < 2) return
    const current = groups.findIndex((g) => g.id === this.state.activeGroupId)
    const next = (((current + delta) % groups.length) + groups.length) % groups.length
    this.focusGroup(groups[next].id)
  }

  /** Focus the next group to the right, wrapping from the last back to the first. */
  focusNextGroup(): void {
    this.cycleGroup(1)
  }

  /** Focus the previous group to the left, wrapping from the first to the last. */
  focusPrevGroup(): void {
    this.cycleGroup(-1)
  }

  /**
   * Move `deltaFraction` of the editor area across the divider between
   * `groups[dividerIndex]` and `groups[dividerIndex + 1]`. The caller derives both
   * the delta and `minFraction` (the ~20-cell floor per pane) from live cell
   * widths; this method just applies + clamps them. No-op for an out-of-range
   * divider. Positive delta grows the left group.
   */
  resizeSplit(dividerIndex: number, deltaFraction: number, minFraction: number): void {
    if (dividerIndex < 0 || dividerIndex + 1 >= this.state.sizes.length) return
    this.state.sizes = resizeFraction(this.state.sizes, dividerIndex, deltaFraction, minFraction)
    this.notify()
  }

  /** Restore every current group to an equal fraction of the editor area. */
  resetSplitSizes(): void {
    this.state.sizes = equalFractions(this.state.groups.length)
    this.notify()
  }

  private notify(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  openFile(path: string, opts?: OpenFileOptions): void {
    // Whether this open only RE-ACTIVATES the already-active tab — captured before
    // any mutation. Repeated preview clicks / re-activating the active file must
    // count once toward frecency, not per click, so the recorder skips these no-op
    // opens yet still counts a genuine switch to a different or freshly opened file.
    const reactivatingActive = this.activeGroup.activeTabPath === path

    // Opening a tab is an editor-side action; take keyboard focus so a file opened
    // from the sidebar (FileTree / Quick Open) doesn't leave keystrokes on the tree.
    this.state.focusArea = "editor"
    const preview = opts?.preview ?? true
    const group = this.activeGroup
    const existing = group.tabs.find((tab) => tab.kind === "file" && tab.path === path)

    if (existing) {
      // A non-preview open of an already-open tab promotes it permanently.
      if (!preview && existing.preview) existing.preview = false
      this.activateTab(path)
    } else {
      const newTab: FileTab = { kind: "file", path, preview, pinned: false }
      this.placeTab(group, newTab, preview)
      this.activateTab(path)
    }

    if (!reactivatingActive) this.recordOpen(path)
  }

  /**
   * Invoke the injected open recorder defensively: a ranking-cache fault must
   * never surface into the editor's file-open path.
   */
  private recordOpen(path: string): void {
    if (!this.openRecorder) return
    try {
      this.openRecorder(path)
    } catch {
      // Best-effort ranking only; swallow so openFile always succeeds.
    }
  }

  /**
   * Open a before/after diff for a file. Mirrors {@link openFile}'s preview-slot
   * reuse, but with a STRONGER dedup: if a diff tab for the same (path, diffKind)
   * is already open it is reused/activated regardless of preview status — VSCode
   * never opens two diff tabs for the same comparison.
   */
  openDiff(path: string, diffKind: DiffKind, repoRoot: string, opts?: OpenDiffOptions): void {
    this.state.focusArea = "editor"
    const preview = opts?.preview ?? true
    const group = this.activeGroup
    const id = diffTabId(diffKind, repoRoot, path)
    const existing = group.tabs.find((tab) => tab.kind === "diff" && tab.path === id)

    if (existing) {
      if (!preview && existing.preview) existing.preview = false
      this.activateTab(id)
      return
    }

    const newTab: DiffTab = {
      kind: "diff",
      path: id,
      filePath: path,
      diffKind,
      repoRoot,
      preview,
      pinned: false,
    }
    this.placeTab(group, newTab, preview)
    this.activateTab(id)
  }

  /**
   * Open a commit-vs-parent diff for a single file. Mirrors {@link openDiff}'s
   * dedup/reuse: a commit-diff tab for the same (repo, commit, file) is reused
   * regardless of preview status rather than opening a duplicate.
   */
  openCommitDiff(
    filePath: string,
    oldRef: string,
    newRef: string,
    repoRoot: string,
    label: string,
    opts?: OpenCommitDiffOptions,
  ): void {
    this.state.focusArea = "editor"
    const preview = opts?.preview ?? true
    const group = this.activeGroup
    const id = commitDiffTabId(repoRoot, newRef, filePath)
    const existing = group.tabs.find((tab) => tab.kind === "commitDiff" && tab.path === id)

    if (existing) {
      if (!preview && existing.preview) existing.preview = false
      this.activateTab(id)
      return
    }

    const newTab: CommitDiffTab = {
      kind: "commitDiff",
      path: id,
      filePath,
      repoRoot,
      oldRef,
      newRef,
      label,
      preview,
      pinned: false,
    }
    this.placeTab(group, newTab, preview)
    this.activateTab(id)
  }

  /**
   * Insert a freshly built tab, reusing the single preview slot when opening in
   * preview mode. Replaces the whole tab object (not just its path) so a reused
   * slot cannot retain stale fields from a different tab kind.
   */
  private placeTab(group: Group, tab: Tab, preview: boolean): void {
    if (preview) {
      const idx = group.tabs.findIndex((t) => t.preview)
      if (idx !== -1) {
        const existing = group.tabs[idx]
        // A dirty preview file must not be silently discarded: promote it and add
        // the new tab alongside it (matches VSCode). Diff/commitDiff previews are
        // read-only, so they still take the fast silent-replace path.
        const doc = existing.kind === "file" ? documentRegistry.get(existing.path) : undefined
        if (!doc?.isDirty) {
          remove(group.mruOrder, existing.path)
          group.tabs[idx] = tab
          return
        }
        existing.preview = false
      }
    }
    group.tabs.push(tab)
  }

  activateTab(path: string, groupId?: string): void {
    const group = this.resolveGroup(groupId)
    if (!group) return
    if (!group.tabs.some((tab) => tab.path === path)) return
    group.activeTabPath = path
    remove(group.mruOrder, path)
    group.mruOrder.unshift(path)
    this.notify()
  }

  /**
   * Close a tab. File tabs run the dirty-close guard first (diff/commitDiff tabs
   * are read-only views and close synchronously). When the doc is dirty and a
   * handler is registered we await the user's choice: "cancel" aborts and the tab
   * stays open, "save" persists then closes, "discard" closes without saving.
   * With no handler or a clean doc the removal runs synchronously (no prompt),
   * so unit-test callers can keep invoking this without awaiting.
   */
  async closeTab(path: string, groupId?: string): Promise<void> {
    const group = this.resolveGroup(groupId)
    if (!group) return
    const tab = group.tabs.find((t) => t.path === path)
    if (!tab) return

    if (tab.kind === "file") {
      const doc = documentRegistry.get(tab.path)
      if (doc?.isDirty && this.confirmDirtyClose) {
        const choice = await this.confirmDirtyClose(tab.path)
        if (choice === "cancel") return
        if (choice === "save") await doc.save()
      }
    }

    this.removeTabFromGroup(group, path)
  }

  private removeTabFromGroup(group: Group, path: string): void {
    const idx = group.tabs.findIndex((tab) => tab.path === path)
    if (idx === -1) return
    group.tabs.splice(idx, 1)
    remove(group.mruOrder, path)
    if (group.activeTabPath === path) {
      group.activeTabPath = group.mruOrder[0] ?? null
    }

    // Emptying a non-last group collapses the split back to single-group layout:
    // drop the group and re-focus a remaining one (same index if it exists).
    if (group.tabs.length === 0 && this.state.groups.length > 1) {
      const groupIdx = this.state.groups.findIndex((g) => g.id === group.id)
      this.state.groups.splice(groupIdx, 1)
      this.state.sizes = removeFraction(this.state.sizes, groupIdx)
      const fallback = this.state.groups[groupIdx] ?? this.state.groups[this.state.groups.length - 1]
      this.state.activeGroupId = fallback.id
    }

    this.notify()
  }

  async closeActiveTab(): Promise<void> {
    const active = this.activeGroup.activeTabPath
    if (active) await this.closeTab(active)
  }

  /** Promote a specific preview tab to a permanent tab. No-op if not a preview tab. */
  promoteTab(path: string): void {
    this.promoteTabInGroup(this.state.activeGroupId, path)
  }

  /**
   * Promote a preview tab in a specific group. Group-targeted so promotion works
   * from a non-focused split pane (an edit there must promote its own tab, not the
   * active group's). No-op if the group/tab is unknown or the tab isn't a preview.
   */
  promoteTabInGroup(groupId: string, path: string): void {
    const group = this.state.groups.find((g) => g.id === groupId)
    const tab = group?.tabs.find((t) => t.path === path)
    if (tab && tab.preview) {
      tab.preview = false
      this.notify()
    }
  }

  /** Promote the active tab if it is currently a preview tab. */
  promoteActiveIfPreview(): void {
    const active = this.activeGroup.activeTabPath
    if (active) this.promoteTab(active)
  }

  /** Cycle in POSITIONAL (array) order, not MRU. Wraps around. */
  private cycle(delta: number): void {
    const group = this.activeGroup
    const len = group.tabs.length
    if (len === 0) return
    const current = group.activeTabPath
      ? group.tabs.findIndex((tab) => tab.path === group.activeTabPath)
      : -1
    const next = (((current + delta) % len) + len) % len
    this.activateTab(group.tabs[next].path)
  }

  activateNextTab(): void {
    this.cycle(1)
  }

  activatePrevTab(): void {
    this.cycle(-1)
  }
}

export const workbenchStore = new WorkbenchStore()
