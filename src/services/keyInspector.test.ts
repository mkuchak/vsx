import { describe, expect, it } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { KeyInspector, formatKeyEventLine, type KeyEventSource } from "./keyInspector"

function fakeSource() {
  const listeners = new Set<(key: KeyEvent) => void>()
  const source: KeyEventSource = {
    on: (_event, handler) => listeners.add(handler),
    off: (_event, handler) => listeners.delete(handler),
  }
  return { source, listeners }
}

function keyEvent(over: Partial<KeyEvent>): KeyEvent {
  return {
    name: "p",
    ctrl: false,
    shift: false,
    meta: false,
    option: false,
    super: false,
    sequence: "",
    ...over,
  } as KeyEvent
}

describe("KeyInspector", () => {
  it("subscribes exactly one listener on enable and removes it on disable", () => {
    const { source, listeners } = fakeSource()
    let consoleToggles = 0
    const inspector = new KeyInspector({
      source,
      toggleConsole: () => {
        consoleToggles++
      },
      log: () => {},
    })

    expect(listeners.size).toBe(0)

    inspector.toggle()
    expect(inspector.active).toBe(true)
    expect(listeners.size).toBe(1)
    expect(consoleToggles).toBe(1)

    inspector.toggle()
    expect(inspector.active).toBe(false)
    expect(listeners.size).toBe(0)
    expect(consoleToggles).toBe(2)
  })

  it("does not leak listeners across repeated toggles", () => {
    const { source, listeners } = fakeSource()
    const inspector = new KeyInspector({ source, log: () => {} })

    for (let i = 0; i < 5; i++) {
      inspector.enable()
      inspector.enable() // idempotent — no second subscription
    }
    expect(listeners.size).toBe(1)

    for (let i = 0; i < 5; i++) {
      inspector.disable()
      inspector.disable() // idempotent — no double-unsubscribe error
    }
    expect(listeners.size).toBe(0)
  })

  it("logs one compact line per keypress while active", () => {
    const { source, listeners } = fakeSource()
    const lines: string[] = []
    const inspector = new KeyInspector({ source, log: (line) => lines.push(line) })

    inspector.enable()
    for (const handler of listeners) handler(keyEvent({ name: "p", super: true, sequence: "" }))

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"name":"p"')
    expect(lines[0]).toContain('"super":true')
  })
})

describe("formatKeyEventLine", () => {
  it("renders every modifier bit, defaulting an absent super to false", () => {
    const line = formatKeyEventLine(keyEvent({ name: "s", ctrl: true, super: undefined }))
    expect(line).toContain('"name":"s"')
    expect(line).toContain('"ctrl":true')
    expect(line).toContain('"super":false')
  })
})
