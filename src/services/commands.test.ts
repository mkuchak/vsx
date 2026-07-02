import { describe, expect, it } from "bun:test"
import { registerEnabledFields, registerMetadataFields } from "@opentui/keymap/addons"
import { createTestKeymap } from "@opentui/keymap/testing"
import { CommandRegistry } from "./commands"

function makeRegistry() {
  const harness = createTestKeymap({ defaultKeys: true })
  // Mirror createDefaultOpenTuiKeymap so `enabled`/`title`/`category` fields compile.
  registerEnabledFields(harness.keymap)
  registerMetadataFields(harness.keymap)
  const registry = new CommandRegistry(harness.keymap)
  return { registry, host: harness.host, cleanup: harness.cleanup }
}

describe("CommandRegistry", () => {
  it("dispatches registered commands by key and by executeCommand", () => {
    const { registry, host, cleanup } = makeRegistry()
    const calls: string[] = []

    registry.registerCommand({ id: "a", title: "Alpha", keybinding: "ctrl+a", run: () => calls.push("a") })
    registry.registerCommand({ id: "b", title: "Beta", keybinding: "ctrl+b", run: () => calls.push("b") })

    host.press("a", { ctrl: true })
    expect(calls).toEqual(["a"])

    expect(registry.executeCommand("b")).toBe(true)
    expect(calls).toEqual(["a", "b"])

    cleanup()
  })

  it("reports title/category/keybinding via getCommands", () => {
    const { registry, cleanup } = makeRegistry()
    registry.registerCommand({
      id: "file.save",
      title: "Save",
      category: "File",
      keybinding: "ctrl+s",
      run: () => {},
    })

    const info = registry.getCommands().find((c) => c.id === "file.save")
    expect(info).toMatchObject({ title: "Save", category: "File", keybinding: "ctrl+s" })
    expect(info?.recency).toBeUndefined()

    cleanup()
  })

  it("updates MRU order and recency when commands execute", () => {
    const { registry, cleanup } = makeRegistry()
    registry.registerCommand({ id: "one", title: "One", run: () => {} })
    registry.registerCommand({ id: "two", title: "Two", run: () => {} })
    registry.registerCommand({ id: "three", title: "Three", run: () => {} })

    registry.executeCommand("two")
    registry.executeCommand("one")

    const ids = registry.getCommands().map((c) => c.id)
    expect(ids).toEqual(["one", "two", "three"])

    const byId = new Map(registry.getCommands().map((c) => [c.id, c.recency]))
    expect(byId.get("one")).toBe(0)
    expect(byId.get("two")).toBe(1)
    expect(byId.get("three")).toBeUndefined()

    cleanup()
  })

  it("lets a pushed layer shadow a base binding, restored on pop", () => {
    const { registry, host, cleanup } = makeRegistry()
    const calls: string[] = []

    registry.registerCommand({ id: "base", title: "Base", keybinding: "ctrl+k", run: () => calls.push("base") })

    host.press("k", { ctrl: true })
    expect(calls).toEqual(["base"])

    const pop = registry.pushLayer({
      commands: [{ name: "modal", run: () => { calls.push("modal") } }],
      bindings: [{ key: "ctrl+k", cmd: "modal" }],
    })

    host.press("k", { ctrl: true })
    expect(calls).toEqual(["base", "modal"])

    pop()

    host.press("k", { ctrl: true })
    expect(calls).toEqual(["base", "modal", "base"])

    cleanup()
  })

  it("blocks disabled commands from executing", () => {
    const { registry, host, cleanup } = makeRegistry()
    const calls: string[] = []

    registry.registerCommand({
      id: "gated",
      title: "Gated",
      keybinding: "ctrl+g",
      enabled: () => false,
      run: () => calls.push("gated"),
    })

    expect(registry.executeCommand("gated")).toBe(false)
    host.press("g", { ctrl: true })
    expect(calls).toEqual([])

    cleanup()
  })

  it("gates dispatch: rejected ids no-op, allowlisted ids pass, clearing restores", () => {
    const { registry, host, cleanup } = makeRegistry()
    const calls: string[] = []

    registry.registerCommand({ id: "blocked", title: "Blocked", keybinding: "ctrl+b", run: () => calls.push("blocked") })
    registry.registerCommand({ id: "allowed", title: "Allowed", keybinding: "ctrl+a", run: () => calls.push("allowed") })

    // Gate that only lets "allowed" through.
    registry.setDispatchGate((id) => id === "allowed")

    // Rejected via keybinding AND executeCommand — both are silent no-ops.
    host.press("b", { ctrl: true })
    expect(registry.executeCommand("blocked")).toBe(false)
    expect(calls).toEqual([])

    // Allowlisted id passes through both paths while the gate is active.
    host.press("a", { ctrl: true })
    expect(registry.executeCommand("allowed")).toBe(true)
    expect(calls).toEqual(["allowed", "allowed"])

    // bypassGate skips the gate for an otherwise-rejected id.
    expect(registry.executeCommand("blocked", { bypassGate: true })).toBe(true)
    expect(calls).toEqual(["allowed", "allowed", "blocked"])

    // Clearing the gate restores normal dispatch.
    registry.setDispatchGate(undefined)
    host.press("b", { ctrl: true })
    expect(calls).toEqual(["allowed", "allowed", "blocked", "blocked"])

    cleanup()
  })

  it("keeps a last-wins re-registration alive when the shadowed one is disposed", () => {
    const { registry, host, cleanup } = makeRegistry()
    const calls: string[] = []

    const warns: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warns.push(args.join(" "))

    try {
      // Simulate the OLD per-pane pattern: two registrations for the same id.
      const disposeA = registry.registerCommand({
        id: "x",
        title: "X-A",
        keybinding: "ctrl+x",
        run: () => calls.push("A"),
      })
      registry.registerCommand({
        id: "x",
        title: "X-B",
        keybinding: "ctrl+x",
        run: () => calls.push("B"),
      })

      // Registering B over A must warn about the duplicate id.
      expect(warns.some((w) => w.includes('"x"'))).toBe(true)

      // Disposing A must NOT strip B: the command stays in the palette...
      disposeA()
      expect(registry.getCommands().find((c) => c.id === "x")?.title).toBe("X-B")

      // ...and still dispatches (to B, the surviving registration).
      expect(registry.executeCommand("x")).toBe(true)
      host.press("x", { ctrl: true })
      expect(calls).toEqual(["B", "B"])
    } finally {
      console.warn = originalWarn
      cleanup()
    }
  })

  it("removes a command and its binding when disposed", () => {
    const { registry, host, cleanup } = makeRegistry()
    const calls: string[] = []

    const dispose = registry.registerCommand({
      id: "temp",
      title: "Temp",
      keybinding: "ctrl+t",
      run: () => calls.push("temp"),
    })

    dispose()

    expect(registry.executeCommand("temp")).toBe(false)
    host.press("t", { ctrl: true })
    expect(calls).toEqual([])
    expect(registry.getCommands().find((c) => c.id === "temp")).toBeUndefined()

    cleanup()
  })
})
