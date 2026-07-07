import { useKeyboard } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { join } from "node:path"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CURSOR_STYLE, gitStatusColor, theme } from "../theme"
import type { FileStatus, StatusResult } from "../services/git"
import {
  discoverRepositories,
  GitWatcher,
  type RepoInfo,
} from "../services/repos"
import * as trash from "../services/trash"
import { withMacSuper } from "../services/commands"
import { documentRegistry } from "../model/documents"
import { useCommands } from "../workbench/CommandsProvider"
import { useConfirm, type ConfirmOptions } from "../workbench/ModalProvider"
import { useOverlay } from "../workbench/OverlayProvider"
import { useWorkbenchWatchers } from "../workbench/watchers"
import type { ConfirmButton } from "./ConfirmDialog"

export type ScmPanelProps = {
  workspaceRoot: string
  focused: boolean
  onOpenFile?: (path: string) => void
  onOpenDiff?: (path: string, kind: "staged" | "unstaged", oldPath?: string) => void
}

type GroupKey = "merge" | "staged" | "changes" | "untracked"

const GROUPS = [
  { field: "mergeChanges", key: "merge", label: "Merge Changes" },
  { field: "staged", key: "staged", label: "Staged Changes" },
  { field: "changes", key: "changes", label: "Changes" },
  { field: "untracked", key: "untracked", label: "Untracked Changes" },
] as const satisfies ReadonlyArray<{
  field: keyof StatusResult
  key: GroupKey
  label: string
}>

// Rendering one Renderable per file row costs ~13ms, so an unignored directory
// (a stray node_modules/dist) that makes `git status -uall` enumerate thousands
// of untracked files would freeze the whole panel. Two bounds keep it instant:
//   - MAX_RENDERED_GROUP_ROWS caps the rows actually painted per group; the
//     overflow collapses into one "…and N more" row (header still shows the true
//     total). This is the hard safety net regardless of tree shape.
//   - COLLAPSE_THRESHOLD flips a group's directories to collapsed-by-default once
//     it's huge, so a deep tree shows only its top level until the user expands.
const MAX_RENDERED_GROUP_ROWS = 200
const COLLAPSE_THRESHOLD = 500

type GroupRow = {
  type: "group"
  id: string
  repoRoot: string
  group: GroupKey
  label: string
  files: FileStatus[]
}

type DirRow = {
  type: "dir"
  id: string
  repoRoot: string
  group: GroupKey
  dirPath: string
  name: string
  depth: number
  expanded: boolean
  files: FileStatus[] // every changed file beneath this directory
}

type FileRow = {
  type: "file"
  id: string
  repoRoot: string
  group: GroupKey
  name: string
  depth: number
  file: FileStatus
  files: FileStatus[]
}

// A trailing informational row shown when a group's rendered rows are capped.
// It is selectable (so keyboard nav can reach it) but carries no files, so every
// action no-ops on it.
type MoreRow = {
  type: "more"
  id: string
  repoRoot: string
  group: GroupKey
  hiddenCount: number
}

type SelRow = GroupRow | DirRow | FileRow | MoreRow

function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

// A file row targets its one file; a directory row targets every changed file
// beneath it; a group header targets the whole group; the "more" row targets
// nothing. The stage/unstage/discard primitives all take FileStatus[], so one
// call shape serves keyboard, the per-row buttons, and every tree level.
function rowTargets(row: SelRow): FileStatus[] {
  if (row.type === "file") return [row.file]
  if (row.type === "more") return []
  return row.files
}

const dirKey = (repoRoot: string, group: GroupKey, dirPath: string) =>
  `${repoRoot}::${group}::${dirPath}`

type TreeNode = {
  name: string
  path: string
  isDir: boolean
  file?: FileStatus
  files: FileStatus[]
  children: Map<string, TreeNode>
}

// Build an in-memory directory tree from a group's flat FileStatus[] and flatten
// it (directories first, then files, each alphabetical) into rows.
//
// `toggles` records dirs the user flipped away from their group's DEFAULT
// expansion. Small groups default to expanded (VSCode behavior); a group past
// COLLAPSE_THRESHOLD defaults its dirs to COLLAPSED so a huge tree shows only its
// top level. Either way `expanded = default XOR toggled`, so one toggle set (and
// one toggleDir that flips membership) drives both regimes and survives refreshes.
//
// Finally the flattened list is capped at MAX_RENDERED_GROUP_ROWS; the overflow
// becomes a single "more" row. Single-child dir-chain compression is skipped.
function flattenGroup(
  repoRoot: string,
  group: GroupKey,
  files: FileStatus[],
  toggles: ReadonlySet<string>,
): Array<DirRow | FileRow | MoreRow> {
  const defaultExpanded = files.length <= COLLAPSE_THRESHOLD
  const root: TreeNode = {
    name: "",
    path: "",
    isDir: true,
    files: [],
    children: new Map(),
  }
  for (const file of files) {
    const segments = file.path.split("/")
    let node = root
    let acc = ""
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      acc = acc ? `${acc}/${seg}` : seg
      if (i === segments.length - 1) {
        node.children.set(seg, {
          name: seg,
          path: file.path,
          isDir: false,
          file,
          files: [file],
          children: new Map(),
        })
      } else {
        let child = node.children.get(seg)
        if (!child || !child.isDir) {
          child = { name: seg, path: acc, isDir: true, files: [], children: new Map() }
          node.children.set(seg, child)
        }
        child.files.push(file)
        node = child
      }
    }
  }

  const rows: Array<DirRow | FileRow | MoreRow> = []
  let truncated = false
  const walk = (node: TreeNode, depth: number) => {
    const children = [...node.children.values()].sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
    )
    for (const child of children) {
      // Stopped with items still to place → the group overflows the cap. (A group
      // that exactly fills it with nothing left over is NOT truncated.)
      if (rows.length >= MAX_RENDERED_GROUP_ROWS) {
        truncated = true
        return
      }
      if (child.isDir) {
        const expanded =
          defaultExpanded !== toggles.has(dirKey(repoRoot, group, child.path))
        rows.push({
          type: "dir",
          id: `${repoRoot}::dir::${group}::${child.path}`,
          repoRoot,
          group,
          dirPath: child.path,
          name: child.name,
          depth,
          expanded,
          files: child.files,
        })
        if (expanded) walk(child, depth + 1)
      } else {
        rows.push({
          type: "file",
          id: `${repoRoot}::file::${group}::${child.file!.path}`,
          repoRoot,
          group,
          name: child.name,
          depth,
          file: child.file!,
          files: [child.file!],
        })
      }
    }
  }
  walk(root, 0)

  if (truncated) {
    const shownFiles = rows.reduce((n, r) => n + (r.type === "file" ? 1 : 0), 0)
    rows.push({
      type: "more",
      id: `${repoRoot}::more::${group}`,
      repoRoot,
      group,
      hiddenCount: files.length - shownFiles,
    })
  }
  return rows
}

// The selectable rows for ONE repo: each non-empty group's header followed by its
// (capped) tree. Kept per-repo so the render can memoize each repo's subtree and
// the keyboard model can reuse the exact same rows (no second flatten).
function buildRepoRows(
  repoRoot: string,
  st: StatusResult,
  toggles: ReadonlySet<string>,
): SelRow[] {
  const rows: SelRow[] = []
  for (const gm of GROUPS) {
    const files = st[gm.field]
    if (files.length === 0) continue
    rows.push({
      type: "group",
      id: `${repoRoot}::grp::${gm.key}`,
      repoRoot,
      group: gm.key,
      label: gm.label,
      files,
    })
    rows.push(...flattenGroup(repoRoot, gm.key, files, toggles))
  }
  return rows
}

/**
 * VSCode Source Control view: per-repo commit box + resource groups (Merge,
 * Staged, Changes, Untracked) with per-file and per-group stage/unstage/discard/
 * open actions. Keyboard nav only runs while `focused`; the workbench owns focus.
 */
export function ScmPanel({
  workspaceRoot,
  focused,
  onOpenFile,
  onOpenDiff,
}: ScmPanelProps) {
  const commands = useCommands()
  const confirm = useConfirm()
  const { isOverlayOpen } = useOverlay()
  const sharedWatchers = useWorkbenchWatchers()

  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [statuses, setStatuses] = useState<Map<string, StatusResult>>(
    () => new Map(),
  )
  const [messages, setMessages] = useState<Map<string, string>>(() => new Map())
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [focusTarget, setFocusTarget] = useState<"input" | "list">("list")
  const [activeRepoRoot, setActiveRepoRoot] = useState<string | null>(null)
  const [confirmRepo, setConfirmRepo] = useState<string | null>(null)
  // Directory keys the user flipped away from their group's default expansion
  // (see flattenGroup). Only user actions mutate it, so it survives status
  // refreshes untouched and never needs eviction — stale keys never match.
  const [dirToggles, setDirToggles] = useState<Set<string>>(() => new Set())

  const mountedRef = useRef(true)
  // Tracks the selected row by id so a rebuild (watcher refresh, expand/collapse)
  // can restore the same logical row even when rows shift above it.
  const selectedIdRef = useRef<string | null>(null)
  const reposRef = useRef<RepoInfo[]>(repos)
  reposRef.current = repos
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  // Per-repo status() coalescing: at most one in-flight call per repo; a stale
  // event arriving mid-flight schedules exactly one follow-up refresh.
  const inflightRef = useRef<Map<string, Promise<unknown>>>(new Map())
  const pendingRef = useRef<Set<string>>(new Set())

  const refresh = useCallback((repoRoot: string) => {
    const repo = reposRef.current.find((r) => r.root === repoRoot)
    if (!repo) return
    if (inflightRef.current.has(repoRoot)) {
      pendingRef.current.add(repoRoot)
      return
    }
    const p = repo.service
      .status()
      .then((st) => {
        if (!mountedRef.current) return
        setStatuses((prev) => new Map(prev).set(repoRoot, st))
      })
      .catch(() => {})
      .finally(() => {
        inflightRef.current.delete(repoRoot)
        if (pendingRef.current.has(repoRoot)) {
          pendingRef.current.delete(repoRoot)
          refresh(repoRoot)
        }
      })
    inflightRef.current.set(repoRoot, p)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    // Prefer the workbench's shared GitWatcher; only build a private one when
    // rendered standalone (outside a WatchersProvider, e.g. in isolated tests).
    let ownWatcher: GitWatcher | null = null
    let unsub = () => {}
    void discoverRepositories(workspaceRoot).then((discovered) => {
      if (!mountedRef.current) return
      reposRef.current = discovered
      setRepos(discovered)
      if (discovered.length > 0) setActiveRepoRoot((prev) => prev ?? discovered[0].root)
      if (sharedWatchers) {
        unsub = sharedWatchers.onStatusStale((root) => refresh(root))
      } else {
        ownWatcher = new GitWatcher(discovered)
        unsub = ownWatcher.onStatusStale((root) => refresh(root))
      }
      for (const repo of discovered) refresh(repo.root)
    })
    return () => {
      unsub()
      ownWatcher?.dispose()
    }
  }, [workspaceRoot, refresh, sharedWatchers])

  // Per-repo rows, memoized on that repo's status object identity (and the toggle
  // set) so one repo's async status resolution doesn't rebuild every other repo's
  // tree. The cache preserves each unchanged repo's array identity, which lets the
  // memoized RepoSection skip re-rendering untouched repos during the load storm.
  const rowsCacheRef = useRef<
    Map<string, { status: StatusResult; toggles: ReadonlySet<string>; rows: SelRow[] }>
  >(new Map())
  const rowsByRepo = useMemo(() => {
    const map = new Map<string, SelRow[]>()
    const cache = rowsCacheRef.current
    for (const repo of repos) {
      const st = statuses.get(repo.root)
      if (!st) continue
      const cached = cache.get(repo.root)
      if (cached && cached.status === st && cached.toggles === dirToggles) {
        map.set(repo.root, cached.rows)
      } else {
        const rows = buildRepoRows(repo.root, st, dirToggles)
        cache.set(repo.root, { status: st, toggles: dirToggles, rows })
        map.set(repo.root, rows)
      }
    }
    for (const key of [...cache.keys()]) if (!map.has(key)) cache.delete(key)
    return map
  }, [repos, statuses, dirToggles])

  // Flat, repo-ordered rows for the keyboard model — the SAME array instances the
  // render consumes, so nothing is flattened twice per render.
  const selectableRows = useMemo(() => {
    const flat: SelRow[] = []
    for (const repo of repos) {
      const rows = rowsByRepo.get(repo.root)
      if (rows) flat.push(...rows)
    }
    return flat
  }, [repos, rowsByRepo])

  const idToIndex = useMemo(() => {
    const m = new Map<string, number>()
    selectableRows.forEach((row, i) => m.set(row.id, i))
    return m
  }, [selectableRows])
  // idToIndex is rebuilt on every status update; read it through a ref so the
  // stably-registered selectById keeps one identity and doesn't defeat the
  // per-repo RepoSection memo.
  const idToIndexRef = useRef(idToIndex)
  idToIndexRef.current = idToIndex

  // Reconcile selection across every row rebuild by id, not position: a refresh
  // or an expand/collapse can insert/remove rows above the selection. Keep the
  // same logical row when its id survives; otherwise clamp the old index.
  useEffect(() => {
    setSelectedIndex((prev) => {
      if (selectableRows.length === 0) {
        selectedIdRef.current = null
        return 0
      }
      const id = selectedIdRef.current
      const byId = id != null ? idToIndex.get(id) : undefined
      const next = byId ?? Math.min(Math.max(0, prev), selectableRows.length - 1)
      selectedIdRef.current = selectableRows[next]?.id ?? null
      return next
    })
  }, [selectableRows, idToIndex])

  // Committing targets the repo you're navigating; explicit input focus can
  // override it, but selection keeps it in sync otherwise.
  useEffect(() => {
    const row = selectableRows[selectedIndex]
    if (row) setActiveRepoRoot(row.repoRoot)
  }, [selectedIndex, selectableRows])

  useEffect(() => {
    const row = selectableRows[selectedIndex]
    if (row && scrollRef.current) scrollRef.current.scrollChildIntoView(row.id)
  }, [selectedIndex, selectableRows])

  const effectiveActiveRepo =
    activeRepoRoot ?? (repos.length > 0 ? repos[0].root : null)

  // A ref snapshot so the (stably registered) commands and keyboard actions
  // always read the latest selection/state instead of a stale closure.
  const snapshotRef = useRef({
    selectableRows,
    selectedIndex,
    statuses,
    messages,
    confirmRepo,
    activeRepoRoot: effectiveActiveRepo,
  })
  snapshotRef.current = {
    selectableRows,
    selectedIndex,
    statuses,
    messages,
    confirmRepo,
    activeRepoRoot: effectiveActiveRepo,
  }

  const serviceFor = useCallback((repoRoot: string) => {
    return reposRef.current.find((r) => r.root === repoRoot)?.service ?? null
  }, [])

  const selectedRow = useCallback((): SelRow | null => {
    const s = snapshotRef.current
    return s.selectableRows[s.selectedIndex] ?? null
  }, [])

  const stageRow = useCallback((repoRoot: string, files: FileStatus[]) => {
    const svc = serviceFor(repoRoot)
    if (!svc || files.length === 0) return
    void svc.stage(files.map((f) => f.path)).then(() => refresh(repoRoot))
  }, [serviceFor, refresh])

  const unstageRow = useCallback((repoRoot: string, files: FileStatus[]) => {
    const svc = serviceFor(repoRoot)
    if (!svc || files.length === 0) return
    void svc.unstage(files.map((f) => f.path)).then(() => refresh(repoRoot))
  }, [serviceFor, refresh])

  const discardRow = useCallback((repoRoot: string, targets: FileStatus[]) => {
    const svc = serviceFor(repoRoot)
    if (!svc || targets.length === 0) return

    const tracked = targets.filter((f) => f.statusLetter !== "U")
    const untracked = targets.filter((f) => f.statusLetter === "U")
    const trackedPaths = tracked.map((f) => f.path)
    // git status paths are repo-relative; trash needs absolute filesystem paths.
    const untrackedAbsPaths = untracked.map((f) => join(repoRoot, f.path))

    const doDiscard = async () => {
      const ops: Promise<unknown>[] = []
      if (trackedPaths.length > 0) ops.push(svc.discardTracked(trackedPaths))
      if (untrackedAbsPaths.length > 0) ops.push(trash.moveToTrash(untrackedAbsPaths))
      try {
        await Promise.all(ops)
      } catch {
        // A trash failure surfaces nothing for the MVP; the file is simply left
        // in place. discardTracked failures are likewise non-fatal here.
      }
      if (!mountedRef.current) return
      refresh(repoRoot)
      // Reflect discarded content in any open tab. The document registry is keyed
      // by absolute path, so join the git-status-relative path onto the repo root.
      for (const f of targets) {
        void documentRegistry.get(join(repoRoot, f.path))?.reloadFromDisk().catch(() => {})
      }
    }

    const confirmButton = (label: string): ConfirmButton => ({
      id: "confirm",
      label,
      isDefault: true,
    })
    const cancelButton: ConfirmButton = { id: "cancel", label: "Cancel" }

    const n = targets.length
    let options: ConfirmOptions

    if (targets.length === 1) {
      // Single file: one dialog scoped to that file's kind.
      const only = targets[0]
      const name = basename(only.path)
      if (only.statusLetter === "U") {
        options = {
          message: `Are you sure you want to DELETE '${name}'?`,
          detail: "You can restore this file from the Trash.",
          buttons: [confirmButton("Move to Trash"), cancelButton],
        }
      } else {
        options = {
          message: `Are you sure you want to discard changes in '${name}'?`,
          buttons: [confirmButton("Discard File"), cancelButton],
        }
      }
    } else if (trackedPaths.length === 0) {
      // Group/multi-file, all untracked: trash-only, recoverable.
      options = {
        message: `Are you sure you want to DELETE the following ${n} untracked files?`,
        detail: "You can restore these files from the Trash.",
        buttons: [confirmButton("Move to Trash"), cancelButton],
      }
    } else {
      // Group/multi-file with tracked changes (all-tracked or mixed): irreversible.
      let message = `Are you sure you want to discard ALL changes in ${n} files?\n\nThis is IRREVERSIBLE!\nYour current working set will be FOREVER LOST if you proceed.`
      if (untracked.length > 0) {
        message += `\n\n(including ${untracked.length} untracked file(s), which will be moved to the Trash)`
      }
      options = {
        message,
        buttons: [confirmButton(`Discard All ${n} Files`), cancelButton],
      }
    }

    void confirm(options).then((choice) => {
      if (choice === "confirm") void doDiscard()
    })
  }, [serviceFor, refresh, confirm])

  const stageSelected = useCallback(() => {
    const row = selectedRow()
    if (row) stageRow(row.repoRoot, rowTargets(row))
  }, [selectedRow, stageRow])

  const unstageSelected = useCallback(() => {
    const row = selectedRow()
    if (row) unstageRow(row.repoRoot, rowTargets(row))
  }, [selectedRow, unstageRow])

  const discardSelected = useCallback(() => {
    const row = selectedRow()
    if (row) discardRow(row.repoRoot, rowTargets(row))
  }, [selectedRow, discardRow])

  const openSelected = useCallback(() => {
    const row = selectedRow()
    if (row && row.type === "file") onOpenFile?.(join(row.repoRoot, row.file.path))
  }, [selectedRow, onOpenFile])

  const openDiffSelected = useCallback(() => {
    const row = selectedRow()
    if (!row || row.type !== "file") return
    const oldPath = row.file.oldPath ? join(row.repoRoot, row.file.oldPath) : undefined
    onOpenDiff?.(
      join(row.repoRoot, row.file.path),
      row.group === "staged" ? "staged" : "unstaged",
      oldPath,
    )
  }, [selectedRow, onOpenDiff])

  const commitActive = useCallback(() => {
    const s = snapshotRef.current
    const root = s.activeRepoRoot
    if (!root) return
    const svc = serviceFor(root)
    if (!svc) return
    const message = s.messages.get(root) ?? ""
    const stagedCount = s.statuses.get(root)?.staged.length ?? 0

    const finish = () => {
      if (!mountedRef.current) return
      setMessages((prev) => {
        const next = new Map(prev)
        next.delete(root)
        return next
      })
      setConfirmRepo(null)
      refresh(root)
    }

    if (stagedCount === 0) {
      if (s.confirmRepo !== root) {
        setConfirmRepo(root)
        return
      }
      void svc.commit(message, { all: true }).then(finish)
    } else {
      void svc.commit(message).then(finish)
    }
  }, [serviceFor, refresh])

  useEffect(() => {
    const disposers = [
      commands.registerCommand({
        id: "scm.commit",
        title: "Commit",
        category: "Source Control",
        keybinding: withMacSuper("ctrl+enter"),
        run: commitActive,
      }),
      commands.registerCommand({
        id: "scm.stage",
        title: "Stage Changes",
        category: "Source Control",
        run: stageSelected,
      }),
      commands.registerCommand({
        id: "scm.unstage",
        title: "Unstage Changes",
        category: "Source Control",
        run: unstageSelected,
      }),
      commands.registerCommand({
        id: "scm.discard",
        title: "Discard Changes",
        category: "Source Control",
        run: discardSelected,
      }),
      commands.registerCommand({
        id: "scm.openDiff",
        title: "Open Changes",
        category: "Source Control",
        run: openDiffSelected,
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [
    commands,
    commitActive,
    stageSelected,
    unstageSelected,
    discardSelected,
    openDiffSelected,
  ])

  const selectById = useCallback((id: string) => {
    const index = idToIndexRef.current.get(id)
    if (index === undefined) return
    setFocusTarget("list")
    selectedIdRef.current = id
    setSelectedIndex(index)
  }, [])

  // Flip a dir's toggle membership, which flips its expansion regardless of the
  // group's default (expanded = default XOR toggled — see flattenGroup).
  const toggleDir = useCallback((row: DirRow) => {
    const key = dirKey(row.repoRoot, row.group, row.dirPath)
    setDirToggles((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  useKeyboard((key) => {
    if (!focused) return
    // An open overlay (a confirm dialog, Quick Open, …) owns the keyboard.
    if (isOverlayOpen) return

    if (focusTarget === "input") {
      if (key.name === "escape") {
        if (confirmRepo) setConfirmRepo(null)
        else setFocusTarget("list")
        return
      }
      // Enter commits (ctrl+enter is indistinguishable from Enter in most
      // terminals; scm.commit is also bound as the discoverable fallback).
      if (key.name === "return" || key.name === "enter") {
        commitActive()
        return
      }
      return
    }

    // Move selection to a row, tracking its id so a later rebuild can restore
    // it (see the reconcile effect above). Both use functional updates so rapid
    // presses that fire before a re-render still compose correctly.
    const moveBy = (delta: number) =>
      setSelectedIndex((i) => {
        const clamped = Math.min(
          Math.max(0, i + delta),
          selectableRows.length - 1,
        )
        selectedIdRef.current = selectableRows[clamped]?.id ?? null
        return clamped
      })
    const selectAt = (index: number) =>
      setSelectedIndex(() => {
        if (selectableRows.length === 0) return 0
        const clamped = Math.min(Math.max(0, index), selectableRows.length - 1)
        selectedIdRef.current = selectableRows[clamped]?.id ?? null
        return clamped
      })

    const row = selectableRows[selectedIndex]
    switch (key.name) {
      case "up":
        moveBy(-1)
        break
      case "down":
        moveBy(1)
        break
      case "right":
        // Expand a collapsed dir, step into an expanded one; leaves do nothing.
        if (row?.type === "dir") {
          if (row.expanded) moveBy(1)
          else toggleDir(row)
        }
        break
      case "left": {
        // Collapse an expanded dir in place; otherwise jump to the parent row
        // (the enclosing dir, or the group header for a top-level entry).
        if (!row) break
        if (row.type === "dir" && row.expanded) {
          toggleDir(row)
          break
        }
        if (row.type === "group") break
        // A "more" row's parent is its group header; a file/collapsed-dir jumps
        // to its enclosing dir, or the group header when it's top-level.
        let parentId: string
        if (row.type === "more") {
          parentId = `${row.repoRoot}::grp::${row.group}`
        } else {
          const path = row.type === "dir" ? row.dirPath : row.file.path
          const slash = path.lastIndexOf("/")
          parentId =
            slash === -1
              ? `${row.repoRoot}::grp::${row.group}`
              : `${row.repoRoot}::dir::${row.group}::${path.slice(0, slash)}`
        }
        const parentIndex = idToIndex.get(parentId)
        if (parentIndex !== undefined) selectAt(parentIndex)
        break
      }
      case "tab":
      case "i":
        if (effectiveActiveRepo) setFocusTarget("input")
        break
      case "return":
      case "enter":
        // Enter opens the diff (VSCode parity with mouse-click); 'o' opens the
        // plain file. Non-file rows (dirs/groups) keep their own behavior.
        if (row?.type === "dir") toggleDir(row)
        else openDiffSelected()
        break
      case "space":
      case "+":
        stageSelected()
        break
      case "-":
        unstageSelected()
        break
      case "x":
        discardSelected()
        break
      case "o":
        openSelected()
        break
    }
  })

  const selectedId = selectableRows[selectedIndex]?.id

  const handleMessageInput = useCallback((repoRoot: string, value: string) => {
    setMessages((prev) => new Map(prev).set(repoRoot, value))
  }, [])

  return (
    <box flexDirection="column" height="100%" backgroundColor={theme.sidebarBackground}>
      <box height={1} paddingLeft={1}>
        <text fg={theme.dimForeground}>SOURCE CONTROL</text>
      </box>
      <scrollbox ref={scrollRef} flexGrow={1}>
        {repos.length === 0 ? (
          <text fg={theme.dimForeground}>No repositories</text>
        ) : (
          repos.map((repo) => (
            <RepoSection
              key={repo.root}
              repo={repo}
              rows={rowsByRepo.get(repo.root) ?? EMPTY_ROWS}
              showRepoHeader={repos.length > 1}
              message={messages.get(repo.root) ?? ""}
              inputFocused={
                focused && focusTarget === "input" && effectiveActiveRepo === repo.root
              }
              confirmActive={confirmRepo === repo.root}
              selectedId={selectedId}
              onMessageInput={handleMessageInput}
              selectById={selectById}
              toggleDir={toggleDir}
              stageRow={stageRow}
              unstageRow={unstageRow}
              discardRow={discardRow}
              onOpenDiff={onOpenDiff}
            />
          ))
        )}
      </scrollbox>
    </box>
  )
}

const EMPTY_ROWS: SelRow[] = []

type RepoSectionProps = {
  repo: RepoInfo
  rows: SelRow[]
  showRepoHeader: boolean
  message: string
  inputFocused: boolean
  confirmActive: boolean
  selectedId: string | undefined
  onMessageInput: (repoRoot: string, value: string) => void
  selectById: (id: string) => void
  toggleDir: (row: DirRow) => void
  stageRow: (repoRoot: string, files: FileStatus[]) => void
  unstageRow: (repoRoot: string, files: FileStatus[]) => void
  discardRow: (repoRoot: string, files: FileStatus[]) => void
  onOpenDiff?: (path: string, kind: "staged" | "unstaged", oldPath?: string) => void
}

// One repo's commit box + resource groups. Memoized so another repo's async
// status resolution (they land independently) doesn't re-render or re-reconcile
// this repo's row subtree — the fix for the multi-repo freeze. Every prop is a
// primitive or a stable ref from ScmPanel, so React.memo's shallow compare holds
// unless THIS repo's rows / selection / input state actually change.
const RepoSection = memo(function RepoSection({
  repo,
  rows,
  showRepoHeader,
  message,
  inputFocused,
  confirmActive,
  selectedId,
  onMessageInput,
  selectById,
  toggleDir,
  stageRow,
  unstageRow,
  discardRow,
  onOpenDiff,
}: RepoSectionProps) {
  // VSCode-style hover actions, shown only on the selected row (the 32-col
  // sidebar has no room to render them on every row without clipping names).
  // stopPropagation keeps a button click from also selecting the row / opening
  // a diff; preventDefault suppresses the renderer's text-selection gesture.
  const renderActions = (group: GroupKey, files: FileStatus[]) => {
    const specs =
      group === "staged"
        ? [{ key: "unstage", glyph: "−", run: () => unstageRow(repo.root, files) }]
        : [
            { key: "stage", glyph: "+", run: () => stageRow(repo.root, files) },
            { key: "discard", glyph: "↶", run: () => discardRow(repo.root, files) },
          ]
    return specs.map((s) => (
      <box
        key={s.key}
        onMouseDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
          s.run()
        }}
      >
        <text fg={theme.foreground}>{` ${s.glyph}`}</text>
      </box>
    ))
  }

  const renderRow = (row: SelRow) => {
    const selected = selectedId === row.id
    const bg = selected ? theme.selectionBackground : undefined
    if (row.type === "group") {
      return (
        <box
          key={row.id}
          id={row.id}
          flexDirection="row"
          width="100%"
          height={1}
          paddingLeft={1}
          backgroundColor={bg}
          onMouseDown={() => selectById(row.id)}
        >
          <text fg={theme.foreground}>{row.label}</text>
          <box flexGrow={1} />
          {selected ? renderActions(row.group, row.files) : null}
          <text fg={theme.dimForeground}>{`(${row.files.length})`}</text>
          <text fg={theme.dimForeground}> </text>
        </box>
      )
    }
    if (row.type === "more") {
      return (
        <box
          key={row.id}
          id={row.id}
          flexDirection="row"
          width="100%"
          height={1}
          paddingLeft={2}
          backgroundColor={bg}
          onMouseDown={() => selectById(row.id)}
        >
          <text fg={theme.dimForeground}>
            {`…and ${row.hiddenCount} more files (group too large to display)`}
          </text>
        </box>
      )
    }
    // Indent by depth; a 2-col prefix (twisty for dirs, blank for files) keeps
    // names aligned like VSCode.
    const indent = "  ".repeat(row.depth)
    if (row.type === "dir") {
      return (
        <box
          key={row.id}
          id={row.id}
          flexDirection="row"
          width="100%"
          height={1}
          paddingLeft={2}
          backgroundColor={bg}
          onMouseDown={() => {
            selectById(row.id)
            toggleDir(row)
          }}
        >
          <text fg={theme.foreground}>
            {`${indent}${row.expanded ? "▾ " : "▸ "}${row.name}`}
          </text>
          <box flexGrow={1} />
          {selected ? renderActions(row.group, row.files) : null}
          <text fg={theme.dimForeground}> </text>
        </box>
      )
    }
    return (
      <box
        key={row.id}
        id={row.id}
        flexDirection="row"
        width="100%"
        height={1}
        paddingLeft={2}
        backgroundColor={bg}
        onMouseDown={() => {
          selectById(row.id)
          onOpenDiff?.(
            join(repo.root, row.file.path),
            row.group === "staged" ? "staged" : "unstaged",
            row.file.oldPath ? join(repo.root, row.file.oldPath) : undefined,
          )
        }}
      >
        <text fg={theme.foreground}>{`${indent}  ${row.name}`}</text>
        <box flexGrow={1} />
        {selected ? renderActions(row.group, [row.file]) : null}
        <text fg={gitStatusColor(row.file.statusLetter)}>{row.file.statusLetter}</text>
        <text fg={theme.dimForeground}> </text>
      </box>
    )
  }

  return (
    <box flexDirection="column" width="100%">
      {showRepoHeader ? (
        <box height={1} paddingLeft={1}>
          <text fg={theme.foreground}>{basename(repo.root)}</text>
        </box>
      ) : null}
      <input
        value={message}
        onInput={(value) => onMessageInput(repo.root, value)}
        focused={inputFocused}
        placeholder="Message (Enter to commit)"
        cursorStyle={CURSOR_STYLE}
      />
      {confirmActive ? (
        <text fg={theme.warning}>
          No staged changes. Press Enter again to stage all & commit, Esc to cancel
        </text>
      ) : (
        <text fg={theme.dimForeground}>[Enter] Commit</text>
      )}
      {rows.map(renderRow)}
    </box>
  )
})
