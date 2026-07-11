/**
 * Shared external-change watchers for the workbench.
 *
 * Two wirings live here:
 *  1. A single workspace fs watcher that reloads any OPEN, REGISTERED Document
 *     whose file changed on disk outside vsx (another editor, a script, git).
 *     `reloadFromDisk()` self-guards against clobbering a dirty buffer.
 *  2. One shared {@link GitWatcher} covering every discovered repo, exposed to
 *     panels (ScmPanel, StatusBar) and the DiffPane via context so exactly one
 *     watcher exists per repo root instead of each panel building its own.
 */

import { dirname } from "node:path"
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react"
import { documentRegistry } from "../model/documents"
import { GitWatcher } from "../services/repos"
import { createDirWatcher } from "../services/workspace"
import { useRepos } from "./ReposProvider"

/**
 * Reload any open document whose file changed or was (re)created on disk outside
 * vsx. Instead of recursively watching the whole workspace (which, under Bun on
 * Linux, synchronously walks the entire tree and exhausts the inotify budget), we
 * keep ONE non-recursive watch per distinct parent directory of an open document —
 * O(open tabs) watches. Dirs are reference-counted: two docs in one directory
 * share a watch, and it is dropped when the last of them closes.
 *
 * Deletions are ignored (an open buffer of a deleted file is left intact). Every
 * reload is best-effort: a read failure (e.g. the file grew past the size cap →
 * FileTooLargeError) is swallowed so one bad event can't crash anything. Returns a
 * disposer that stops all watches and unsubscribes from the registry.
 */
export function startDocumentReloadWatcher(): () => void {
  const dirWatcher = createDirWatcher((changes) => {
    for (const change of changes) {
      if (change.type === "deleted") continue
      const doc = documentRegistry.get(change.path)
      if (!doc) continue
      void doc.reloadFromDisk().catch(() => {})
    }
  })

  // Reference-count parent dirs so a dir's single watch lives exactly as long as
  // at least one open document sits in it.
  const dirRefs = new Map<string, number>()

  const retain = (path: string) => {
    const dir = dirname(path)
    const n = dirRefs.get(dir) ?? 0
    dirRefs.set(dir, n + 1)
    if (n === 0) dirWatcher.add(dir)
  }

  const release = (path: string) => {
    const dir = dirname(path)
    const n = dirRefs.get(dir)
    if (n === undefined) return
    if (n <= 1) {
      dirRefs.delete(dir)
      dirWatcher.remove(dir)
    } else {
      dirRefs.set(dir, n - 1)
    }
  }

  // Seed from docs already open when the watcher mounts, then track new ones.
  for (const path of documentRegistry.registeredPaths()) retain(path)
  const offRegister = documentRegistry.onDidRegister(retain)
  const offUnregister = documentRegistry.onDidUnregister(release)

  return () => {
    offRegister()
    offUnregister()
    dirWatcher.dispose()
  }
}

export type WorkbenchWatchers = {
  /** Subscribe to "this repo's git state went stale"; returns an unsubscribe. */
  onStatusStale: (cb: (repoRoot: string) => void) => () => void
  /**
   * Gate the external-edit staleness poll on whether the SCM view is on screen.
   * The Source Control panel calls this so the ~10s poll only runs while someone
   * is actually looking at working-tree status.
   */
  setScmVisible: (visible: boolean) => void
}

/**
 * A stable fan-out hub. Its identity never changes across renders (so consumer
 * effects don't re-run), while the underlying GitWatcher is bound late once repo
 * discovery finishes — subscribers registered before then still receive events.
 */
class WatchersHub implements WorkbenchWatchers {
  private readonly subscribers = new Set<(repoRoot: string) => void>()
  private watcher: GitWatcher | null = null
  private scmVisible = false

  onStatusStale(cb: (repoRoot: string) => void): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  emit(repoRoot: string): void {
    for (const cb of this.subscribers) cb(repoRoot)
  }

  /**
   * Bind the late-created GitWatcher (rebuilt whenever the repo set changes).
   * A freshly-bound watcher starts with the poll off, so re-apply the current
   * SCM visibility to it — otherwise a repo-set rebuild while the SCM view is
   * open would silently drop the poll.
   */
  setWatcher(watcher: GitWatcher | null): void {
    this.watcher = watcher
    watcher?.setStatusPollActive(this.scmVisible)
  }

  /** Save trigger: forward a vsx save to the git watcher (marks its repo stale). */
  notifyPathTouched(path: string): void {
    this.watcher?.notifyPathTouched(path)
  }

  setScmVisible(visible: boolean): void {
    if (this.scmVisible === visible) return
    this.scmVisible = visible
    this.watcher?.setStatusPollActive(visible)
  }
}

const WatchersContext = createContext<WorkbenchWatchers | null>(null)

/** The shared watchers, or null when rendered outside a {@link WatchersProvider}. */
export function useWorkbenchWatchers(): WorkbenchWatchers | null {
  return useContext(WatchersContext)
}

/**
 * Mounts the shared workspace + git watchers for the whole workbench and provides
 * the git-stale fan-out via context. Both watchers start on mount and are disposed
 * on unmount.
 */
export function WatchersProvider({
  workspaceRoot,
  children,
}: {
  workspaceRoot: string
  children: ReactNode
}) {
  const hubRef = useRef<WatchersHub | null>(null)
  if (!hubRef.current) hubRef.current = new WatchersHub()

  // The single shared discovery pass (ReposProvider sits above us). Feeding the
  // GitWatcher from this instead of a private sweep is the whole point of the
  // dedup — one BFS at boot backs both the panels and this watcher.
  const { repos } = useRepos(workspaceRoot)

  // Reload any open document whose file changed on disk. It watches only the
  // parent dirs of open documents, so it's independent of both the workspace root
  // and repo discovery — mount once for the workbench's lifetime.
  useEffect(() => startDocumentReloadWatcher(), [])

  // One shared GitWatcher over the discovered repos, rebuilt if the set changes.
  // Skipped while empty: discovery starts `[]` and an empty watcher would cover
  // nothing anyway; the subtree subscribes to the stable hub, not this watcher,
  // so a rebuild never drops a subscription.
  useEffect(() => {
    if (repos.length === 0) return
    const hub = hubRef.current!
    const gitWatcher = new GitWatcher(repos)
    gitWatcher.onStatusStale((root) => hub.emit(root))
    hub.setWatcher(gitWatcher)
    return () => {
      hub.setWatcher(null)
      gitWatcher.dispose()
    }
  }, [repos])

  // Save trigger: when vsx writes any open document to disk, mark its repo stale
  // so branch/status refresh at once — this replaces the removed working-tree
  // fs.watch for the common case (the user's own edits). Mount once: it forwards
  // through the stable hub, which relays to whichever GitWatcher is currently bound.
  useEffect(() => {
    const hub = hubRef.current!
    return documentRegistry.onDidSave((path) => hub.notifyPathTouched(path))
  }, [])

  return (
    <WatchersContext.Provider value={hubRef.current}>{children}</WatchersContext.Provider>
  )
}
