import { useKeyboard } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { join } from "node:path"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { gitStatusColor, theme } from "../theme"
import type { FileStatus, StatusResult } from "../services/git"
import {
  discoverRepositories,
  GitWatcher,
  type RepoInfo,
} from "../services/repos"
import * as trash from "../services/trash"
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
  onOpenDiff?: (path: string, kind: "staged" | "unstaged") => void
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

type SelRow =
  | {
      type: "group"
      id: string
      repoRoot: string
      group: GroupKey
      label: string
      files: FileStatus[]
    }
  | {
      type: "file"
      id: string
      repoRoot: string
      group: GroupKey
      file: FileStatus
      files: FileStatus[]
    }

function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/")
  return i === -1
    ? { name: path, dir: "" }
    : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

function buildRows(
  repos: RepoInfo[],
  statuses: Map<string, StatusResult>,
): SelRow[] {
  const rows: SelRow[] = []
  for (const repo of repos) {
    const st = statuses.get(repo.root)
    if (!st) continue
    for (const gm of GROUPS) {
      const files = st[gm.field]
      if (files.length === 0) continue
      rows.push({
        type: "group",
        id: `${repo.root}::grp::${gm.key}`,
        repoRoot: repo.root,
        group: gm.key,
        label: gm.label,
        files,
      })
      for (const file of files) {
        rows.push({
          type: "file",
          id: `${repo.root}::file::${gm.key}::${file.path}`,
          repoRoot: repo.root,
          group: gm.key,
          file,
          files,
        })
      }
    }
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

  const mountedRef = useRef(true)
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

  const selectableRows = useMemo(
    () => buildRows(repos, statuses),
    [repos, statuses],
  )

  const idToIndex = useMemo(() => {
    const m = new Map<string, number>()
    selectableRows.forEach((row, i) => m.set(row.id, i))
    return m
  }, [selectableRows])

  useEffect(() => {
    setSelectedIndex((i) => {
      if (selectableRows.length === 0) return 0
      return Math.min(Math.max(0, i), selectableRows.length - 1)
    })
  }, [selectableRows.length])

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

  const stageSelected = useCallback(() => {
    const row = selectedRow()
    if (!row) return
    const svc = serviceFor(row.repoRoot)
    if (!svc) return
    const paths = row.type === "file" ? [row.file.path] : row.files.map((f) => f.path)
    void svc.stage(paths).then(() => refresh(row.repoRoot))
  }, [selectedRow, serviceFor, refresh])

  const unstageSelected = useCallback(() => {
    const row = selectedRow()
    if (!row) return
    const svc = serviceFor(row.repoRoot)
    if (!svc) return
    const paths = row.type === "file" ? [row.file.path] : row.files.map((f) => f.path)
    void svc.unstage(paths).then(() => refresh(row.repoRoot))
  }, [selectedRow, serviceFor, refresh])

  const discardSelected = useCallback(() => {
    const row = selectedRow()
    if (!row) return
    const svc = serviceFor(row.repoRoot)
    if (!svc) return

    const repoRoot = row.repoRoot
    const targets = row.type === "file" ? [row.file] : row.files
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
  }, [selectedRow, serviceFor, refresh, confirm])

  const openSelected = useCallback(() => {
    const row = selectedRow()
    if (row && row.type === "file") onOpenFile?.(join(row.repoRoot, row.file.path))
  }, [selectedRow, onOpenFile])

  const openDiffSelected = useCallback(() => {
    const row = selectedRow()
    if (!row || row.type !== "file") return
    if (row.group !== "staged" && row.group !== "changes") return
    onOpenDiff?.(join(row.repoRoot, row.file.path), row.group === "staged" ? "staged" : "unstaged")
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
        keybinding: "ctrl+enter",
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

  const selectById = useCallback(
    (id: string) => {
      const index = idToIndex.get(id)
      if (index === undefined) return
      setFocusTarget("list")
      setSelectedIndex(index)
    },
    [idToIndex],
  )

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

    switch (key.name) {
      case "up":
        setSelectedIndex((i) => Math.max(0, i - 1))
        break
      case "down":
        setSelectedIndex((i) => Math.min(selectableRows.length - 1, i + 1))
        break
      case "tab":
      case "i":
        if (effectiveActiveRepo) setFocusTarget("input")
        break
      case "return":
      case "enter":
        openSelected()
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
        openDiffSelected()
        break
    }
  })

  const selectedId = selectableRows[selectedIndex]?.id

  return (
    <box flexDirection="column" height="100%" backgroundColor={theme.sidebarBackground}>
      <box height={1} paddingLeft={1}>
        <text fg={theme.dimForeground}>SOURCE CONTROL</text>
      </box>
      <scrollbox ref={scrollRef} flexGrow={1}>
        {repos.length === 0 ? (
          <text fg={theme.dimForeground}>No repositories</text>
        ) : (
          repos.map((repo) => {
            const st = statuses.get(repo.root)
            const message = messages.get(repo.root) ?? ""
            const inputFocused =
              focused && focusTarget === "input" && effectiveActiveRepo === repo.root
            return (
              <box key={repo.root} flexDirection="column" width="100%">
                {repos.length > 1 ? (
                  <box height={1} paddingLeft={1}>
                    <text fg={theme.foreground}>{basename(repo.root)}</text>
                  </box>
                ) : null}
                <input
                  value={message}
                  onInput={(value) =>
                    setMessages((prev) => new Map(prev).set(repo.root, value))
                  }
                  focused={inputFocused}
                  placeholder="Message (Enter to commit)"
                />
                {confirmRepo === repo.root ? (
                  <text fg={theme.warning}>
                    No staged changes. Press Enter again to stage all & commit,
                    Esc to cancel
                  </text>
                ) : (
                  <text fg={theme.dimForeground}>[Enter] Commit</text>
                )}
                {st
                  ? GROUPS.map((gm) => {
                      const files = st[gm.field]
                      if (files.length === 0) return null
                      const groupId = `${repo.root}::grp::${gm.key}`
                      return (
                        <box key={groupId} flexDirection="column" width="100%">
                          <box
                            id={groupId}
                            flexDirection="row"
                            width="100%"
                            height={1}
                            paddingLeft={1}
                            backgroundColor={
                              selectedId === groupId
                                ? theme.selectionBackground
                                : undefined
                            }
                            onMouseDown={() => selectById(groupId)}
                          >
                            <text fg={theme.foreground}>{gm.label}</text>
                            <box flexGrow={1} />
                            <text fg={theme.dimForeground}>{`(${files.length})`}</text>
                            <text fg={theme.dimForeground}> </text>
                          </box>
                          {files.map((file) => {
                            const fileId = `${repo.root}::file::${gm.key}::${file.path}`
                            const { name, dir } = splitPath(file.path)
                            const diffable =
                              gm.key === "staged" || gm.key === "changes"
                            return (
                              <box
                                key={fileId}
                                id={fileId}
                                flexDirection="row"
                                width="100%"
                                height={1}
                                paddingLeft={2}
                                backgroundColor={
                                  selectedId === fileId
                                    ? theme.selectionBackground
                                    : undefined
                                }
                                onMouseDown={() => {
                                  selectById(fileId)
                                  if (diffable)
                                    onOpenDiff?.(
                                      join(repo.root, file.path),
                                      gm.key === "staged" ? "staged" : "unstaged",
                                    )
                                }}
                              >
                                <text fg={theme.foreground}>{name}</text>
                                {dir ? (
                                  <text fg={theme.dimForeground}>{` ${dir}`}</text>
                                ) : null}
                                <box flexGrow={1} />
                                <text fg={gitStatusColor(file.statusLetter)}>
                                  {file.statusLetter}
                                </text>
                                <text fg={theme.dimForeground}> </text>
                              </box>
                            )
                          })}
                        </box>
                      )
                    })
                  : null}
              </box>
            )
          })
        )}
      </scrollbox>
    </box>
  )
}
