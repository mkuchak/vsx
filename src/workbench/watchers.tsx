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

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react"
import { documentRegistry } from "../model/documents"
import { discoverRepositories, GitWatcher } from "../services/repos"
import { watch as watchWorkspace } from "../services/workspace"

/**
 * Watch the workspace tree and reload any open document whose file changed or was
 * (re)created on disk. Deletions are ignored (an open buffer of a deleted file is
 * left intact). Every reload is best-effort: a read failure (e.g. the file grew
 * past the size cap → FileTooLargeError) is swallowed so one bad event can't crash
 * anything. Returns a disposer that stops the watcher.
 */
export function startDocumentReloadWatcher(workspaceRoot: string): () => void {
  return watchWorkspace(workspaceRoot, (changes) => {
    for (const change of changes) {
      if (change.type === "deleted") continue
      const doc = documentRegistry.get(change.path)
      if (!doc) continue
      void doc.reloadFromDisk().catch(() => {})
    }
  })
}

export type WorkbenchWatchers = {
  /** Subscribe to "this repo's git state went stale"; returns an unsubscribe. */
  onStatusStale: (cb: (repoRoot: string) => void) => () => void
}

/**
 * A stable fan-out hub. Its identity never changes across renders (so consumer
 * effects don't re-run), while the underlying GitWatcher is bound late once repo
 * discovery finishes — subscribers registered before then still receive events.
 */
class WatchersHub implements WorkbenchWatchers {
  private readonly subscribers = new Set<(repoRoot: string) => void>()

  onStatusStale(cb: (repoRoot: string) => void): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  emit(repoRoot: string): void {
    for (const cb of this.subscribers) cb(repoRoot)
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

  useEffect(() => {
    const hub = hubRef.current!
    let disposed = false
    let gitWatcher: GitWatcher | null = null
    const disposeReload = startDocumentReloadWatcher(workspaceRoot)

    void discoverRepositories(workspaceRoot).then((repos) => {
      if (disposed) return
      gitWatcher = new GitWatcher(repos)
      gitWatcher.onStatusStale((root) => hub.emit(root))
    })

    return () => {
      disposed = true
      disposeReload()
      gitWatcher?.dispose()
    }
  }, [workspaceRoot])

  return (
    <WatchersContext.Provider value={hubRef.current}>{children}</WatchersContext.Provider>
  )
}
