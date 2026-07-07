import { type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { createTwoFilesPatch, parsePatch } from "diff"
import { relative } from "node:path"
import { useEffect, useMemo, useRef, useState } from "react"
import { detectLanguage, documentRegistry } from "../model/documents"
import type { CommitDiffTab, DiffTab } from "../model/workbench"
import { GitService } from "../services/git"
import { getSharedSyntaxStyle, theme } from "../theme"
import { useOverlay, useOverlayFocusRestore } from "../workbench/OverlayProvider"
import { useWorkbenchStore } from "../workbench/useWorkbenchStore"
import { useWorkbenchWatchers } from "../workbench/watchers"

type DiffView = "unified" | "split"

/** Last-used view mode, persisted across re-opens within the session only. */
let lastView: DiffView = "split"

function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

/**
 * Pick the scroll offset to jump to for next(+1)/prev(-1) hunk navigation given
 * the diff's hunk row offsets and the current scroll position. Wraps around at
 * either end. Exported for unit testing the pure selection logic.
 */
export function pickHunkTarget(
  offsets: number[],
  current: number,
  dir: 1 | -1,
): number | null {
  if (offsets.length === 0) return null
  const EPS = 0.5
  if (dir === 1) {
    return offsets.find((o) => o > current + EPS) ?? offsets[0]
  }
  const prior = offsets.filter((o) => o < current - EPS)
  return prior.length > 0 ? prior[prior.length - 1] : offsets[offsets.length - 1]
}

/**
 * Files at or under this line count render with full-file context so every
 * unchanged line shows (VSCode's diff-editor look). The `<diff>` is a single
 * full-height child inside the scrollbox, so nothing gets culled and the
 * per-frame gutter/shading loops run over the WHOLE file — larger files fall
 * back to a compact 3-line-context view to bound that work.
 */
export const FULL_CONTEXT_MAX_LINES = 5000

/** Line count as a trailing-newline-terminated file reports it (no phantom last line). */
function lineCount(text: string): number {
  if (text === "") return 0
  const n = text.split("\n").length
  return text.endsWith("\n") ? n - 1 : n
}

/**
 * Build the unified patch fed to `<diff>`. Under the size guard it uses
 * effectively infinite context (the `diff` package merges everything into one
 * hunk carrying all unchanged lines); over it, the today's 3-line-context view.
 * Returns whether full context was used. Exported as a pure, testable unit.
 */
export function buildDiffPatch(
  oldCode: string,
  newCode: string,
  name: string,
): { patch: string; fullContext: boolean } {
  const fullContext =
    Math.max(lineCount(oldCode), lineCount(newCode)) <= FULL_CONTEXT_MAX_LINES
  const patch = createTwoFilesPatch(name, name, oldCode, newCode, undefined, undefined, {
    context: fullContext ? Number.MAX_SAFE_INTEGER : 3,
  })
  return { patch, fullContext }
}

/**
 * Row offsets (0-based, in the diff's own scroll space) of the first visual row
 * of every contiguous added/removed run, for n/p change navigation. Under full
 * context the patch is ONE hunk, so the renderable's getHunkRowOffsets() gives a
 * single target and n/p stalls; we instead reproduce @opentui/core's row layout
 * (buildUnifiedView / buildSplitView) to place a target at each change block.
 *
 * Assumes wrap is off (the `<diff>`'s default wrapMode), so logical lines map
 * 1:1 to visual rows and split-view change runs occupy max(removed, added) rows.
 */
export function computeChangeBlockOffsets(patch: string, view: DiffView): number[] {
  const lines: string[] = []
  for (const file of parsePatch(patch)) {
    for (const hunk of file.hunks) lines.push(...hunk.lines)
  }
  const offsets: number[] = []
  if (view === "unified") {
    let row = 0
    let inRun = false
    for (const line of lines) {
      const c = line[0]
      if (c === "\\") continue // "\ No newline at end of file" — not a rendered row
      if (c === "+" || c === "-") {
        if (!inRun) {
          offsets.push(row)
          inRun = true
        }
      } else {
        inRun = false
      }
      row++
    }
    return offsets
  }
  // Split view: context lines take one row; a change run takes max(removed, added)
  // rows (the shorter side is padded with empty filler), matching buildSplitView.
  // A "\ No newline" marker between a remove and an add ends buildSplitView's
  // inner max()-grouping but NOT the visual block — the rows on either side render
  // adjacent, so the whole "\"-separated region is one navigation stop.
  let row = 0
  let i = 0
  while (i < lines.length) {
    const c = lines[i][0]
    if (c === " ") {
      row++
      i++
    } else if (c === "\\") {
      i++
    } else {
      offsets.push(row)
      while (i < lines.length && lines[i][0] !== " ") {
        let removes = 0
        let adds = 0
        while (i < lines.length && (lines[i][0] === "-" || lines[i][0] === "+")) {
          if (lines[i][0] === "-") removes++
          else adds++
          i++
        }
        row += Math.max(removes, adds)
        while (i < lines.length && lines[i][0] === "\\") i++
      }
    }
  }
  return offsets
}

/** The working-tree file text, or "" if the file is gone (a deletion). */
async function readWorkingTree(path: string): Promise<string> {
  const file = Bun.file(path)
  if (!(await file.exists())) return ""
  return file.text()
}

/**
 * Resolve the before/after content for a diff tab. `tab.filePath` is ABSOLUTE
 * (matching how editor tabs / the document registry key files); git blob lookups
 * need the repo-relative path, so we derive it against `tab.repoRoot`.
 *
 * - unstaged: `old` = index (`:0`), falling back to HEAD when the file has no
 *   index entry at all (a never-staged new file). `new` = the live in-memory
 *   Document if one is open (so unsaved edits show) else the working-tree file.
 * - staged: `old` = HEAD, `new` = index (`:0`). For a rename/copy, HEAD has no
 *   entry under the NEW path (it only knows the file under `oldPath`), so `old`
 *   is fetched from HEAD at `oldPath` instead — otherwise `old` resolves to ""
 *   and the whole file reads as added.
 */
export async function resolveDiff(
  service: GitService,
  tab: DiffTab,
): Promise<{ oldCode: string; newCode: string }> {
  const { filePath, diffKind, oldPath } = tab
  const rel = relative(tab.repoRoot, filePath)
  if (diffKind === "staged") {
    const oldRel = oldPath ? relative(tab.repoRoot, oldPath) : rel
    const oldCode = await service.show("HEAD", oldRel)
    const newCode = await service.show(":0", rel)
    return { oldCode, newCode }
  }

  // oldPath is irrelevant here: staging a rename already moves the index entry
  // to the new path, so the unstaged "old" side (`:0` at the new path) is
  // already correct with no rename-aware lookup needed.
  let oldCode = await service.show(":0", rel)
  if (oldCode === "") oldCode = await service.show("HEAD", rel)
  const live = documentRegistry.get(filePath)
  const newCode = live ? live.getText() : await readWorkingTree(filePath)
  return { oldCode, newCode }
}

/**
 * Resolve the before/after content for any diff tab. A `commitDiff` tab compares
 * two immutable git refs directly (no working-tree/live-Document override); a
 * plain `diff` tab defers to {@link resolveDiff}'s staged/unstaged logic.
 */
export async function resolveDiffContent(
  service: GitService,
  tab: DiffTab | CommitDiffTab,
): Promise<{ oldCode: string; newCode: string }> {
  if (tab.kind === "commitDiff") {
    const rel = relative(tab.repoRoot, tab.filePath)
    const oldCode = await service.show(tab.oldRef, rel)
    const newCode = await service.show(tab.newRef, rel)
    return { oldCode, newCode }
  }
  return resolveDiff(service, tab)
}

type LoadState =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "ready"; oldCode: string; newCode: string }
  | { kind: "error"; message: string }

export type DiffPaneProps = {
  focused: boolean
  height?: number | `${number}%` | "auto"
  /** Render a specific group's diff; defaults to the globally active group. */
  groupId?: string
}

/**
 * Before/after diff view for a git-modified file. Resolves the two sides on
 * mount/path-change, re-resolves the "new" side reactively when an open Document
 * changes, and re-resolves both sides when the shared git watcher reports an
 * external change to this tab's repo.
 */
export function DiffPane({ focused, height = "100%", groupId }: DiffPaneProps) {
  const { isOverlayOpen } = useOverlay()
  const sharedWatchers = useWorkbenchWatchers()
  const state = useWorkbenchStore()
  const group = state.groups.find((g) => g.id === (groupId ?? state.activeGroupId))
  const active = group?.tabs.find((t) => t.path === group.activeTabPath)
  const tab =
    active && (active.kind === "diff" || active.kind === "commitDiff") ? active : null

  const [load, setLoad] = useState<LoadState>({ kind: "empty" })
  const [view, setView] = useState<DiffView>(lastView)
  const [reloadVersion, setReloadVersion] = useState(0)
  const sbRef = useRef<ScrollBoxRenderable | null>(null)
  // The tab identity + content the currently-mounted `ready` view belongs to.
  // Read inside the async resolve to tell a first/identity-change load (show the
  // placeholder, surface errors) apart from a background re-resolve (keep the
  // scrollbox mounted, skip no-op setState, swallow errors). `null` = nothing
  // rendered yet for the active tab.
  const readyRef = useRef<{ identity: string; oldCode: string; newCode: string } | null>(null)

  // The diff scrollbox loses native focus to an overlay's input; restore it on
  // overlay close when this pane is the focused one.
  useOverlayFocusRestore(sbRef, focused)

  const id = tab?.path ?? null
  const filePath = tab?.filePath ?? null
  // Only plain (working-tree) diffs have a diffKind + live-Document reflection.
  const diffKind = tab && tab.kind === "diff" ? tab.diffKind : null
  const repoRoot = tab?.repoRoot ?? null

  useEffect(() => {
    if (!tab) {
      setLoad({ kind: "empty" })
      readyRef.current = null
      return
    }
    let cancelled = false
    const identity = tab.path
    // Show the "Loading…" placeholder ONLY when nothing is rendered yet for THIS
    // tab (initial mount or a switch to a different tab). A reloadVersion-only
    // re-run — a live-Document edit or a git-watcher stale bump — keeps the current
    // content (and thus the scrollbox) mounted, so it never flashes the placeholder
    // and the native scroll position survives the reload untouched.
    if (readyRef.current?.identity !== identity) {
      setLoad({ kind: "loading" })
      readyRef.current = null
    }
    resolveDiffContent(new GitService(tab.repoRoot), tab)
      .then((res) => {
        if (cancelled) return
        const prev = readyRef.current
        // An identical background re-resolve would still re-render, re-feed the
        // `<diff>` renderable, and re-run the memoized Myers diff for nothing —
        // skip the state update entirely when the content is unchanged.
        if (
          prev?.identity === identity &&
          prev.oldCode === res.oldCode &&
          prev.newCode === res.newCode
        ) {
          return
        }
        readyRef.current = { identity, ...res }
        setLoad({ kind: "ready", ...res })
      })
      .catch((err) => {
        if (cancelled) return
        // A background resolve failing for content we're already showing must NOT
        // blank the view into the error screen — VSCode keeps the last-good diff
        // visible. Only surface the error on an initial/identity-change load, where
        // there is nothing rendered yet (readyRef was cleared above).
        if (readyRef.current?.identity === identity) return
        setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
    // `tab` identity is fully captured by these fields; reloadVersion re-runs on
    // both live-Document edits and external git changes.
  }, [id, filePath, diffKind, repoRoot, reloadVersion])

  // Reflect unsaved edits: re-resolve when a live Document for this file changes.
  useEffect(() => {
    if (!filePath || diffKind !== "unstaged") return
    const doc = documentRegistry.get(filePath)
    if (!doc) return
    return doc.onDidChange(() => setReloadVersion((v) => v + 1))
  }, [filePath, diffKind])

  // Reflect external git changes: an outside `git add`/`checkout`/commit makes the
  // old (index/HEAD) side stale, so re-resolve when the shared watcher marks this
  // tab's repo stale. No-op when rendered without a WatchersProvider.
  useEffect(() => {
    if (!sharedWatchers || !repoRoot) return
    return sharedWatchers.onStatusStale((root) => {
      if (root === repoRoot) setReloadVersion((v) => v + 1)
    })
  }, [sharedWatchers, repoRoot])

  // Build the patch and both views' change-block offsets once per content change,
  // so a render (the `<diff>` prop) and every n/p keypress reuse them instead of
  // re-running a whole-file Myers diff — costly near the full-context threshold.
  const readyOld = load.kind === "ready" ? load.oldCode : null
  const readyNew = load.kind === "ready" ? load.newCode : null
  const diffData = useMemo(() => {
    if (readyOld === null || readyNew === null || !filePath) return null
    const { patch } = buildDiffPatch(readyOld, readyNew, basename(filePath))
    return {
      patch,
      offsets: {
        unified: computeChangeBlockOffsets(patch, "unified"),
        split: computeChangeBlockOffsets(patch, "split"),
      },
    }
  }, [readyOld, readyNew, filePath])

  const toggleView = () => {
    setView((v) => {
      const next: DiffView = v === "split" ? "unified" : "split"
      lastView = next
      return next
    })
  }

  const jumpHunk = (dir: 1 | -1) => {
    const sb = sbRef.current
    if (!sb || !diffData) return
    const target = pickHunkTarget(diffData.offsets[view], sb.scrollTop, dir)
    if (target !== null) sb.scrollTop = target
  }

  useKeyboard((key) => {
    if (!focused || load.kind !== "ready") return
    // An overlay owns the keyboard; don't let bare-letter shortcuts fire under it.
    if (isOverlayOpen) return
    // Bare-letter shortcuts only: a held Ctrl/Meta means this is a chord (e.g. a
    // Ctrl+V paste attempt), not a `v`/`n`/`p` diff command.
    if (key.ctrl || key.meta) return
    if (key.name === "v") toggleView()
    else if (key.name === "n") jumpHunk(1)
    else if (key.name === "p") jumpHunk(-1)
  })

  if (!tab || load.kind === "empty") {
    return (
      <box height={height} alignItems="center" justifyContent="center">
        <text fg={theme.dimForeground}>No diff open</text>
      </box>
    )
  }

  if (load.kind === "loading") {
    return (
      <box height={height} alignItems="center" justifyContent="center">
        <text fg={theme.dimForeground}>Loading…</text>
      </box>
    )
  }

  if (load.kind === "error") {
    return (
      <box height={height} alignItems="center" justifyContent="center">
        <text fg={theme.error}>{load.message}</text>
      </box>
    )
  }

  const name =
    tab.kind === "diff" && tab.oldPath
      ? `${basename(tab.oldPath)} → ${basename(tab.filePath)}`
      : basename(tab.filePath)
  const headerLabel =
    tab.kind === "commitDiff"
      ? tab.label
      : `${name} — ${tab.diffKind === "staged" ? "HEAD ↔ Index" : "Index ↔ Working Tree"}`
  const hasChanges = load.oldCode !== load.newCode
  const patch = diffData?.patch ?? ""

  return (
    <box flexDirection="column" height={height}>
      <box
        height={1}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.sidebarBackground}
      >
        <text fg={theme.foreground}>{headerLabel}</text>
        <box flexGrow={1} />
        <text fg={theme.dimForeground}>
          {view === "split" ? "Split" : "Unified"} · n/p change · v toggle
        </text>
      </box>
      {hasChanges ? (
        <scrollbox ref={sbRef} focused={focused} flexGrow={1}>
          <diff
            diff={patch}
            view={view}
            showLineNumbers
            syncScroll
            filetype={detectLanguage(tab.filePath)}
            syntaxStyle={getSharedSyntaxStyle()}
            addedBg={theme.diffAddedBackground}
            removedBg={theme.diffRemovedBackground}
            addedLineNumberBg={theme.diffAddedGutterBackground}
            removedLineNumberBg={theme.diffRemovedGutterBackground}
            addedSignColor={theme.diffAddedSign}
            removedSignColor={theme.diffRemovedSign}
            lineNumberFg={theme.diffLineNumberForeground}
          />
        </scrollbox>
      ) : (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.dimForeground}>No changes</text>
        </box>
      )}
    </box>
  )
}
