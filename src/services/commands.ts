import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding, Command, Keymap, KeyLike, KeymapEvent } from "@opentui/keymap"

/**
 * A named, dispatchable action — vsx's clone of VSCode's command model. Every
 * keybinding, palette entry, and UI button routes through one of these.
 */
export interface CommandDescriptor {
  id: string
  title: string
  category?: string
  /** Key chord (e.g. "ctrl+p") or stroke object bound to this command. */
  keybinding?: KeyLike
  /** VSCode `when`-style predicate; a falsy result blocks key + programmatic dispatch. */
  enabled?: () => boolean
  run: () => void
}

/** Projection consumed by the future command palette. */
export interface CommandInfo {
  id: string
  title: string
  category?: string
  keybinding?: KeyLike
  /** Position in the most-recently-used list; 0 = most recent, undefined = never used. */
  recency?: number
}

/** A modal (palette/dialog) layer that shadows base bindings until disposed. */
export interface CommandLayerSpec<T extends object = Renderable, E extends KeymapEvent = KeyEvent> {
  commands?: readonly Command<T, E>[]
  bindings?: readonly Binding<T, E>[]
}

/**
 * Wraps an @opentui/keymap instance so the whole app dispatches through a
 * single command table. Commands own their metadata + MRU here; the keymap owns
 * key resolution and `enabled` gating. Modal layers push on top and pop cleanly.
 */
export class CommandRegistry<T extends object = Renderable, E extends KeymapEvent = KeyEvent> {
  readonly #keymap: Keymap<T, E>
  readonly #descriptors = new Map<string, CommandDescriptor>()
  /** Registration order, so unused commands list stably. */
  readonly #order: string[] = []
  /** Most-recently-used ids, most recent first. */
  readonly #mru: string[] = []
  /** Highest priority currently handed to a pushed modal layer. */
  #layerPriority = 0
  /** Consulted before every keybinding/`executeCommand` dispatch; falsy blocks it. */
  #dispatchGate?: (commandId: string) => boolean
  /** Set while an `executeCommand({ bypassGate })` call is in flight. */
  #bypassGate = false

  constructor(keymap: Keymap<T, E>) {
    this.#keymap = keymap
  }

  get keymap(): Keymap<T, E> {
    return this.#keymap
  }

  /**
   * Install a predicate consulted before ANY command dispatched by a keybinding
   * or {@link executeCommand} runs; a falsy result makes the dispatch a silent
   * no-op. Pass `undefined` to remove the gate. Used to suppress base commands
   * while a modal overlay owns the screen.
   */
  setDispatchGate(fn: ((commandId: string) => boolean) | undefined): void {
    this.#dispatchGate = fn
  }

  registerCommand(descriptor: CommandDescriptor): () => void {
    const { id, title, category, keybinding, enabled } = descriptor
    // Duplicate ids are a bug (usually a command registered per-instance in a
    // component that mounts more than once, e.g. an editor pane under a split).
    // We don't throw — a last-wins re-registration must stay possible — but we
    // warn so the mistake is loud, and the disposer below is identity-safe so a
    // stale unmount can't strip the surviving registration.
    if (this.#descriptors.has(id)) {
      console.warn(`CommandRegistry: duplicate registration for command id "${id}" (last-wins)`)
    }
    this.#descriptors.set(id, descriptor)
    if (!this.#order.includes(id)) this.#order.push(id)

    const command = {
      name: id,
      title,
      category,
      enabled,
      run: () => {
        if (!this.#bypassGate && this.#dispatchGate && !this.#dispatchGate(id)) return
        this.recordUsage(id)
        descriptor.run()
      },
    } as unknown as Command<T, E>

    const bindings = keybinding ? [{ key: keybinding, cmd: id } as Binding<T, E>] : []
    const disposeLayer = this.#keymap.registerLayer({ commands: [command], bindings })

    return () => {
      disposeLayer()
      // Only tear down the shared metadata if THIS registration still owns the
      // id. If a duplicate re-registered over us (last-wins), its descriptor is
      // now stored here and must survive our unmount — otherwise disposing one
      // of two duplicates would drop the command from the palette entirely.
      if (this.#descriptors.get(id) !== descriptor) return
      this.#descriptors.delete(id)
      remove(this.#order, id)
      remove(this.#mru, id)
    }
  }

  /**
   * Run a command by id (respects `enabled`); returns whether it executed. Pass
   * `bypassGate` to skip the dispatch gate — used by the command palette, which
   * runs a chosen command after requesting its own close but before that close
   * has flushed through the overlay signal the gate reads.
   */
  executeCommand(id: string, opts?: { bypassGate?: boolean }): boolean {
    if (!opts?.bypassGate) {
      if (this.#dispatchGate && !this.#dispatchGate(id)) return false
      return this.#keymap.dispatchCommand(id).ok
    }
    this.#bypassGate = true
    try {
      return this.#keymap.dispatchCommand(id).ok
    } finally {
      this.#bypassGate = false
    }
  }

  recordUsage(id: string): void {
    if (!this.#descriptors.has(id)) return
    remove(this.#mru, id)
    this.#mru.unshift(id)
  }

  /** Palette-facing snapshot: MRU commands first, then the rest in registration order. */
  getCommands(): CommandInfo[] {
    const ordered = [...this.#mru, ...this.#order.filter((id) => !this.#mru.includes(id))]
    return ordered.map((id) => {
      const d = this.#descriptors.get(id)!
      const recency = this.#mru.indexOf(id)
      return {
        id,
        title: d.title,
        category: d.category,
        keybinding: d.keybinding,
        recency: recency === -1 ? undefined : recency,
      }
    })
  }

  /**
   * Push a modal layer whose bindings/commands shadow the base table. Returns a
   * disposer that pops it — call on modal close.
   */
  pushLayer(spec: CommandLayerSpec<T, E>): () => void {
    const priority = ++this.#layerPriority
    const dispose = this.#keymap.registerLayer({
      priority,
      commands: spec.commands ? [...spec.commands] : [],
      bindings: spec.bindings ? [...spec.bindings] : [],
    })
    return () => {
      dispose()
      if (this.#layerPriority === priority) this.#layerPriority--
    }
  }
}

function remove(list: string[], value: string): void {
  const i = list.indexOf(value)
  if (i !== -1) list.splice(i, 1)
}
