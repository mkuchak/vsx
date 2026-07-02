import { useEffect, useRef, useState } from "react"
import { documentRegistry } from "../model/documents"
import { theme } from "../theme"
import { discoverRepositories, GitWatcher, type RepoInfo } from "../services/repos"
import type { HeadInfo } from "../services/git"
import { useWorkbenchStore } from "../workbench/useWorkbenchStore"
import { useWorkbenchWatchers } from "../workbench/watchers"
import type { CursorPosition } from "./EditorPane"

export type StatusBarProps = {
  workspaceRoot: string
  cursor: CursorPosition | null
  /** Transient message slot (e.g. "Saved", surfaced git errors). Auto-clears after ~2s. */
  message?: string | null
  /** Toggles sidebar visibility; renders an always-visible ☰ cell when provided. */
  onToggleSidebar?: () => void
  /** When an overlay owns the screen, the ☰ click is inert (mirrors Ctrl+B's dispatch gate). */
  overlayOpen?: boolean
}

/**
 * VSCode-style status bar: branch name + dirty-file count on the left (the
 * workspace's first discovered repo — good enough for the MVP; a later pass
 * could resolve the repo for the ACTIVE file via `activeRepoFor` instead),
 * cursor position + active document's language + a transient message on the
 * right. Git state refreshes on the same debounced watcher other panels use.
 */
export function StatusBar({
  workspaceRoot,
  cursor,
  message,
  onToggleSidebar,
  overlayOpen,
}: StatusBarProps) {
  const state = useWorkbenchStore()
  const group = state.groups.find((g) => g.id === state.activeGroupId)
  const activeTab = group?.tabs.find((t) => t.path === group.activeTabPath)
  const activeFilePath =
    activeTab?.kind === "file" ? activeTab.path : (activeTab?.filePath ?? null)
  const language = activeFilePath ? documentRegistry.get(activeFilePath)?.language : undefined

  const sharedWatchers = useWorkbenchWatchers()
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [head, setHead] = useState<HeadInfo | null>(null)
  const [dirtyCount, setDirtyCount] = useState(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = (repo: RepoInfo) => {
    // Defense in depth: a git call failing here must never become an
    // unhandled rejection and take down the whole process.
    void repo.service
      .head()
      .then((h) => {
        if (mountedRef.current) setHead(h)
      })
      .catch(() => {})
    void repo.service
      .status()
      .then((s) => {
        if (!mountedRef.current) return
        setDirtyCount(s.mergeChanges.length + s.staged.length + s.changes.length + s.untracked.length)
      })
      .catch(() => {})
  }

  useEffect(() => {
    // Prefer the workbench's shared GitWatcher; only build a private one when
    // rendered standalone (outside a WatchersProvider, e.g. in isolated tests).
    let ownWatcher: GitWatcher | null = null
    let unsub = () => {}
    void discoverRepositories(workspaceRoot).then((discovered) => {
      if (!mountedRef.current) return
      setRepos(discovered)
      const primary = discovered[0]
      if (primary) refresh(primary)
      const onStale = (root: string) => {
        const repo = discovered.find((r) => r.root === root)
        if (repo) refresh(repo)
      }
      if (sharedWatchers) {
        unsub = sharedWatchers.onStatusStale(onStale)
      } else {
        ownWatcher = new GitWatcher(discovered)
        unsub = ownWatcher.onStatusStale(onStale)
      }
    })
    return () => {
      unsub()
      ownWatcher?.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot, sharedWatchers])

  const branchLabel = head
    ? head.detached
      ? "detached HEAD"
      : (head.branch ?? "")
    : repos.length === 0
      ? "no repository"
      : ""

  const handleToggle = () => {
    // A click landing under an open overlay must not restructure the workbench —
    // mirrors Ctrl+B, which the command dispatch gate blocks while one is open.
    if (overlayOpen) return
    onToggleSidebar?.()
  }

  return (
    <box
      height={1}
      width="100%"
      flexDirection="row"
      backgroundColor={theme.statusBarBackground}
      paddingLeft={1}
      paddingRight={1}
    >
      {onToggleSidebar ? (
        <box id="statusbar-sidebar-toggle" paddingRight={1} onMouseDown={handleToggle}>
          {/* Non-selectable: a bare click would otherwise start a renderer text
              selection whose empty mouse-up wipes the Ctrl+C copy cache
              (rendererSelection.ts) — the same cache global Ctrl+C copies from. */}
          <text fg={theme.statusBarForeground} selectable={false}>
            ☰
          </text>
        </box>
      ) : null}
      <text fg={theme.statusBarForeground}>
        {branchLabel ? ` ${branchLabel}` : ""}
        {dirtyCount > 0 ? ` (${dirtyCount})` : ""}
      </text>
      <box flexGrow={1} />
      {message ? <text fg={theme.statusBarForeground}>{message}  </text> : null}
      {cursor ? (
        <text fg={theme.statusBarForeground}>
          Ln {cursor.line}, Col {cursor.column}
          {language ? `  ${language}` : ""}
        </text>
      ) : language ? (
        <text fg={theme.statusBarForeground}>{language}</text>
      ) : null}
    </box>
  )
}
