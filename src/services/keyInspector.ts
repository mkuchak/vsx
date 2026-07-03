import type { KeyEvent } from "@opentui/core"

/**
 * Minimal keypress event surface the inspector subscribes to — satisfied by
 * OpenTUI's `renderer.keyInput`. Kept narrow so tests can feed a fake emitter.
 */
export interface KeyEventSource {
  on(event: "keypress", handler: (key: KeyEvent) => void): unknown
  off(event: "keypress", handler: (key: KeyEvent) => void): unknown
}

export interface KeyInspectorOptions {
  source: KeyEventSource
  /** Toggles OpenTUI's console overlay so the log is visible in-app. */
  toggleConsole?: () => void
  /** Sink for each formatted line; defaults to `console.log`. */
  log?: (line: string) => void
}

/** One compact, JSON-ish line describing a keypress and its modifier bits. */
export function formatKeyEventLine(key: KeyEvent): string {
  return `[keyinspector] ${JSON.stringify({
    name: key.name,
    ctrl: key.ctrl,
    shift: key.shift,
    meta: key.meta,
    option: key.option,
    super: key.super ?? false,
    sequence: key.sequence,
  })}`
}

/**
 * Toggleable keypress logger used by the "Developer: Toggle Key Inspector"
 * command. When enabled it subscribes ONE keypress listener that prints each
 * event's modifier bits, and flips the console overlay so the output is visible
 * in-app — letting a user verify in seconds whether their terminal+tmux actually
 * forwards super/option. Fully unsubscribes when disabled (no listener leak).
 */
export class KeyInspector {
  readonly #source: KeyEventSource
  readonly #toggleConsole?: () => void
  readonly #log: (line: string) => void
  #active = false
  readonly #onKey = (key: KeyEvent): void => this.#log(formatKeyEventLine(key))

  constructor(options: KeyInspectorOptions) {
    this.#source = options.source
    this.#toggleConsole = options.toggleConsole
    this.#log = options.log ?? ((line) => console.log(line))
  }

  get active(): boolean {
    return this.#active
  }

  /** Flip the inspector on/off; returns the new active state. */
  toggle(): boolean {
    if (this.#active) this.disable()
    else this.enable()
    return this.#active
  }

  enable(): void {
    if (this.#active) return
    this.#active = true
    this.#source.on("keypress", this.#onKey)
    this.#toggleConsole?.()
  }

  disable(): void {
    if (!this.#active) return
    this.#active = false
    this.#source.off("keypress", this.#onKey)
    this.#toggleConsole?.()
  }
}
