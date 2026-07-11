import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { Binding, Command, KeyLike } from "@opentui/keymap"
import { useKeyboard } from "@opentui/react"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import type { ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { FileHistory } from "../services/fileHistory"
import { workbenchStore } from "../model/workbench"
import { type CommandInfo, withMacSuper } from "../services/commands"
import { isLabelMatch, scoreAndSort, type MatchRange } from "../services/fuzzy"
import { enumerateFiles, listDir, type DirEntry } from "../services/workspace"
import { CURSOR_STYLE, theme } from "../theme"
import { useCommands } from "../workbench/CommandsProvider"
import { useOverlay } from "../workbench/OverlayProvider"

const MAX_RESULTS = 50
// Global recommendations shown on an empty query, and the trailing cap on
// out-of-workspace history matches for a typed query.
const EMPTY_QUERY_TOP = 15
const OUTSIDE_CAP = 5
// How deep into the ranked history to scan for boosts / outside matches / staleness.
const HISTORY_SCAN = 200
// Frecency boost ceiling for a typed-query favorite. Kept far below the fuzzy
// tier size (65536) so a boost reorders WITHIN a match tier but never across
// one — but ONLY once it's gated to label-tier matches (isLabelMatch) below.
// A description-only score is clamped to TIER_CONTAINS - 1 (fuzzy.ts), just 1
// point under the seam, so boosting it unconditionally could walk it past a
// weak label match on a different file; the gate keeps the boost from ever
// applying there.
const FRECENCY_BOOST_MAX = 1000
// Dim marker on rows whose file lives outside the workspace, so opening (or
// evicting) one is no surprise.
const OUTSIDE_BADGE = "↗"

function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

// True only for the workspace fuzzy-file mode — a non-empty query with none of
// the mode-switching prefixes (`>` command, `:` go-to-line, `/`|`~` path browse).
// The truncation hint is meaningful only here, since those other modes don't draw
// from the (possibly-clipped) `enumerateFiles` list.
function isFileQuery(query: string): boolean {
  return query !== "" && !/^[>:/~]/.test(query)
}

/** Whether `path` is `dir` itself or nested under it. */
function isInside(path: string, dir: string): boolean {
  if (path === dir) return true
  return path.startsWith(dir.endsWith("/") ? dir : `${dir}/`)
}

/**
 * How a history entry's ABSOLUTE path reads in the picker: workspace-relative
 * when it lives under the root, else the home dir abbreviated to `~`. A bare
 * `relative(workspaceRoot, …)` would yield ugly ../../ chains for outside-root
 * paths, so those get the `~` abbreviation (or the raw absolute path) instead.
 */
function displayPath(absPath: string, workspaceRoot: string, home: string): string {
  if (isInside(absPath, workspaceRoot)) return relative(workspaceRoot, absPath)
  if (isInside(absPath, home)) return `~${absPath.slice(home.length)}`
  return absPath
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function capitalize(part: string): string {
  return part.length === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
}

/**
 * Split a filesystem path query into the parent directory to list and the
 * trailing fragment to match against its entries. A leading `~` (or `~/`) is
 * expanded to the home directory first — nothing else in the app expands `~`.
 *
 * Splits at the LAST `/`: `"/foo/bar/"` → list `/foo/bar` (fragment ""),
 * `"/foo/ba"` → list `/foo` (fragment "ba"). A slash at index 0 keeps the root
 * as the directory (`"/foo"` → dir "/", fragment "foo").
 */
export function splitPathQuery(query: string, home: string): { dir: string; fragment: string } {
  let expanded: string
  if (query === "~") expanded = home
  else if (query.startsWith("~/")) expanded = home + query.slice(1)
  else expanded = query
  const lastSlash = expanded.lastIndexOf("/")
  const dir = lastSlash <= 0 ? "/" : expanded.slice(0, lastSlash)
  const fragment = expanded.slice(lastSlash + 1)
  return { dir, fragment }
}

// Render a keybinding for display. `KeyLike` is either a chord string like
// "ctrl+shift+p" or a stroke object; normalize both to "Ctrl+Shift+P".
function formatKeybinding(key: KeyLike): string {
  if (typeof key === "string") {
    return key.split("+").map(capitalize).join("+")
  }
  const parts: string[] = []
  if (key.ctrl) parts.push("Ctrl")
  if (key.shift) parts.push("Shift")
  if (key.meta) parts.push("Meta")
  if (key.super) parts.push("Super")
  if (key.hyper) parts.push("Hyper")
  parts.push(capitalize(key.name))
  return parts.join("+")
}

/**
 * A single row the overlay can render + accept. Kept source-agnostic so a later
 * command-palette (`>` prefix) task can produce these from the command registry
 * instead of the file list without touching the render/keyboard code.
 */
type ResultItem = {
  label: string
  description?: string
  /** Right-aligned, dimmed keybinding hint (command mode only). */
  keybinding?: string
  /** Dim trailing marker, e.g. the outside-workspace badge. */
  badge?: string
  labelMatches: MatchRange[]
  descriptionMatches: MatchRange[]
  onAccept: () => void
  /** History-sourced rows only: remove this entry from the frecency store. */
  onEvict?: () => void
}

function highlight(text: string, ranges: MatchRange[]): ReactNode {
  if (ranges.length === 0) return text
  const nodes: ReactNode[] = []
  let last = 0
  ranges.forEach(([start, end], i) => {
    if (start > last) nodes.push(text.slice(last, start))
    nodes.push(<strong key={i}>{text.slice(start, end)}</strong>)
    last = end
  })
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function QuickInput({
  workspaceRoot,
  onGotoLine,
  homeDir,
  fileHistory,
}: {
  workspaceRoot: string
  onGotoLine?: (line: number, column?: number) => void
  // Overridable home for `~` expansion; defaults to the OS home. Injectable so
  // path-browse tests stay hermetic instead of reading the CI machine's $HOME.
  homeDir?: string
  // The cross-project frecency ranking that powers the empty-query
  // recommendations, typed-query boosts, and per-entry eviction. Injected (like
  // `homeDir`) so tests seed a hermetic store instead of the real state dir; when
  // absent the history features are simply inert.
  fileHistory?: FileHistory
}) {
  const commands = useCommands()
  const { setOverlayOpen } = useOverlay()

  const [visible, setVisible] = useState(false)
  const [query, setQuery] = useState("")
  const [files, setFiles] = useState<string[]>([])
  // The workspace file index was clipped (time budget or file cap) — surfaced as
  // a footer hint so a user on a huge root knows the fuzzy list is partial.
  const [filesTruncated, setFilesTruncated] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const home = useMemo(() => homeDir ?? homedir(), [homeDir])

  // Live filesystem listing for absolute/`~` path queries. Cached by the parent
  // directory so keystrokes that only change the trailing fragment re-filter the
  // held entries in-memory instead of re-hitting the disk. `dir` guards the memo
  // so a stale directory's entries are never shown while a new load is in flight,
  // AND dedupes the load effect: it only re-lists once a directory differs from
  // the last COMMITTED listing, so a load cancelled mid-flight (by a fragment
  // keystroke) still re-fires rather than leaving the listing permanently empty.
  const [dirListing, setDirListing] = useState<{ dir: string; entries: DirEntry[] }>({
    dir: "",
    entries: [],
  })

  // What was active before opening — tracked for future MRU/focus-restore work.
  const restoreRef = useRef<string | null>(null)

  // History paths that no longer exist on disk (stat'd on open); filtered out of
  // display so a deleted favorite never shows as a dead row.
  const [missingHistory, setMissingHistory] = useState<Set<string>>(() => new Set())
  // Bumped on eviction to force the results memo to re-read the (mutated-in-place)
  // history store, which does not notify React on its own.
  const [evictTick, setEvictTick] = useState(0)

  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  // Live mirrors so the modal layer's commands (registered once per open) can read
  // the current results/selection without re-registering every render.
  const resultsRef = useRef<ResultItem[]>([])
  const selectedIndexRef = useRef(0)
  selectedIndexRef.current = selectedIndex

  useEffect(() => {
    const openWith = (seed: string) => {
      const state = workbenchStore.getState()
      const group = state.groups.find((g) => g.id === state.activeGroupId)
      restoreRef.current = group?.activeTabPath ?? null
      setQuery(seed)
      setSelectedIndex(0)
      setVisible(true)
    }
    const disposers = [
      commands.registerCommand({
        id: "workbench.quickOpen",
        title: "Quick Open",
        category: "Navigation",
        keybinding: withMacSuper("ctrl+p"),
        run: () => openWith(""),
      }),
      commands.registerCommand({
        id: "workbench.showCommands",
        title: "Show All Commands",
        category: "Navigation",
        keybinding: withMacSuper("ctrl+shift+p"),
        run: () => openWith(">"),
      }),
      // F1 fallback: Ctrl+Shift+letter needs a kitty-capable terminal to
      // disambiguate from plain Ctrl+letter, so bind F1 too (always works).
      commands.registerCommand({
        id: "workbench.showCommands.f1",
        title: "Show All Commands",
        category: "Navigation",
        keybinding: "f1",
        run: () => openWith(">"),
      }),
    ]
    return () => disposers.forEach((dispose) => dispose())
  }, [commands])

  // Report open/closed into the shared overlay signal so global key handlers gate
  // on it and the editor's focus is restored (via overlayCloseEpoch) on close.
  // Driven off `visible`, so every close path (accept/Esc/blur/unmount) is covered.
  useEffect(() => {
    if (!visible) return
    setOverlayOpen("quickInput", true)
    return () => setOverlayOpen("quickInput", false)
  }, [visible, setOverlayOpen])

  // Re-enumerate on each open; simplest and cheap enough for the MVP.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void enumerateFiles(workspaceRoot).then((res) => {
      if (cancelled) return
      setFiles(res.files)
      setFilesTruncated(res.truncated)
    })
    return () => {
      cancelled = true
    }
  }, [visible, workspaceRoot])

  // Load the parent directory of a path query whenever that directory changes.
  // `listDir` has no internal error handling, so wrap it: a half-typed or
  // unreadable path (ENOENT/EACCES) resolves to an empty listing, never a crash.
  useEffect(() => {
    if (!visible) return
    if (!(query.startsWith("/") || query.startsWith("~"))) return
    const { dir } = splitPathQuery(query, home)
    if (dir === dirListing.dir) return
    let cancelled = false
    void listDir(dir)
      .then((entries) => {
        if (!cancelled) setDirListing({ dir, entries })
      })
      .catch(() => {
        if (!cancelled) setDirListing({ dir, entries: [] })
      })
    return () => {
      cancelled = true
    }
  }, [visible, query, home, dirListing.dir])

  // On open, stat the ranked history paths and hide any that vanished from disk
  // (display-only — the store's own 90-day `pruneMissing` is the real remover,
  // kicked opportunistically here). Mirrors the listDir effect's cancel flag so a
  // reopen mid-scan can't commit a stale result.
  useEffect(() => {
    if (!visible || !fileHistory) return
    let cancelled = false
    const candidates = fileHistory.top(HISTORY_SCAN)
    void (async () => {
      const missing = new Set<string>()
      await Promise.all(
        candidates.map(async (e) => {
          if (!(await pathExists(e.path))) missing.add(e.path)
        }),
      )
      if (!cancelled) setMissingHistory(missing)
    })()
    void fileHistory.pruneMissing(pathExists)
    return () => {
      cancelled = true
    }
  }, [visible, fileHistory])

  // Modal keymap layer, live for the whole time the overlay is open. It (a)
  // shadows base bindings such as ctrl+q quit so they can't fire mid-query, and
  // (b) owns Up/Down — the focused <input> swallows arrow keys before they reach
  // a useKeyboard handler, so navigation must route through the keymap instead.
  // Enter/Escape DO reach useKeyboard, so they stay there. Popped on every close
  // path (accept, escape, unmount) via this effect's cleanup.
  useEffect(() => {
    if (!visible) return
    const layerCommands = [
      {
        name: "quickInput.up",
        run: () => setSelectedIndex((i) => Math.max(0, i - 1)),
      },
      {
        name: "quickInput.down",
        run: () => setSelectedIndex((i) => Math.min(resultsRef.current.length - 1, i + 1)),
      },
      // Shift+Delete (the browser remove-suggestion idiom) evicts the selected row
      // IF it is history-sourced; a no-op otherwise. Ctrl+X stays reserved for cut.
      // Needs a Kitty-protocol terminal to carry the shift bit — on a legacy
      // terminal, bare Delete (\x1b[3~) can't be told apart from Shift+Delete, so
      // this chord silently never fires there; the row's ✕ button is the fallback.
      {
        name: "quickInput.evict",
        run: () => resultsRef.current[selectedIndexRef.current]?.onEvict?.(),
      },
      { name: "quickInput.block", run: () => {} },
    ] as unknown as Command<Renderable, KeyEvent>[]
    const bindings = [
      { key: "up", cmd: "quickInput.up" },
      { key: "down", cmd: "quickInput.down" },
      { key: "shift+delete", cmd: "quickInput.evict" },
      { key: "ctrl+q", cmd: "quickInput.block" },
    ] as unknown as Binding<Renderable, KeyEvent>[]
    return commands.pushLayer({ commands: layerCommands, bindings })
  }, [visible, commands])

  // `absPath` MUST be absolute — tab paths and the document registry are keyed by
  // absolute path, so the same file never becomes two tabs/Documents.
  const accept = (absPath: string) => {
    // openFile records the open through the store's frecency recorder — the ranking
    // now lives in the injected history service, not a local MRU.
    workbenchStore.openFile(absPath, { preview: true })
    setVisible(false)
  }

  const evict = (absPath: string) => {
    fileHistory?.evict(absPath)
    // The store mutates in place without notifying React; bump a tick so the
    // results memo re-reads top()/frecency and drops the evicted row.
    setEvictTick((t) => t + 1)
  }

  const results = useMemo<ResultItem[]>(() => {
    if (!visible) return []

    // Command palette mode: `>` strips to a search term over the registry.
    if (query.startsWith(">")) {
      const term = query.slice(1)
      const toItem = (
        cmd: CommandInfo,
        labelMatches: MatchRange[],
        descriptionMatches: MatchRange[],
      ): ResultItem => ({
        label: cmd.title,
        description: cmd.category,
        keybinding: cmd.keybinding ? formatKeybinding(cmd.keybinding) : undefined,
        labelMatches,
        descriptionMatches,
        // Close the palette BEFORE running: the command may push its own modal,
        // which must not render underneath a still-open palette. The close hasn't
        // flushed through the overlay signal yet, so bypass the dispatch gate that
        // would otherwise reject this palette-initiated command.
        onAccept: () => {
          setVisible(false)
          commands.executeCommand(cmd.id, { bypassGate: true })
        },
      })
      const allCommands = commands.getCommands()
      if (term === "") {
        // Show every command in the registry's MRU-first order, unranked.
        return allCommands.map((cmd) => toItem(cmd, [], []))
      }
      return scoreAndSort(term, allCommands, (cmd) => ({ label: cmd.title, description: cmd.category }))
        .slice(0, MAX_RESULTS)
        .map((r) => toItem(r.item, r.labelMatches, r.descriptionMatches))
    }

    // Go to line mode: `:<line>` or `:<line>:<col>` (both 1-based).
    if (query.startsWith(":")) {
      const rest = query.slice(1).trim()
      const m = rest.match(/^(\d+)(?::(\d+))?$/)
      if (m) {
        const line = Number.parseInt(m[1]!, 10)
        const column = m[2] !== undefined ? Number.parseInt(m[2], 10) : undefined
        const label = column !== undefined ? `Go to line ${line}, column ${column}` : `Go to line ${line}`
        return [
          {
            label,
            labelMatches: [],
            descriptionMatches: [],
            onAccept: () => {
              onGotoLine?.(line, column)
              setVisible(false)
            },
          },
        ]
      }
      return [
        {
          label: "Type a line number",
          labelMatches: [],
          descriptionMatches: [],
          onAccept: () => {},
        },
      ]
    }

    // Path browse mode: an absolute (`/…`) or home (`~…`) query lists the parent
    // directory live and matches the trailing fragment against its entries.
    if (query.startsWith("/") || query.startsWith("~")) {
      const { dir, fragment } = splitPathQuery(query, home)
      // Ignore entries still belonging to a previous directory (load in flight).
      const entries = dirListing.dir === dir ? dirListing.entries : []
      const rows =
        fragment === ""
          ? entries.map((entry) => ({ entry, labelMatches: [] as MatchRange[] }))
          : scoreAndSort(fragment, entries, (e) => ({ label: e.name })).map((r) => ({
              entry: r.item,
              labelMatches: r.labelMatches,
            }))
      return rows.slice(0, MAX_RESULTS).map(({ entry, labelMatches }) => ({
        // Append `/` to directories so they read as descendable, VSCode-style.
        label: entry.isDir ? `${entry.name}/` : entry.name,
        description: entry.path,
        labelMatches,
        descriptionMatches: [],
        // `entry.path` is already absolute — open it directly, never joined to
        // the workspace root. A directory descends by rewriting the query.
        onAccept: entry.isDir
          ? () => {
              setQuery(`${entry.path}/`)
              setSelectedIndex(0)
            }
          : () => accept(entry.path),
      }))
    }

    // Empty query: global recommendations — the most-used files across ALL
    // projects, by frecency. Absolute paths; in-workspace ones read relative, the
    // rest `~`-abbreviated + badged. Missing-on-disk paths are filtered out.
    // Scans a deeper buffer (HISTORY_SCAN) before filtering+capping — capping to
    // EMPTY_QUERY_TOP FIRST would under-fill the list whenever any of the top 15
    // ranked entries happen to be missing-on-disk, even though lower-ranked live
    // entries exist to backfill it.
    if (query === "") {
      if (!fileHistory) return []
      return fileHistory
        .top(HISTORY_SCAN)
        .filter((e) => !missingHistory.has(e.path))
        .slice(0, EMPTY_QUERY_TOP)
        .map((e) => ({
          label: basename(e.path),
          description: displayPath(e.path, workspaceRoot, home),
          badge: isInside(e.path, workspaceRoot) ? undefined : OUTSIDE_BADGE,
          labelMatches: [] as MatchRange[],
          descriptionMatches: [] as MatchRange[],
          onAccept: () => accept(e.path),
          onEvict: () => evict(e.path),
        }))
    }

    // Typed query: project fuzzy stays the PRIMARY list (`enumerateFiles` yields
    // workspace-relative paths — display relative, open absolute). A file also in
    // the history earns a bounded additive frecency boost, normalized to
    // 0..FRECENCY_BOOST_MAX (far below the fuzzy tier size), so favorites win ties
    // within a match tier without ever jumping tiers. The boost is gated to
    // label-tier matches (isLabelMatch) — a description-only match's score sits
    // just 1 point under the TIER_CONTAINS seam (fuzzy.ts), so an unconditional
    // boost could walk it past a weaker label match on a different file;
    // description-only matches keep their un-boosted clamp instead.
    const now = Date.now()
    const frecencyByPath = new Map<string, number>()
    let maxFrecency = 0
    if (fileHistory) {
      for (const e of fileHistory.top(HISTORY_SCAN, now)) {
        const f = fileHistory.frecency(e, now)
        frecencyByPath.set(e.path, f)
        if (f > maxFrecency) maxFrecency = f
      }
    }
    const boostFor = (absPath: string): number => {
      const f = frecencyByPath.get(absPath)
      if (f === undefined || maxFrecency <= 0) return 0
      return Math.round((f / maxFrecency) * FRECENCY_BOOST_MAX)
    }

    const projectScored = scoreAndSort(query, files, (f) => ({ label: basename(f), description: f }))
      .map((r) => ({ r, abs: join(workspaceRoot, r.item), boosted: 0 }))
      .map((x) => ({ ...x, boosted: isLabelMatch(x.r.score) ? x.r.score + boostFor(x.abs) : x.r.score }))
      .sort((a, b) => b.boosted - a.boosted)
      .slice(0, MAX_RESULTS)
    const projectAbs = new Set(projectScored.map((x) => x.abs))
    const projectItems: ResultItem[] = projectScored.map(({ r, abs }) => ({
      label: basename(r.item),
      description: r.item,
      labelMatches: r.labelMatches,
      descriptionMatches: r.descriptionMatches,
      onAccept: () => accept(abs),
    }))

    // History files OUTSIDE the workspace that fuzzy-match render as a compact,
    // badged group AFTER the project results — never above a same-name in-project
    // match — deduped by absolute path against the project list.
    let outsideItems: ResultItem[] = []
    if (fileHistory) {
      const outsideEntries = fileHistory
        .top(HISTORY_SCAN, now)
        .filter((e) => !isInside(e.path, workspaceRoot))
        .filter((e) => !missingHistory.has(e.path))
        .filter((e) => !projectAbs.has(e.path))
      outsideItems = scoreAndSort(query, outsideEntries, (e) => ({
        label: basename(e.path),
        description: displayPath(e.path, workspaceRoot, home),
      }))
        .slice(0, OUTSIDE_CAP)
        .map((r) => ({
          label: basename(r.item.path),
          description: displayPath(r.item.path, workspaceRoot, home),
          badge: OUTSIDE_BADGE,
          labelMatches: r.labelMatches,
          descriptionMatches: r.descriptionMatches,
          onAccept: () => accept(r.item.path),
          onEvict: () => evict(r.item.path),
        }))
    }

    return [...projectItems, ...outsideItems]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, query, files, commands, onGotoLine, workspaceRoot, home, dirListing, fileHistory, missingHistory, evictTick])

  useEffect(() => {
    setSelectedIndex((i) => {
      if (results.length === 0) return 0
      return Math.min(Math.max(0, i), results.length - 1)
    })
  }, [results.length])

  resultsRef.current = results

  useEffect(() => {
    const item = results[selectedIndex]
    if (item && scrollRef.current) scrollRef.current.scrollChildIntoView(`quick-${selectedIndex}`)
  }, [selectedIndex, results])

  useKeyboard((key) => {
    if (!visible) return
    switch (key.name) {
      case "return":
      case "enter": {
        results[selectedIndex]?.onAccept()
        break
      }
      case "escape":
        setVisible(false)
        break
    }
  })

  if (!visible) return null

  return (
    <box position="absolute" left="20%" width="60%" top={2} zIndex={100} flexDirection="column">
      <box
        flexDirection="column"
        width="100%"
        border
        borderColor={theme.border}
        backgroundColor={theme.sidebarBackground}
      >
        <input
          focused
          value={query}
          onInput={setQuery}
          placeholder="Go to file…"
          backgroundColor={theme.background}
          cursorStyle={CURSOR_STYLE}
        />
        <scrollbox ref={scrollRef} height={10}>
          {results.map((item, index) => (
            <box
              key={index}
              id={`quick-${index}`}
              width="100%"
              height={1}
              flexDirection="row"
              justifyContent="space-between"
              backgroundColor={index === selectedIndex ? theme.selectionBackground : undefined}
              onMouseDown={() => item.onAccept()}
            >
              <text fg={theme.foreground}>
                {highlight(item.label, item.labelMatches)}
                {item.description ? " " : ""}
                {item.description ? (
                  <span fg={theme.dimForeground}>{highlight(item.description, item.descriptionMatches)}</span>
                ) : null}
                {item.badge ? <span fg={theme.dimForeground}>{` ${item.badge}`}</span> : null}
              </text>
              {item.onEvict && index === selectedIndex ? (
                <box
                  onMouseDown={(event) => {
                    // stopPropagation so the ✕ evicts without the row's onAccept
                    // (which opens the file) also firing — OpenTUI mouse events
                    // bubble. preventDefault suppresses the text-selection gesture.
                    event.stopPropagation()
                    event.preventDefault()
                    item.onEvict?.()
                  }}
                >
                  <text fg={theme.dimForeground}> ✕</text>
                </box>
              ) : item.keybinding ? (
                <text fg={theme.dimForeground}>{item.keybinding}</text>
              ) : null}
            </box>
          ))}
        </scrollbox>
        {filesTruncated && isFileQuery(query) ? (
          <box height={1} paddingLeft={1} flexShrink={0}>
            <text fg={theme.warning}>Too many files — results are partial</text>
          </box>
        ) : null}
      </box>
    </box>
  )
}
