import {
  SyntaxStyle,
  type DiffRenderable,
  type ScrollBoxRenderable,
  type ThemeTokenStyle,
} from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { createTwoFilesPatch } from "diff"
import { relative } from "node:path"
import { useEffect, useRef, useState } from "react"
import { detectLanguage, documentRegistry } from "../model/documents"
import type { CommitDiffTab, DiffTab } from "../model/workbench"
import { GitService } from "../services/git"
import { theme } from "../theme"
import { useOverlay, useOverlayFocusRestore } from "../workbench/OverlayProvider"
import { useWorkbenchStore } from "../workbench/useWorkbenchStore"
import { useWorkbenchWatchers } from "../workbench/watchers"

type DiffView = "unified" | "split"

/** Last-used view mode, persisted across re-opens within the session only. */
let lastView: DiffView = "split"

/** Mirrors EditorPane's Dark+-ish token colors; the `<diff>` needs one to highlight. */
const SYNTAX_THEME: ThemeTokenStyle[] = [
  { scope: ["keyword", "keyword.control", "conditional", "repeat"], style: { foreground: "#c586c0" } },
  { scope: ["string", "string.special"], style: { foreground: "#ce9178" } },
  { scope: ["comment"], style: { foreground: "#6a9955", italic: true } },
  { scope: ["function", "function.call", "function.method"], style: { foreground: "#dcdcaa" } },
  { scope: ["type", "type.builtin", "constructor"], style: { foreground: "#4ec9b0" } },
  { scope: ["number", "constant", "constant.builtin", "boolean"], style: { foreground: "#b5cea8" } },
  { scope: ["variable", "variable.parameter"], style: { foreground: "#9cdcfe" } },
  { scope: ["property"], style: { foreground: "#9cdcfe" } },
  { scope: ["operator", "punctuation", "punctuation.delimiter", "punctuation.bracket"], style: { foreground: "#d4d4d4" } },
  { scope: ["tag"], style: { foreground: "#569cd6" } },
  { scope: ["attribute"], style: { foreground: "#9cdcfe" } },
]

let sharedSyntaxStyle: SyntaxStyle | undefined
function getSyntaxStyle(): SyntaxStyle {
  if (!sharedSyntaxStyle) sharedSyntaxStyle = SyntaxStyle.fromTheme(SYNTAX_THEME)
  return sharedSyntaxStyle
}

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
 * - staged: `old` = HEAD, `new` = index (`:0`).
 */
export async function resolveDiff(
  service: GitService,
  tab: DiffTab,
): Promise<{ oldCode: string; newCode: string }> {
  const { filePath, diffKind } = tab
  const rel = relative(tab.repoRoot, filePath)
  if (diffKind === "staged") {
    const oldCode = await service.show("HEAD", rel)
    const newCode = await service.show(":0", rel)
    return { oldCode, newCode }
  }

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
  const diffRef = useRef<DiffRenderable | null>(null)

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
      return
    }
    let cancelled = false
    setLoad({ kind: "loading" })
    resolveDiffContent(new GitService(tab.repoRoot), tab)
      .then((res) => {
        if (!cancelled) setLoad({ kind: "ready", ...res })
      })
      .catch((err) => {
        if (!cancelled) {
          setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) })
        }
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

  const toggleView = () => {
    setView((v) => {
      const next: DiffView = v === "split" ? "unified" : "split"
      lastView = next
      return next
    })
  }

  const jumpHunk = (dir: 1 | -1) => {
    const d = diffRef.current
    const sb = sbRef.current
    if (!d || !sb) return
    const target = pickHunkTarget(d.getHunkRowOffsets(), sb.scrollTop, dir)
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

  const name = basename(tab.filePath)
  const headerLabel =
    tab.kind === "commitDiff"
      ? tab.label
      : `${name} — ${tab.diffKind === "staged" ? "HEAD ↔ Index" : "Index ↔ Working Tree"}`
  const hasChanges = load.oldCode !== load.newCode
  const patch = createTwoFilesPatch(name, name, load.oldCode, load.newCode, undefined, undefined, {
    context: 3,
  })

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
          {view === "split" ? "Split" : "Unified"} · n/p hunk · v toggle
        </text>
      </box>
      {hasChanges ? (
        <scrollbox ref={sbRef} focused={focused} flexGrow={1}>
          <diff
            ref={diffRef}
            diff={patch}
            view={view}
            showLineNumbers
            syncScroll
            filetype={detectLanguage(tab.filePath)}
            syntaxStyle={getSyntaxStyle()}
            addedBg={theme.diffAddedBackground}
            removedBg={theme.diffRemovedBackground}
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
