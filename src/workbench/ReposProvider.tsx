/**
 * Single shared repo-discovery pass for the whole workbench.
 *
 * Every SCM-aware surface (StatusBar, ScmPanel, CommitLog) plus App's diff-open
 * routing needs the same `discoverRepositories(workspaceRoot)` result — a BFS
 * that stats/readdirs the tree and spawns `git rev-parse` per candidate. Run it
 * ONCE here and fan the result out via context so a cold boot pays for one sweep
 * instead of one per surface. `refresh()` re-runs it (a repo appeared/vanished
 * under the workspace).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { discoverRepositories, type RepoInfo } from "../services/repos"

export type Repos = {
  /** Discovered repos; `[]` until the async sweep completes, then its result. */
  repos: RepoInfo[]
  /** Re-run discovery (e.g. a repo was created/removed under the workspace). */
  refresh: () => void
}

const ReposContext = createContext<Repos | null>(null)

// The discovery machinery, shared by the provider and the standalone fallback.
// `workspaceRoot === null` parks it (no sweep, stays empty) — used when a
// provider is already present so useRepos's fallback copy never runs a sweep.
function useDiscovery(workspaceRoot: string | null): Repos {
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    if (workspaceRoot === null) return
    // Fire-and-forget: discoverRepositories never rejects (its git spawns
    // resolve null on failure), but guard the setState against a late unmount.
    void discoverRepositories(workspaceRoot).then((discovered) => {
      if (mountedRef.current) setRepos(discovered)
    })
  }, [workspaceRoot])

  useEffect(() => {
    refresh()
  }, [refresh])

  return useMemo(() => ({ repos, refresh }), [repos, refresh])
}

/**
 * Mounts the one shared discovery pass and provides {repos, refresh} to the whole
 * subtree. Sits above WatchersProvider so its GitWatcher is built from the SAME
 * discovered set rather than a second sweep.
 */
export function ReposProvider({
  workspaceRoot,
  children,
}: {
  workspaceRoot: string
  children: ReactNode
}) {
  const value = useDiscovery(workspaceRoot)
  return <ReposContext.Provider value={value}>{children}</ReposContext.Provider>
}

/**
 * The shared repos + refresh. Inside a {@link ReposProvider} (the real app) this
 * returns the single shared pass and `workspaceRoot` is ignored. Rendered
 * standalone (isolated panel tests), it falls back to its OWN discovery keyed on
 * `workspaceRoot` — mirroring how {@link useWorkbenchWatchers} lets a panel build
 * a private GitWatcher when no provider is present.
 */
export function useRepos(workspaceRoot: string): Repos {
  const ctx = useContext(ReposContext)
  const fallback = useDiscovery(ctx ? null : workspaceRoot)
  return ctx ?? fallback
}
