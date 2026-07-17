import { useKeyboard } from "@opentui/react"
import { MouseButton } from "@opentui/core"
import type { MouseEvent as TuiMouseEvent, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { dirname, join, relative, sep } from "node:path"
import { workbenchStore } from "../model/workbench"
import { theme } from "../theme"
import { listDir, createDirWatcher, type DirEntry, type DirWatcher } from "../services/workspace"
import { useOverlay } from "../workbench/OverlayProvider"
import { useWorkbenchStore } from "../workbench/useWorkbenchStore"
import { LONG_PRESS_MS, scheduleLongPress } from "./longPressTimer"

export type FileTreeProps = {
  root: string
  focused: boolean
  onOpenFile: (path: string, opts: { preview: boolean }) => void
  height?: number | `${number}%` | "auto"
  /**
   * Bump `token` to (re-)request revealing `path`: every ancestor directory expands,
   * its listing loads, and the row for `path` is selected + scrolled into view once
   * all ancestors are loaded. A `token` (not just `path`) is required so clicking the
   * SAME path twice in a row still re-triggers the reveal (e.g. the user navigated
   * the tree away from that row between clicks) — a plain path-equality check on
   * props would not re-fire for an unchanged path. `null` is a no-op.
   */
  revealRequest?: { path: string; token: number } | null
  /**
   * Fired on a right-click of a row: selects the row (like a left-click would)
   * but does NOT open/expand/collapse it, and reports the row's target plus the
   * click's absolute screen coordinates so a caller can anchor a context menu
   * there. `x`/`y` are passed through from the mouse event unmodified.
   */
  onContextMenuRequest?: (
    target: { path: string; name: string; isDir: boolean },
    x: number,
    y: number,
  ) => void
}

type Row = {
  id: string
  path: string
  name: string
  depth: number
  isDir: boolean
  isExpanded: boolean
  isLoading: boolean
}

// Depth-first search for the descendant renderable whose `id` matches, used to
// find a tree row's on-screen cell so the keyboard-triggered menu can anchor
// there. Row boxes live inside the scrollbox's content renderable, not as direct
// children, so the walk must recurse.
function findRenderableById(node: Renderable, id: string): Renderable | null {
  if (node.id === id) return node
  for (const child of node.getChildren()) {
    const found = findRenderableById(child, id)
    if (found) return found
  }
  return null
}

function buildRows(
  root: string,
  expanded: ReadonlySet<string>,
  cache: ReadonlyMap<string, DirEntry[]>,
  loading: ReadonlySet<string>,
): Row[] {
  const rows: Row[] = []
  const walk = (dirPath: string, depth: number) => {
    const entries = cache.get(dirPath)
    if (entries === undefined) {
      if (loading.has(dirPath)) {
        rows.push({
          id: `${dirPath} loading`,
          path: dirPath,
          name: "loading…",
          depth,
          isDir: false,
          isExpanded: false,
          isLoading: true,
        })
      }
      return
    }
    for (const entry of entries) {
      const isExpanded = entry.isDir && expanded.has(entry.path)
      rows.push({
        id: entry.path,
        path: entry.path,
        name: entry.name,
        depth,
        isDir: entry.isDir,
        isExpanded,
        isLoading: false,
      })
      if (isExpanded) walk(entry.path, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

export function FileTree({
  root,
  focused,
  onOpenFile,
  height = "100%",
  revealRequest,
  onContextMenuRequest,
}: FileTreeProps) {
  const { isOverlayOpen } = useOverlay()
  // Lifted into the workbench store (not local state) so it survives FileTree
  // being unmounted — which happens both when the sidebar is hidden and when
  // the user switches to a different sidebar tab and back.
  const { explorerExpandedPaths: expanded } = useWorkbenchStore()
  const [cache, setCache] = useState<Map<string, DirEntry[]>>(() => new Map())
  const [loading, setLoading] = useState<Set<string>>(() => new Set())
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Guards a directory against being fetched more than once. Membership means
  // "already requested" (in-flight or loaded); cleared on error or explicit refresh.
  const requestedRef = useRef<Set<string>>(new Set())
  const cacheRef = useRef(cache)
  cacheRef.current = cache
  const watcherRef = useRef<DirWatcher | null>(null)

  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  const load = useCallback((dirPath: string) => {
    if (requestedRef.current.has(dirPath)) return
    requestedRef.current.add(dirPath)
    // Watch this dir the moment we request its listing, not on success: a
    // change landing between readdir returning and the watch being installed
    // would otherwise go unobserved. `add` is idempotent, so re-requests (e.g.
    // refresh) don't stack watches.
    watcherRef.current?.add(dirPath)
    setLoading((prev) => new Set(prev).add(dirPath))
    listDir(dirPath)
      .then((entries) => {
        setCache((prev) => new Map(prev).set(dirPath, entries))
      })
      .catch(() => {
        requestedRef.current.delete(dirPath)
      })
      .finally(() => {
        setLoading((prev) => {
          const next = new Set(prev)
          next.delete(dirPath)
          return next
        })
      })
  }, [])

  const refresh = useCallback(
    (dirPath: string) => {
      requestedRef.current.delete(dirPath)
      load(dirPath)
    },
    [load],
  )

  // One non-recursive fs.watch per directory the tree has actually listed
  // (installed by load()), instead of a single recursive watch on the root.
  // A recursive watch on a large root (e.g. $HOME) blocks the event loop for
  // tens of seconds and exhausts the inotify budget under Bun/Linux; since the
  // tree only ever refreshes dirs it has already listed, watching exactly those
  // is both sufficient and O(visible dirs). Declared before the load effect so
  // watcherRef is set before load(root) fires on mount; keyed on root so a root
  // change tears the watches down and the load effect below re-adds them.
  useEffect(() => {
    const watcher = createDirWatcher((changes) => {
      const dirty = new Set<string>()
      for (const change of changes) {
        const parent = dirname(change.path)
        if (cacheRef.current.has(parent)) dirty.add(parent)
      }
      for (const dir of dirty) refresh(dir)
    })
    watcherRef.current = watcher
    return () => {
      watcher.dispose()
      watcherRef.current = null
    }
  }, [root, refresh])

  useEffect(() => {
    load(root)
    // `cache`/`loading` stay local state (unlike `expanded`), so a directory
    // that was already marked expanded before this mount — e.g. the sidebar was
    // hidden and re-shown — has no cached children yet. Without this, buildRows
    // would see isExpanded=true but no cache entry and render nothing under it.
    // Read the store directly (not the reactive `expanded` above) so this only
    // fires once per mount, not on every later expand/collapse.
    for (const dirPath of workbenchStore.getState().explorerExpandedPaths) load(dirPath)
  }, [root, load])

  const rows = useMemo(
    () => buildRows(root, expanded, cache, loading),
    [root, expanded, cache, loading],
  )

  useEffect(() => {
    setSelectedIndex((i) => {
      if (rows.length === 0) return 0
      return Math.min(Math.max(0, i), rows.length - 1)
    })
  }, [rows.length])

  useEffect(() => {
    const row = rows[selectedIndex]
    if (row && scrollRef.current) scrollRef.current.scrollChildIntoView(row.id)
  }, [selectedIndex, rows])

  const expand = useCallback(
    (dirPath: string) => {
      workbenchStore.expandExplorerPath(dirPath)
      load(dirPath)
    },
    [load],
  )

  // Marks the last reveal token that has been fully satisfied (row selected), so
  // later cache/rows updates don't re-select and fight the user's navigation.
  const revealedTokenRef = useRef<number | null>(null)
  useEffect(() => {
    if (!revealRequest) return
    const { path, token } = revealRequest
    if (revealedTokenRef.current === token) return

    // Ancestor directories that must expand for `path` to become visible:
    // every dir strictly between root and dirname(path), inclusive of both
    // ends. `relative` keeps this robust against separator/normalisation quirks
    // instead of slicing the string by hand.
    const rel = relative(root, dirname(path))
    const segments = rel === "" || rel.startsWith("..") ? [] : rel.split(sep)
    const ancestorDirs: string[] = []
    let cur = root
    for (const segment of segments) {
      cur = join(cur, segment)
      ancestorDirs.push(cur)
    }

    for (const dir of ancestorDirs) {
      if (!expanded.has(dir)) expand(dir)
    }

    // The reveal can't finish until every ancestor listing has arrived (each
    // load resolves asynchronously); this effect re-runs on `cache` so it
    // retries as later levels land. root is always loaded on mount but is
    // included for correctness.
    const needsLoaded = [root, ...ancestorDirs]
    if (!needsLoaded.every((dir) => cache.has(dir))) return

    const index = rows.findIndex((r) => r.path === path)
    if (index < 0) return
    revealedTokenRef.current = token
    setSelectedIndex(index)
  }, [revealRequest, expanded, cache, rows, root, expand])

  const collapse = useCallback((dirPath: string) => {
    workbenchStore.collapseExplorerPath(dirPath)
  }, [])

  const activateRow = useCallback(
    (row: Row) => {
      if (row.isLoading) return
      if (row.isDir) {
        if (row.isExpanded) collapse(row.path)
        else expand(row.path)
      } else {
        onOpenFile(row.path, { preview: true })
      }
    },
    [collapse, expand, onOpenFile],
  )

  // A left press that hasn't yet resolved into an activation or a long-press:
  // the row it landed on plus the press coordinates, captured so a long-press
  // fire can anchor the menu exactly where the button went down. `activated`
  // records whether this press already opened its row on the DOWN (down-mode).
  const pendingPressRef = useRef<{ index: number; x: number; y: number; activated: boolean } | null>(null)
  const pressTimerCancelRef = useRef<(() => void) | null>(null)

  // Adaptive activation latch. Starts false (down-mode: rows activate on
  // mouse-DOWN) and flips true forever the first time ANY release is seen
  // (up-mode: the designed activate-on-UP so long-press can pre-empt). Some
  // terminals/muxes (VS Code integrated terminal + herdr) forward PRESS but
  // silently drop RELEASE — there the up never arrives, so we permanently stay
  // in down-mode and clicks keep working (degraded: long-press still fires over
  // the already-done activation). A ref, not state: switching modes must not
  // re-render, and per-mount scope is fine — a remount re-learns within one
  // click and tests stay isolated with no global reset plumbing.
  const releaseSeenRef = useRef(false)

  const cancelPress = useCallback(() => {
    pressTimerCancelRef.current?.()
    pressTimerCancelRef.current = null
    pendingPressRef.current = null
  }, [])

  // Clear a still-armed long-press timer if the component unmounts mid-press.
  useEffect(() => cancelPress, [cancelPress])

  const handleRowMouseDown = useCallback(
    (event: TuiMouseEvent, row: Row, index: number) => {
      if (event.button === MouseButton.RIGHT) {
        // Select the row but don't open/expand/collapse it; hand off to the
        // context-menu caller with the click coordinates.
        setSelectedIndex(index)
        onContextMenuRequest?.(
          { path: row.path, name: row.name, isDir: row.isDir },
          event.x,
          event.y,
        )
        return
      }
      // Left press: select immediately for instant feedback. In up-mode we
      // defer opening to mouse-up so a long-press can raise the context menu
      // instead; in down-mode (no release ever observed) we activate right here
      // so release-dropping environments stay usable, and still arm the
      // long-press so the menu also works there. `activated` tells the up-handler
      // this press already fired, so a late release won't double-activate.
      setSelectedIndex(index)
      cancelPress()
      const activated = releaseSeenRef.current === false
      if (activated) activateRow(row)
      pendingPressRef.current = { index, x: event.x, y: event.y, activated }
      pressTimerCancelRef.current = scheduleLongPress(() => {
        const pending = pendingPressRef.current
        if (!pending) return
        pendingPressRef.current = null
        pressTimerCancelRef.current = null
        onContextMenuRequest?.(
          { path: row.path, name: row.name, isDir: row.isDir },
          pending.x,
          pending.y,
        )
      }, LONG_PRESS_MS)
    },
    [activateRow, cancelPress, onContextMenuRequest],
  )

  const handleRowMouseUp = useCallback(
    (row: Row, index: number) => {
      // Any delivered release — on any row, whether or not a press is pending —
      // proves this environment forwards mouse-up, so switch to up-activation
      // for good. Must run before the pending checks below.
      releaseSeenRef.current = true
      const pending = pendingPressRef.current
      if (!pending) return // long-press already fired, or the press was cancelled
      cancelPress()
      // Only a press+release on the SAME row is a click; releasing elsewhere
      // (after moving off the row) is not.
      if (pending.index !== index) return
      // Transition click: the very first click of a healthy session pressed in
      // down-mode (already activated) but its up arrives here — do NOT activate
      // again, or a folder would expand then instantly collapse.
      if (pending.activated) return
      activateRow(row)
    },
    [activateRow, cancelPress],
  )

  useKeyboard((key) => {
    if (!focused || isOverlayOpen) return
    const row = rows[selectedIndex]

    // Keyboard trigger for the context menu (`m`, lazygit-style; Shift+F10 as an
    // alias) anchored at the selected row. Right-click never reaches vsx in some
    // terminals/multiplexers (e.g. VS Code's integrated terminal, herdr), so a
    // key trigger is the only one that survives every environment.
    if ((key.name === "m" && !key.ctrl && !key.meta && !key.shift) || (key.name === "f10" && key.shift)) {
      if (!row || row.isLoading) return
      const scrollbox = scrollRef.current
      if (!scrollbox) return
      // Anchor past the expand glyph and just below the row, matching VS Code.
      // scrollChildIntoView keeps the selected row mounted+visible, so the
      // findRenderableById fallback to the scrollbox itself is only a safety net.
      const rowRenderable = findRenderableById(scrollbox, row.id)
      const anchor = rowRenderable ?? scrollbox
      onContextMenuRequest?.(
        { path: row.path, name: row.name, isDir: row.isDir },
        anchor.x + 2,
        anchor.y + 1,
      )
      return
    }

    switch (key.name) {
      case "up":
        setSelectedIndex((i) => Math.max(0, i - 1))
        break
      case "down":
        setSelectedIndex((i) => Math.min(rows.length - 1, i + 1))
        break
      case "right":
        if (!row || row.isLoading) break
        if (row.isDir) {
          if (row.isExpanded) setSelectedIndex((i) => Math.min(rows.length - 1, i + 1))
          else expand(row.path)
        } else {
          onOpenFile(row.path, { preview: true })
        }
        break
      case "return":
      case "enter":
        if (!row || row.isLoading) break
        if (row.isDir) {
          if (row.isExpanded) collapse(row.path)
          else expand(row.path)
        } else {
          onOpenFile(row.path, { preview: true })
        }
        break
      case "left": {
        if (!row) break
        if (row.isDir && row.isExpanded) {
          collapse(row.path)
        } else {
          const parent = dirname(row.path)
          const parentIndex = rows.findIndex((r) => r.path === parent)
          if (parentIndex >= 0) setSelectedIndex(parentIndex)
        }
        break
      }
    }
  })

  return (
    <box flexDirection="column" height={height}>
      <scrollbox ref={scrollRef} flexGrow={1}>
        {rows.map((row, index) => {
          const indent = " ".repeat(row.depth * 2)
          const prefix = row.isLoading ? "  " : row.isDir ? (row.isExpanded ? "▾ " : "▸ ") : "  "
          return (
            <box
              key={row.id}
              id={row.id}
              width="100%"
              height={1}
              backgroundColor={index === selectedIndex ? theme.selectionBackground : undefined}
              onMouseDown={(event: TuiMouseEvent) => handleRowMouseDown(event, row, index)}
              onMouseUp={() => handleRowMouseUp(row, index)}
              onMouseDrag={cancelPress}
              onMouseOut={cancelPress}
              onMouseScroll={cancelPress}
            >
              <text fg={row.isLoading ? theme.dimForeground : theme.foreground}>
                {indent}
                {prefix}
                {row.name}
              </text>
            </box>
          )
        })}
      </scrollbox>
    </box>
  )
}
