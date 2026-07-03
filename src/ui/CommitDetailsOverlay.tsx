import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { Binding, Command } from "@opentui/keymap"
import { useKeyboard } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import type { CommitInfo, CommitStats } from "../services/git"
import { theme } from "../theme"
import { useCommands } from "../workbench/CommandsProvider"
import { formatRelativeDate, parseRefs } from "./CommitLog"

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

/** An absolute, human timestamp like "Jul 2, 2026 14:30" (local time). */
function formatAbsoluteDate(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${hh}:${mm}`
}

export type CommitDetailsOverlayProps = {
  commit: CommitInfo
  /** Lazily fetched on open; resolves null if stats can't be computed. */
  fetchStats: () => Promise<CommitStats | null>
  onClose: () => void
  /** Injectable clock so the relative date is deterministic in tests. */
  now?: Date
}

/**
 * Full-viewport commit inspector — VSCode's commit hover, expanded. Modeled on
 * ConfirmDialog's overlay shape (absolute scrim, a pushed keymap layer blocking
 * base bindings, Escape closes) but its body is a `<scrollbox>` so long commit
 * messages scroll (up/down, page keys). The commit fields render instantly;
 * change stats fetch lazily and show "…" until they land.
 */
export function CommitDetailsOverlay({ commit, fetchStats, onClose, now }: CommitDetailsOverlayProps) {
  const commands = useCommands()
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const [stats, setStats] = useState<CommitStats | null | "loading">("loading")

  useEffect(() => {
    const layerCommands = [
      { name: "commitDetails.block", run: () => {} },
    ] as unknown as Command<Renderable, KeyEvent>[]
    const bindings = [
      { key: "ctrl+q", cmd: "commitDetails.block" },
    ] as unknown as Binding<Renderable, KeyEvent>[]
    return commands.pushLayer({ commands: layerCommands, bindings })
  }, [commands])

  useEffect(() => {
    let alive = true
    void fetchStats()
      .then((s) => {
        if (alive) setStats(s)
      })
      .catch(() => {
        if (alive) setStats(null)
      })
    return () => {
      alive = false
    }
  }, [fetchStats])

  useKeyboard((key) => {
    switch (key.name) {
      case "escape":
        onClose()
        break
      case "up":
        scrollRef.current?.scrollBy({ x: 0, y: -1 })
        break
      case "down":
        scrollRef.current?.scrollBy({ x: 0, y: 1 })
        break
      case "pageup":
        scrollRef.current?.scrollBy({ x: 0, y: -10 })
        break
      case "pagedown":
        scrollRef.current?.scrollBy({ x: 0, y: 10 })
        break
    }
  })

  const messageLines = commit.message.split("\n")
  const subject = messageLines[0] ?? ""
  const body = messageLines.slice(1).join("\n").replace(/^\n+/, "")
  const { badges } = parseRefs(commit.refs)

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      zIndex={200}
      backgroundColor="#000000"
      justifyContent="center"
      alignItems="center"
    >
      <box
        flexDirection="column"
        width="80%"
        maxWidth={100}
        height="70%"
        border
        borderColor={theme.border}
        backgroundColor={theme.sidebarBackground}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        {/* Only the message scrolls; the metadata + stats stay pinned below so
            they're visible no matter how long the body is. */}
        <scrollbox ref={scrollRef} flexGrow={1}>
          <text fg={theme.foreground}>{subject}</text>
          {body ? (
            <>
              <box height={1} />
              {body.split("\n").map((line, i) => (
                <text key={i} fg={theme.foreground}>{line}</text>
              ))}
            </>
          ) : null}
        </scrollbox>
        <box height={1} flexShrink={0} />
        {/* Each metadata line needs an explicit height={1} flexShrink={0} box:
            bare, consecutive <text> nodes here collapse to zero height and
            render on top of each other when the column is space-constrained. */}
        <box height={1} flexShrink={0}>
          <text fg={theme.dimForeground}>{`${commit.authorName} <${commit.authorEmail}>`}</text>
        </box>
        <box height={1} flexShrink={0}>
          <text fg={theme.dimForeground}>
            {`${formatAbsoluteDate(commit.authorDate)} (${formatRelativeDate(commit.authorDate, now)})`}
          </text>
        </box>
        {commit.commitDate.getTime() !== commit.authorDate.getTime() ? (
          // Rebased/amended commits have a later committer date; label it so the
          // two dates aren't confused. Hidden when they match (the common case).
          <box height={1} flexShrink={0}>
            <text fg={theme.dimForeground}>
              {`Committed ${formatAbsoluteDate(commit.commitDate)} (${formatRelativeDate(commit.commitDate, now)})`}
            </text>
          </box>
        ) : null}
        <box flexDirection="row" height={1} flexShrink={0}>
          <text fg={theme.dimForeground}>{`commit ${commit.hash.slice(0, 7)}`}</text>
          {commit.parents.length > 0 ? (
            <text fg={theme.dimForeground}>
              {`  parent${commit.parents.length > 1 ? "s" : ""} ${commit.parents.map((p) => p.slice(0, 7)).join(" ")}`}
            </text>
          ) : null}
        </box>
        {badges.length > 0 ? (
          <box flexDirection="row" height={1} flexShrink={0}>
            {badges.map((b) => (
              <text key={b} fg={theme.info}>{`[${b}] `}</text>
            ))}
          </box>
        ) : null}
        <box flexDirection="row" height={1} flexShrink={0}>
          {stats === "loading" ? (
            <text fg={theme.dimForeground}>…</text>
          ) : stats === null ? (
            <text fg={theme.dimForeground}>—</text>
          ) : (
            <>
              <text fg={theme.dimForeground}>
                {`${stats.files} file${stats.files === 1 ? "" : "s"} changed, `}
              </text>
              <text fg={theme.diffAddedSign}>{`+${stats.insertions}`}</text>
              <text fg={theme.dimForeground}> </text>
              <text fg={theme.diffRemovedSign}>{`−${stats.deletions}`}</text>
            </>
          )}
        </box>
        <box height={1} flexShrink={0} />
        <text fg={theme.dimForeground}>Esc to close · ↑↓ to scroll</text>
      </box>
    </box>
  )
}
