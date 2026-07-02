import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { Binding, Command, KeyLike } from "@opentui/keymap"
import { useKeyboard } from "@opentui/react"
import { join, relative } from "node:path"
import type { ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { workbenchStore } from "../model/workbench"
import type { CommandInfo } from "../services/commands"
import { scoreAndSort, type MatchRange } from "../services/fuzzy"
import { enumerateFiles } from "../services/workspace"
import { theme } from "../theme"
import { useCommands } from "../workbench/CommandsProvider"
import { useOverlay } from "../workbench/OverlayProvider"

const MAX_RESULTS = 50
const MRU_CAP = 20

function basename(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

function capitalize(part: string): string {
  return part.length === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
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
  labelMatches: MatchRange[]
  descriptionMatches: MatchRange[]
  onAccept: () => void
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
}: {
  workspaceRoot: string
  onGotoLine?: (line: number, column?: number) => void
}) {
  const commands = useCommands()
  const { setOverlayOpen } = useOverlay()

  const [visible, setVisible] = useState(false)
  const [query, setQuery] = useState("")
  const [files, setFiles] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Self-contained "recently opened" MRU standing in for a real global one,
  // which does not exist yet. A future workbench-level MRU can replace this.
  // Stores ABSOLUTE paths (matching the document/tab invariant); the relative
  // display label is derived at render time.
  const mruRef = useRef<string[]>([])
  // What was active before opening — tracked for future MRU/focus-restore work.
  const restoreRef = useRef<string | null>(null)

  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  // Live mirror so the modal layer's Down command (registered once per open) can
  // clamp against the current result count without re-registering every render.
  const resultsRef = useRef<ResultItem[]>([])

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
        keybinding: "ctrl+p",
        run: () => openWith(""),
      }),
      commands.registerCommand({
        id: "workbench.showCommands",
        title: "Show All Commands",
        category: "Navigation",
        keybinding: "ctrl+shift+p",
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
      if (!cancelled) setFiles(res.files)
    })
    return () => {
      cancelled = true
    }
  }, [visible, workspaceRoot])

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
      { name: "quickInput.block", run: () => {} },
    ] as unknown as Command<Renderable, KeyEvent>[]
    const bindings = [
      { key: "up", cmd: "quickInput.up" },
      { key: "down", cmd: "quickInput.down" },
      { key: "ctrl+q", cmd: "quickInput.block" },
    ] as unknown as Binding<Renderable, KeyEvent>[]
    return commands.pushLayer({ commands: layerCommands, bindings })
  }, [visible, commands])

  // `absPath` MUST be absolute — tab paths and the document registry are keyed by
  // absolute path, so the same file never becomes two tabs/Documents.
  const accept = (absPath: string) => {
    workbenchStore.openFile(absPath, { preview: true })
    mruRef.current = [absPath, ...mruRef.current.filter((p) => p !== absPath)].slice(0, MRU_CAP)
    setVisible(false)
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

    if (query === "") {
      return mruRef.current.map((absPath) => ({
        label: basename(absPath),
        description: relative(workspaceRoot, absPath),
        labelMatches: [],
        descriptionMatches: [],
        onAccept: () => accept(absPath),
      }))
    }
    // `enumerateFiles` yields workspace-relative paths (git ls-files-relative); we
    // display the relative label but open the absolute path to keep the invariant.
    return scoreAndSort(query, files, (f) => ({ label: basename(f), description: f }))
      .slice(0, MAX_RESULTS)
      .map((r) => ({
        label: basename(r.item),
        description: r.item,
        labelMatches: r.labelMatches,
        descriptionMatches: r.descriptionMatches,
        onAccept: () => accept(join(workspaceRoot, r.item)),
      }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, query, files, commands, onGotoLine, workspaceRoot])

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
              </text>
              {item.keybinding ? <text fg={theme.dimForeground}>{item.keybinding}</text> : null}
            </box>
          ))}
        </scrollbox>
      </box>
    </box>
  )
}
