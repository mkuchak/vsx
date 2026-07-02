import type { KeyEvent, Renderable } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import type { Keymap } from "@opentui/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createContext, useContext, useMemo, type ReactNode } from "react"
import { CommandRegistry } from "../services/commands"

const CommandsContext = createContext<CommandRegistry<Renderable, KeyEvent> | null>(null)

export interface CommandsProviderProps {
  children?: ReactNode
}

/**
 * Boots the app-wide keymap + command registry and exposes both — our own
 * `useCommands` and keymap's `KeymapProvider` (so `useBindings`/`useActiveKeys`
 * keep working) share one instance.
 */
export function CommandsProvider({ children }: CommandsProviderProps) {
  const renderer = useRenderer()
  const keymap = useMemo<Keymap<Renderable, KeyEvent>>(() => createDefaultOpenTuiKeymap(renderer), [renderer])
  const registry = useMemo(() => new CommandRegistry(keymap), [keymap])

  return (
    <KeymapProvider keymap={keymap}>
      <CommandsContext.Provider value={registry}>{children}</CommandsContext.Provider>
    </KeymapProvider>
  )
}

export function useCommands(): CommandRegistry<Renderable, KeyEvent> {
  const registry = useContext(CommandsContext)
  if (!registry) throw new Error("useCommands must be used within a CommandsProvider")
  return registry
}
