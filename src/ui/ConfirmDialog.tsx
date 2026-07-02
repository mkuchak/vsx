import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding, Command } from "@opentui/keymap"
import { useKeyboard } from "@opentui/react"
import { useEffect, useState } from "react"
import { theme } from "../theme"
import { useCommands } from "../workbench/CommandsProvider"

export type ConfirmButton = {
  /** Stable identifier returned when this button is chosen. */
  id: string
  label: string
  isDefault?: boolean
}

export type ConfirmDialogProps = {
  message: string
  detail?: string
  /** 2 or 3 choices (e.g. Cancel/Confirm, or Save/Don't Save/Cancel). */
  buttons: ConfirmButton[]
  onSelect: (id: string) => void
  onCancel: () => void
}

/**
 * Modal confirmation overlay — VSCode's discard-confirmation ladder. Rendered by
 * the root-level ModalProvider so its scrim and centered body span the whole
 * viewport, not any single panel. Left/Right (or Tab/Shift+Tab) move the
 * highlighted button, Enter confirms it, Escape cancels. A modal keymap layer is
 * pushed while open so base bindings (e.g. ctrl+q quit) can't leak through; it's
 * popped on unmount via the effect cleanup, keeping push/pop balanced on every
 * resolution path (select, cancel, Esc, or teardown while still open).
 */
export function ConfirmDialog({ message, detail, buttons, onSelect, onCancel }: ConfirmDialogProps) {
  const commands = useCommands()

  const [highlight, setHighlight] = useState(() => {
    const i = buttons.findIndex((b) => b.isDefault)
    return i === -1 ? 0 : i
  })

  useEffect(() => {
    const layerCommands = [
      { name: "confirmDialog.block", run: () => {} },
    ] as unknown as Command<Renderable, KeyEvent>[]
    const bindings = [
      { key: "ctrl+q", cmd: "confirmDialog.block" },
    ] as unknown as Binding<Renderable, KeyEvent>[]
    return commands.pushLayer({ commands: layerCommands, bindings })
  }, [commands])

  useKeyboard((key) => {
    switch (key.name) {
      case "left":
        setHighlight((i) => Math.max(0, i - 1))
        break
      case "right":
        setHighlight((i) => Math.min(buttons.length - 1, i + 1))
        break
      case "tab":
        setHighlight((i) =>
          key.shift
            ? (i - 1 + buttons.length) % buttons.length
            : (i + 1) % buttons.length,
        )
        break
      case "return":
      case "enter": {
        const button = buttons[highlight]
        if (button) onSelect(button.id)
        break
      }
      case "escape":
        onCancel()
        break
    }
  })

  const lines = message.split("\n")

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
        border
        borderColor={theme.border}
        backgroundColor={theme.sidebarBackground}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        {lines.map((line, i) => (
          <text key={i} fg={theme.foreground}>
            {line}
          </text>
        ))}
        {detail ? <text fg={theme.dimForeground}>{detail}</text> : null}
        <box height={1} />
        <box flexDirection="row" justifyContent="center">
          {buttons.map((button, i) => (
            <box
              key={button.id}
              marginLeft={i === 0 ? 0 : 2}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={i === highlight ? theme.accent : theme.background}
              onMouseDown={() => onSelect(button.id)}
            >
              <text fg={i === highlight ? theme.accentForeground : theme.foreground}>
                {button.label}
              </text>
            </box>
          ))}
        </box>
      </box>
    </box>
  )
}
