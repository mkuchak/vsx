import type { MouseEvent as TuiMouseEvent } from "@opentui/core"
import { useEffect, useRef, useState } from "react"
import { documentRegistry } from "../model/documents"
import { theme } from "../theme"
import { GitWatcher, type RepoInfo } from "../services/repos"
import type { HeadInfo } from "../services/git"
import { useWorkbenchStore } from "../workbench/useWorkbenchStore"
import { useRepos } from "../workbench/ReposProvider"
import { useWorkbenchWatchers } from "../workbench/watchers"
import type { CursorPosition } from "./EditorPane"

const MOUSE_BUTTON_LEFT = 0

export type StatusBarProps = {
  workspaceRoot: string
  cursor: CursorPosition | null
  /** Transient message slot (e.g. "Saved", surfaced git errors). Auto-clears after ~2s. */
  message?: string | null
  /** Toggles sidebar visibility; renders an always-visible ☰ cell when provided. */
  onToggleSidebar?: () => void
  /** When an overlay owns the screen, the ☰ click is inert (mirrors Ctrl+B's dispatch gate). */
  overlayOpen?: boolean
  /** Renders a discreet ⏻ cell at the far right; fires on a completed left-click. */
  onQuit?: () => void
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
  onQuit,
}: StatusBarProps) {
  const state = useWorkbenchStore()
  const group = state.groups.find((g) => g.id === state.activeGroupId)
  const activeTab = group?.tabs.find((t) => t.path === group.activeTabPath)
  const activeFilePath =
    activeTab?.kind === "file" ? activeTab.path : (activeTab?.filePath ?? null)
  const language = activeFilePath ? documentRegistry.get(activeFilePath)?.language : undefined

  const sharedWatchers = useWorkbenchWatchers()
  const { repos } = useRepos(workspaceRoot)
  const [head, setHead] = useState<HeadInfo | null>(null)
  const [dirtyCount, setDirtyCount] = useState(0)
  const [quitHovered, setQuitHovered] = useState(false)
  const [quitPressed, setQuitPressed] = useState(false)
  // Source of truth for whether mouse-up should fire onQuit: a ref (not the
  // `quitPressed` state above) because no render happens between the down and up
  // events the renderer dispatches, so a handler reading state alone would close
  // over the pre-press value (the same stale-closure hazard SplitDivider's
  // `lastDown` ref sidesteps).
  const quitArmedRef = useRef(false)
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
    const primary = repos[0]
    if (primary) refresh(primary)
    const onStale = (root: string) => {
      const repo = repos.find((r) => r.root === root)
      if (repo) refresh(repo)
    }
    // Prefer the workbench's shared GitWatcher; only build a private one when
    // rendered standalone (outside a WatchersProvider, e.g. in isolated tests).
    if (sharedWatchers) {
      return sharedWatchers.onStatusStale(onStale)
    }
    const ownWatcher = new GitWatcher(repos)
    const unsub = ownWatcher.onStatusStale(onStale)
    return () => {
      unsub()
      ownWatcher.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, sharedWatchers])

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

  const handleQuitMouseDown = (event: TuiMouseEvent) => {
    // Quitting must only ever be armed by a left-click; a right-click must not
    // trigger it (and mouse-down never fires onQuit directly — see mouse-up below,
    // so a drag-off can abort a quit that's destructive to fire early).
    if (event.button !== MOUSE_BUTTON_LEFT) return
    quitArmedRef.current = true
    setQuitPressed(true)
  }

  const handleQuitMouseUp = () => {
    if (quitArmedRef.current) onQuit?.()
    quitArmedRef.current = false
    setQuitPressed(false)
  }

  const handleQuitMouseOut = () => {
    // Dragging off the cell before release aborts the quit.
    quitArmedRef.current = false
    setQuitPressed(false)
    setQuitHovered(false)
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
      {onQuit ? (
        <box
          id="statusbar-quit-button"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={quitHovered || quitPressed ? theme.error : theme.statusBarBackground}
          onMouseDown={handleQuitMouseDown}
          onMouseUp={handleQuitMouseUp}
          onMouseOver={() => setQuitHovered(true)}
          onMouseOut={handleQuitMouseOut}
        >
          {/* Non-selectable: a bare click would otherwise start a renderer text
              selection whose empty mouse-up wipes the Ctrl+C copy cache
              (rendererSelection.ts) — the same cache global Ctrl+C copies from. */}
          <text fg={theme.statusBarForeground} selectable={false}>
            ⏻
          </text>
        </box>
      ) : null}
    </box>
  )
}
