import { MouseButton } from "@opentui/core"
import type {
  BoxRenderable,
  KeyEvent,
  MouseEvent as TuiMouseEvent,
  Renderable,
} from "@opentui/core"
import type { Binding, Command } from "@opentui/keymap"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { theme } from "../theme"
import { useCommands } from "../workbench/CommandsProvider"
import { useOverlay } from "../workbench/OverlayProvider"

export type ContextMenuItem = {
  id: string
  label: string
  /** Rendered as a thin divider line above this item instead of a real row, when true;
   *  `label`/`onSelect` are ignored for a divider entry. */
  isDivider?: boolean
  onSelect?: () => void
  /** Dim/disable this item (e.g. "Move" while a rename is somehow already in flight) —
   *  render dimmed and make it inert to clicks/Enter, still visible for discoverability. */
  disabled?: boolean
}

export type ContextMenuProps = {
  /** Anchor point — typically the triggering MouseEvent's x/y (cell coordinates). */
  x: number
  y: number
  items: ContextMenuItem[]
  onDismiss: () => void
}

// Border (1 cell each side) plus one column of horizontal padding each side.
const HORIZONTAL_CHROME = 4
// Border adds one row top and bottom.
const VERTICAL_CHROME = 2

function isSelectable(item: ContextMenuItem | undefined): boolean {
  return !!item && !item.isDivider && !item.disabled
}

/**
 * Generic anchored popup menu — the missing "positioned overlay" building block
 * (every other overlay in this app is screen-centered or fixed-offset). It knows
 * nothing about the file tree; callers pass their own {@link ContextMenuItem}s.
 *
 * Registers as an overlay so global keyboard consumers (e.g. FileTree's arrow-key
 * navigation, which gates on `isOverlayOpen`) suspend while it's open, and pushes
 * a modal keymap layer so base bindings can't leak through underneath.
 *
 * Click-away is handled by a listener on the renderer's ROOT renderable, NOT a
 * full-screen backdrop box. OpenTUI hit-tests a click to exactly one topmost
 * renderable and bubbles it up only that renderable's own ancestor chain (see
 * dragManager.ts) — so a full-screen backdrop on top would swallow EVERY outside
 * click, including a right-click meant to open a fresh menu on a different row
 * (that row's own handler would never fire, forcing a two-click switch). By
 * leaving nothing on top and instead catching the bubbled event at the root: a
 * LEFT click outside the menu dismisses it (classic click-away), while a RIGHT
 * click outside is deliberately ignored here so the row underneath receives it
 * and REPLACES the menu in a single gesture. The menu box also takes native
 * focus on mount (OpenTUI focus is singular) so a keystroke can't leak into a
 * still-focused editor textarea; focus is restored to the prior pane by the
 * shared overlay-close-epoch mechanism when the menu unmounts.
 */
export function ContextMenu({ x, y, items, onDismiss }: ContextMenuProps) {
  const commands = useCommands()
  const renderer = useRenderer()
  const { setOverlayOpen } = useOverlay()
  const { width: termWidth, height: termHeight } = useTerminalDimensions()

  const [highlight, setHighlight] = useState(() => items.findIndex(isSelectable))
  const [hovered, setHovered] = useState(-1)
  const menuBoxRef = useRef<BoxRenderable | null>(null)

  useEffect(() => {
    setOverlayOpen("contextMenu", true)
    return () => setOverlayOpen("contextMenu", false)
  }, [setOverlayOpen])

  useEffect(() => {
    const layerCommands = [
      { name: "contextMenu.block", run: () => {} },
    ] as unknown as Command<Renderable, KeyEvent>[]
    const bindings = [
      { key: "ctrl+q", cmd: "contextMenu.block" },
    ] as unknown as Binding<Renderable, KeyEvent>[]
    return commands.pushLayer({ commands: layerCommands, bindings })
  }, [commands])

  const moveHighlight = (dir: 1 | -1) => {
    setHighlight((current) => {
      let i = current
      for (let step = 0; step < items.length; step++) {
        i = i + dir
        if (i < 0) i = items.length - 1
        if (i >= items.length) i = 0
        if (isSelectable(items[i])) return i
      }
      return current
    })
  }

  const selectAt = (index: number) => {
    const item = items[index]
    if (!isSelectable(item)) return
    item?.onSelect?.()
    onDismiss()
  }

  useKeyboard((key) => {
    switch (key.name) {
      case "up":
        moveHighlight(-1)
        break
      case "down":
        moveHighlight(1)
        break
      case "return":
      case "enter":
        selectAt(highlight)
        break
      case "escape":
        onDismiss()
        break
    }
  })

  const longestLabel = items.reduce(
    (max, item) => (item.isDivider ? max : Math.max(max, item.label.length)),
    0,
  )
  const menuWidth = longestLabel + HORIZONTAL_CHROME
  const menuHeight = items.length + VERTICAL_CHROME
  const contentWidth = menuWidth - HORIZONTAL_CHROME

  // Clamp so the menu's far edge never spills past the screen; prefer anchoring at
  // x/y but shift back toward the origin when that would overflow.
  const left = Math.max(0, Math.min(x, termWidth - menuWidth))
  const top = Math.max(0, Math.min(y, termHeight - menuHeight))

  // Kept in refs so the root listener — installed once on mount — always reads the
  // CURRENT anchor/dismiss without reinstalling every time the menu re-anchors to
  // a new target (the single-gesture right-click-replace path re-renders in place).
  const boundsRef = useRef({ left, top, width: menuWidth, height: menuHeight })
  boundsRef.current = { left, top, width: menuWidth, height: menuHeight }
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    // Take native focus so a printable keystroke can't reach a still-focused
    // editor textarea underneath (focus is restored on unmount by the shared
    // overlay-close-epoch mechanism the panes already watch).
    menuBoxRef.current?.focus()

    // Catch outside clicks at the root: every hit-tested renderable bubbles its
    // event up to here (root.parent is null), so this fires for a click anywhere
    // without occupying screen space and blocking the row underneath.
    const root = renderer.root
    const onRootMouseDown = (event: TuiMouseEvent) => {
      const b = boundsRef.current
      const inside =
        event.x >= b.left &&
        event.x < b.left + b.width &&
        event.y >= b.top &&
        event.y < b.top + b.height
      if (inside) return
      // LEFT outside = dismiss. RIGHT outside is left for the row underneath to
      // open a fresh menu in the same gesture, so we must NOT dismiss it here.
      if (event.button === MouseButton.LEFT) dismissRef.current()
    }
    root.onMouseDown = onRootMouseDown
    return () => {
      root.onMouseDown = undefined
    }
  }, [renderer])

  return (
    <box
      id="contextMenu-box"
      ref={menuBoxRef}
      focusable
      position="absolute"
      left={left}
      top={top}
      width={menuWidth}
      zIndex={200}
      flexDirection="column"
      border
      borderColor={theme.border}
      backgroundColor={theme.sidebarBackground}
    >
      {items.map((item, i) => {
        if (item.isDivider) {
          return (
            <text key={item.id} fg={theme.border}>
              {"─".repeat(contentWidth)}
            </text>
          )
        }
        const background =
          i === highlight
            ? theme.selectionBackground
            : i === hovered
              ? theme.hoverBackground
              : undefined
        return (
          <box
            key={item.id}
            id={`contextMenu-item-${item.id}`}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={background}
            onMouseDown={item.disabled ? undefined : () => selectAt(i)}
            onMouseOver={item.disabled ? undefined : () => setHovered(i)}
            onMouseOut={() => setHovered((h) => (h === i ? -1 : h))}
          >
            <text fg={item.disabled ? theme.dimForeground : theme.foreground}>
              {item.label}
            </text>
          </box>
        )
      })}
    </box>
  )
}
