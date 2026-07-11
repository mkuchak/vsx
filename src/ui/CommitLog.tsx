import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { basename, join } from "node:path"
import { useEffect, useMemo, useRef, useState } from "react"
import { workbenchStore } from "../model/workbench"
import type { CommitInfo, DiffEntry } from "../services/git"
import { type RepoInfo } from "../services/repos"
import { gitStatusColor, theme } from "../theme"
import { useCommitDetails } from "../workbench/ModalProvider"
import { useOverlay } from "../workbench/OverlayProvider"
import { useRepos } from "../workbench/ReposProvider"

/** Git's well-known empty-tree SHA; used as the "before" ref for a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const DEFAULT_PAGE_SIZE = 50

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

/**
 * A compact, VSCode-ish relative timestamp: "just now" / "5m ago" / "3h ago" /
 * "2d ago", falling back to a short absolute date ("Jan 5") beyond ~30 days.
 * `now` is injectable so the formatting is deterministic in tests.
 */
export function formatRelativeDate(date: Date, now: Date = new Date()): string {
  const sec = Math.floor((now.getTime() - date.getTime()) / 1000)
  if (sec < 45) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

/**
 * Parse the raw `%D` decoration refs into display badges, stripping the
 * `HEAD -> ` prefix off the current-branch ref and flagging that this row is the
 * checked-out tip. `tag: ` prefixes are stripped too.
 */
export function parseRefs(refs: string[]): { badges: string[]; isHead: boolean } {
  let isHead = false
  const badges: string[] = []
  for (const raw of refs) {
    if (raw.startsWith("HEAD -> ")) {
      isHead = true
      badges.push(raw.slice("HEAD -> ".length))
    } else if (raw === "HEAD") {
      isHead = true
      badges.push("HEAD")
    } else if (raw.startsWith("tag: ")) {
      badges.push(raw.slice("tag: ".length))
    } else {
      badges.push(raw)
    }
  }
  return { badges, isHead }
}

type RepoState = {
  expanded: boolean
  /** null until first loaded; then the loaded commits (newest first). */
  commits: CommitInfo[] | null
  loading: boolean
  /** true once the oldest loaded commit is a root (no more history to page). */
  atEnd: boolean
  /** Per-commit changed files: array once loaded, "loading" while in flight. */
  expandedCommits: Map<string, DiffEntry[] | "loading">
}

function defaultRepoState(): RepoState {
  return { expanded: false, commits: null, loading: false, atEnd: false, expandedCommits: new Map() }
}

type Row =
  | { type: "section"; id: string; repoRoot: string }
  | { type: "commit"; id: string; repoRoot: string; commit: CommitInfo }
  | { type: "file"; id: string; repoRoot: string; commit: CommitInfo; entry: DiffEntry }
  | { type: "loadMore"; id: string; repoRoot: string }

function buildRows(repos: RepoInfo[], states: Map<string, RepoState>): Row[] {
  const rows: Row[] = []
  for (const repo of repos) {
    const st = states.get(repo.root) ?? defaultRepoState()
    rows.push({ type: "section", id: `${repo.root}::commits`, repoRoot: repo.root })
    if (!st.expanded || !st.commits) continue
    for (const commit of st.commits) {
      rows.push({
        type: "commit",
        id: `${repo.root}::c::${commit.hash}`,
        repoRoot: repo.root,
        commit,
      })
      const files = st.expandedCommits.get(commit.hash)
      if (Array.isArray(files)) {
        for (const entry of files) {
          rows.push({
            type: "file",
            id: `${repo.root}::f::${commit.hash}::${entry.path}`,
            repoRoot: repo.root,
            commit,
            entry,
          })
        }
      }
    }
    if (st.commits.length > 0 && !st.atEnd) {
      rows.push({ type: "loadMore", id: `${repo.root}::more`, repoRoot: repo.root })
    }
  }
  return rows
}

function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/")
  return i === -1 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

export type CommitLogProps = {
  workspaceRoot: string
  focused: boolean
  /** Commits fetched per page; small values let tests exercise "Load more". */
  pageSize?: number
}

/**
 * VSCode "Commits" view, simplified to a LINEAR (no-graph) per-repo list. Each
 * repo has a collapsible COMMITS section; expanding it lazily fetches commits.
 * A commit row expands inline to its changed files; a file row opens a
 * commit-vs-parent diff. Root commits diff against the empty tree.
 *
 * No live git-state watcher is wired here — commits are fetched on first expand
 * and paged via "Load more"; a refresh-on-change integration is a later
 * workbench-assembly concern (same limitation DiffPane notes for git state).
 */
export function CommitLog({ workspaceRoot, focused, pageSize = DEFAULT_PAGE_SIZE }: CommitLogProps) {
  const { isOverlayOpen } = useOverlay()
  const showCommitDetails = useCommitDetails()
  const { repos } = useRepos(workspaceRoot)
  const [states, setStates] = useState<Map<string, RepoState>>(() => new Map())
  const [selectedIndex, setSelectedIndex] = useState(0)

  const mountedRef = useRef(true)
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const serviceFor = (repoRoot: string) =>
    repos.find((r) => r.root === repoRoot)?.service ?? null

  const updateRepo = (repoRoot: string, fn: (s: RepoState) => RepoState) => {
    if (!mountedRef.current) return
    setStates((prev) => {
      const next = new Map(prev)
      next.set(repoRoot, fn(next.get(repoRoot) ?? defaultRepoState()))
      return next
    })
  }

  const loadCommits = async (repoRoot: string) => {
    const svc = serviceFor(repoRoot)
    if (!svc) return
    updateRepo(repoRoot, (s) => ({ ...s, loading: true }))
    try {
      const commits = await svc.log({ maxEntries: pageSize })
      const oldest = commits[commits.length - 1]
      const atEnd = commits.length === 0 || (oldest?.parents.length ?? 0) === 0
      updateRepo(repoRoot, (s) => ({ ...s, commits, loading: false, atEnd }))
    } catch {
      updateRepo(repoRoot, (s) => ({ ...s, loading: false }))
    }
  }

  const loadMore = async (repoRoot: string) => {
    const svc = serviceFor(repoRoot)
    if (!svc) return
    const st = states.get(repoRoot)
    const current = st?.commits ?? []
    const oldest = current[current.length - 1]
    if (st?.loading || !oldest || oldest.parents.length === 0) return
    updateRepo(repoRoot, (s) => ({ ...s, loading: true }))
    try {
      // A single ref is its own "range": history reachable from the parent, i.e.
      // everything strictly older than what we already have.
      const older = await svc.log({ range: oldest.parents[0] })
      updateRepo(repoRoot, (s) => {
        const have = new Set((s.commits ?? []).map((c) => c.hash))
        const merged = [...(s.commits ?? []), ...older.filter((c) => !have.has(c.hash))]
        const tail = merged[merged.length - 1]
        return { ...s, commits: merged, loading: false, atEnd: (tail?.parents.length ?? 0) === 0 }
      })
    } catch {
      updateRepo(repoRoot, (s) => ({ ...s, loading: false }))
    }
  }

  const toggleSection = (repoRoot: string) => {
    const st = states.get(repoRoot) ?? defaultRepoState()
    const willExpand = !st.expanded
    updateRepo(repoRoot, (s) => ({ ...s, expanded: willExpand }))
    if (willExpand && st.commits === null && !st.loading) void loadCommits(repoRoot)
  }

  const toggleCommit = async (repoRoot: string, commit: CommitInfo) => {
    const svc = serviceFor(repoRoot)
    if (!svc) return
    const st = states.get(repoRoot)
    const existing = st?.expandedCommits.get(commit.hash)
    if (existing !== undefined) {
      updateRepo(repoRoot, (s) => {
        const map = new Map(s.expandedCommits)
        map.delete(commit.hash)
        return { ...s, expandedCommits: map }
      })
      return
    }
    updateRepo(repoRoot, (s) => {
      const map = new Map(s.expandedCommits)
      map.set(commit.hash, "loading")
      return { ...s, expandedCommits: map }
    })
    const oldRef = commit.parents.length === 0 ? EMPTY_TREE : commit.parents[0]
    try {
      const entries = await svc.diffNameStatus(oldRef, commit.hash)
      updateRepo(repoRoot, (s) => {
        const map = new Map(s.expandedCommits)
        map.set(commit.hash, entries)
        return { ...s, expandedCommits: map }
      })
    } catch {
      updateRepo(repoRoot, (s) => {
        const map = new Map(s.expandedCommits)
        map.delete(commit.hash)
        return { ...s, expandedCommits: map }
      })
    }
  }

  const openFileDiff = (row: Extract<Row, { type: "file" }>) => {
    const repo = repos.find((r) => r.root === row.repoRoot)
    if (!repo) return
    const { commit, entry } = row
    const oldRef = commit.parents.length === 0 ? EMPTY_TREE : commit.parents[0]
    const filePath = join(repo.root, entry.path)
    const label = `${basename(entry.path)} (${commit.hash.slice(0, 7)})`
    workbenchStore.openCommitDiff(filePath, oldRef, commit.hash, repo.root, label, { preview: true })
  }

  const rows = useMemo(() => buildRows(repos, states), [repos, states])

  useEffect(() => {
    setSelectedIndex((i) => (rows.length === 0 ? 0 : Math.min(Math.max(0, i), rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    const row = rows[selectedIndex]
    if (row && scrollRef.current) scrollRef.current.scrollChildIntoView(row.id)
  }, [selectedIndex, rows])

  const activateRow = (row: Row) => {
    switch (row.type) {
      case "section":
        toggleSection(row.repoRoot)
        break
      case "commit":
        void toggleCommit(row.repoRoot, row.commit)
        break
      case "file":
        openFileDiff(row)
        break
      case "loadMore":
        void loadMore(row.repoRoot)
        break
    }
  }

  const selectRow = (index: number) => setSelectedIndex(index)

  const openDetails = (repoRoot: string, commit: CommitInfo) => {
    const svc = serviceFor(repoRoot)
    if (!svc) return
    showCommitDetails({
      commit,
      fetchStats: () => svc.commitStats(commit.hash).catch(() => null),
    })
  }

  useKeyboard((key) => {
    if (!focused || isOverlayOpen) return
    switch (key.name) {
      case "up":
        setSelectedIndex((i) => Math.max(0, i - 1))
        break
      case "down":
        setSelectedIndex((i) => Math.min(rows.length - 1, i + 1))
        break
      case "return":
      case "enter": {
        const row = rows[selectedIndex]
        if (row) activateRow(row)
        break
      }
      case "i": {
        const row = rows[selectedIndex]
        if (row && row.type === "commit") openDetails(row.repoRoot, row.commit)
        break
      }
    }
  })

  const selectedId = rows[selectedIndex]?.id

  return (
    <box flexDirection="column" height="100%" backgroundColor={theme.sidebarBackground}>
      <scrollbox ref={scrollRef} flexGrow={1}>
        {repos.length === 0 ? (
          <text fg={theme.dimForeground}>No repositories</text>
        ) : (
          repos.map((repo) => {
            const st = states.get(repo.root) ?? defaultRepoState()
            const sectionId = `${repo.root}::commits`
            return (
              <box key={repo.root} flexDirection="column" width="100%">
                {repos.length > 1 ? (
                  <box height={1} paddingLeft={1}>
                    <text fg={theme.foreground}>{basename(repo.root)}</text>
                  </box>
                ) : null}
                <box
                  id={sectionId}
                  flexDirection="row"
                  width="100%"
                  height={1}
                  paddingLeft={1}
                  backgroundColor={selectedId === sectionId ? theme.selectionBackground : undefined}
                  onMouseDown={() => {
                    selectRow(rows.findIndex((r) => r.id === sectionId))
                    toggleSection(repo.root)
                  }}
                >
                  <text fg={theme.foreground}>{`${st.expanded ? "▼" : "▶"} COMMITS`}</text>
                </box>
                {st.expanded ? (
                  st.commits === null && st.loading ? (
                    <box paddingLeft={2}>
                      <text fg={theme.dimForeground}>Loading…</text>
                    </box>
                  ) : (
                    <CommitList
                      repo={repo}
                      state={st}
                      rows={rows}
                      selectedId={selectedId}
                      onSelect={selectRow}
                      onActivate={activateRow}
                      onShowDetails={openDetails}
                    />
                  )
                ) : null}
              </box>
            )
          })
        )}
      </scrollbox>
    </box>
  )
}

function CommitList({
  repo,
  state,
  rows,
  selectedId,
  onSelect,
  onActivate,
  onShowDetails,
}: {
  repo: RepoInfo
  state: RepoState
  rows: Row[]
  selectedId: string | undefined
  onSelect: (index: number) => void
  onActivate: (row: Row) => void
  onShowDetails: (repoRoot: string, commit: CommitInfo) => void
}) {
  const indexOf = (id: string) => rows.findIndex((r) => r.id === id)

  return (
    <box flexDirection="column" width="100%">
      {(state.commits ?? []).map((commit) => {
        const commitId = `${repo.root}::c::${commit.hash}`
        const { badges, isHead } = parseRefs(commit.refs)
        const subject = commit.message.split("\n")[0]
        const files = state.expandedCommits.get(commit.hash)
        return (
          <box key={commit.hash} flexDirection="column" width="100%">
            <box
              id={commitId}
              flexDirection="row"
              width="100%"
              height={1}
              paddingLeft={2}
              backgroundColor={selectedId === commitId ? theme.selectionBackground : undefined}
              onMouseDown={() => {
                onSelect(indexOf(commitId))
                onActivate({ type: "commit", id: commitId, repoRoot: repo.root, commit })
              }}
            >
              <text fg={theme.dimForeground}>{`${commit.hash.slice(0, 7)} `}</text>
              <text fg={isHead ? theme.accent : theme.foreground}>{subject}</text>
              {badges.map((b) => (
                <text key={b} fg={theme.info}>{` [${b}]`}</text>
              ))}
              <box flexGrow={1} />
              <text fg={theme.dimForeground}>{formatRelativeDate(commit.authorDate)}</text>
              {selectedId === commitId ? (
                <text
                  fg={theme.info}
                  onMouseDown={(event) => {
                    // stopPropagation so the ⓘ opens details without the row's
                    // own onMouseDown also toggling its changed-files list.
                    event.stopPropagation()
                    onShowDetails(repo.root, commit)
                  }}
                >
                  {" ⓘ"}
                </text>
              ) : (
                <text fg={theme.dimForeground}> </text>
              )}
            </box>
            {files === "loading" ? (
              <box paddingLeft={4}>
                <text fg={theme.dimForeground}>Loading…</text>
              </box>
            ) : Array.isArray(files) ? (
              files.map((entry) => {
                const fileId = `${repo.root}::f::${commit.hash}::${entry.path}`
                const { name, dir } = splitPath(entry.path)
                return (
                  <box
                    key={fileId}
                    id={fileId}
                    flexDirection="row"
                    width="100%"
                    height={1}
                    paddingLeft={4}
                    backgroundColor={selectedId === fileId ? theme.selectionBackground : undefined}
                    onMouseDown={() => {
                      onSelect(indexOf(fileId))
                      onActivate({ type: "file", id: fileId, repoRoot: repo.root, commit, entry })
                    }}
                  >
                    <text fg={theme.foreground}>{name}</text>
                    {dir ? <text fg={theme.dimForeground}>{` ${dir}`}</text> : null}
                    <box flexGrow={1} />
                    <text fg={gitStatusColor(entry.statusLetter[0])}>{entry.statusLetter[0]}</text>
                    <text fg={theme.dimForeground}> </text>
                  </box>
                )
              })
            ) : null}
          </box>
        )
      })}
      {state.commits && state.commits.length > 0 && !state.atEnd ? (
        <box
          id={`${repo.root}::more`}
          flexDirection="row"
          width="100%"
          height={1}
          paddingLeft={2}
          backgroundColor={
            selectedId === `${repo.root}::more` ? theme.selectionBackground : undefined
          }
          onMouseDown={() => {
            onSelect(indexOf(`${repo.root}::more`))
            onActivate({ type: "loadMore", id: `${repo.root}::more`, repoRoot: repo.root })
          }}
        >
          <text fg={theme.dimForeground}>{state.loading ? "Loading…" : "Load more…"}</text>
        </box>
      ) : null}
    </box>
  )
}
