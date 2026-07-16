import type { InputRenderable, KeyEvent, Renderable } from "@opentui/core"
import type { Binding, Command } from "@opentui/keymap"
import { useKeyboard } from "@opentui/react"
import { useEffect, useId, useRef, useState } from "react"
import { CURSOR_STYLE, theme } from "../theme"
import { useCommands } from "../workbench/CommandsProvider"
import { useOverlay } from "../workbench/OverlayProvider"

export type TextInputDialogProps = {
  /** Prompt shown above the input, e.g. "Rename", "Move to", "New File", "New Folder". */
  title: string
  /** Pre-filled value; the input starts with this text SELECTED (so typing immediately
   *  replaces it) when non-empty, matching how VSCode's rename box behaves. */
  initialValue?: string
  /** Optional inline validation run on every keystroke; return an error string to show
   *  (and disable Confirm) or null when valid — e.g. "already exists" or "cannot be empty". */
  validate?: (value: string) => string | null
  onConfirm: (value: string) => void
  onCancel: () => void
}

/**
 * Modal single-line text-input overlay — VSCode's rename/new-file prompt. Shares
 * ConfirmDialog's scrim + centered bordered body so the two feel like one design
 * system. Enter confirms (unless `validate` currently reports an error, in which
 * case it's a no-op so an invalid value can't slip past the disabled Confirm),
 * Escape cancels. A modal keymap layer shadows base bindings (e.g. ctrl+q quit)
 * while open, popped on unmount to stay balanced on every teardown path. Stays
 * generic: it knows nothing about the filesystem — `validate` is the only hook a
 * caller uses to inject "already exists"/"cannot be empty" checks.
 */
export function TextInputDialog({
  title,
  initialValue = "",
  validate,
  onConfirm,
  onCancel,
}: TextInputDialogProps) {
  const commands = useCommands()
  const { setOverlayOpen } = useOverlay()
  const overlayId = useId()

  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<InputRenderable | null>(null)

  const error = validate ? validate(value) : null

  useEffect(() => {
    setOverlayOpen(overlayId, true)
    return () => setOverlayOpen(overlayId, false)
  }, [overlayId, setOverlayOpen])

  useEffect(() => {
    const layerCommands = [
      { name: "textInputDialog.block", run: () => {} },
    ] as unknown as Command<Renderable, KeyEvent>[]
    const bindings = [
      { key: "ctrl+q", cmd: "textInputDialog.block" },
    ] as unknown as Binding<Renderable, KeyEvent>[]
    return commands.pushLayer({ commands: layerCommands, bindings })
  }, [commands])

  // Focus the input and select the pre-filled text so the first keystroke
  // replaces it (VSCode rename behavior). The imperative focus + setSelection is
  // required because the `focused` prop alone won't pre-select the range.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    if (initialValue.length > 0) input.setSelection(0, initialValue.length)
  }, [initialValue])

  // Confirm against the input's LIVE buffer, not the React `value` state, which
  // can lag behind rapid keystrokes (each keystroke's onInput commits async, so a
  // fast type-then-Enter would otherwise confirm a truncated value). Re-run
  // `validate` on that live value so a stale-null `error` can't wave through an
  // invalid submit either.
  const confirm = () => {
    const current = inputRef.current?.value ?? value
    if (!validate || !validate(current)) onConfirm(current)
  }

  useKeyboard((key) => {
    if (key.name === "escape") {
      onCancel()
      return
    }
    if (key.name === "return" || key.name === "enter") confirm()
  })

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
        <text fg={theme.foreground}>{title}</text>
        <box height={1} />
        <input
          id="textInputDialog-input"
          ref={inputRef}
          focused
          value={value}
          onInput={setValue}
          width={40}
          backgroundColor={theme.background}
          cursorStyle={CURSOR_STYLE}
        />
        {error ? <text fg={theme.error}>{error}</text> : null}
        <box height={1} />
        <box flexDirection="row" justifyContent="center">
          <box
            id="textInputDialog-cancel"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.background}
            onMouseDown={onCancel}
          >
            <text fg={theme.foreground}>Cancel</text>
          </box>
          <box
            id="textInputDialog-confirm"
            marginLeft={2}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={error ? theme.background : theme.accent}
            onMouseDown={confirm}
          >
            <text fg={error ? theme.dimForeground : theme.accentForeground}>Confirm</text>
          </box>
        </box>
      </box>
    </box>
  )
}
