import { CliRenderEvents, MouseButton, type InputRenderable } from "@opentui/core"
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { destroyRendererAndWait } from "../testUtils/rendererTeardown"
import { CommandsProvider, useCommands } from "../workbench/CommandsProvider"
import { ContextMenu, type ContextMenuItem } from "./ContextMenu"

let testSetup: Awaited<ReturnType<typeof testRender>>

let registry: ReturnType<typeof useCommands> | null = null
/** Grabs the registry so a test can register a ctrl+q command and dispatch it. */
function CaptureRegistry() {
  registry = useCommands()
  return null
}

afterEach(async () => {
  registry = null
  if (testSetup) await destroyRendererAndWait(testSetup.renderer)
})

async function settle(passes = 4) {
  for (let i = 0; i < passes; i++) {
    await testSetup.flush()
    await Bun.sleep(10)
  }
}

function render(
  props: { x: number; y: number; items: ContextMenuItem[]; onDismiss: () => void },
  size = { width: 60, height: 16 },
) {
  return testRender(
    <box width={size.width} height={size.height}>
      <CommandsProvider>
        <ContextMenu {...props} />
      </CommandsProvider>
    </box>,
    size,
  )
}

type Node = { id?: string; x?: number; y?: number; getChildren: () => unknown[] }

function findCell(id: string): { x: number; y: number } | null {
  let cell: { x: number; y: number } | null = null
  const walk = (node: Node) => {
    if (node.id === id) cell = node as { x: number; y: number }
    for (const child of node.getChildren()) walk(child as Node)
  }
  walk(testSetup.renderer.root as unknown as Node)
  return cell
}

test("renders all item labels", async () => {
  testSetup = await render({
    x: 2,
    y: 2,
    items: [
      { id: "rename", label: "Rename" },
      { id: "sep", label: "", isDivider: true },
      { id: "delete", label: "Delete" },
    ],
    onDismiss: () => {},
  })
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Rename")
  expect(frame).toContain("Delete")
})

test("clicking an item calls onSelect then onDismiss", async () => {
  const calls: string[] = []
  testSetup = await render({
    x: 2,
    y: 2,
    items: [
      { id: "rename", label: "Rename", onSelect: () => calls.push("rename") },
      { id: "delete", label: "Delete", onSelect: () => calls.push("delete") },
    ],
    onDismiss: () => calls.push("dismiss"),
  })
  await settle()

  const cell = findCell("contextMenu-item-delete")
  expect(cell).not.toBeNull()
  await testSetup.mockMouse.click(cell!.x, cell!.y)
  await settle()

  expect(calls).toEqual(["delete", "dismiss"])
})

test("a LEFT click outside the menu dismisses without selecting any item", async () => {
  const calls: string[] = []
  testSetup = await render({
    x: 0,
    y: 0,
    items: [
      { id: "rename", label: "Rename", onSelect: () => calls.push("rename") },
      { id: "delete", label: "Delete", onSelect: () => calls.push("delete") },
    ],
    onDismiss: () => calls.push("dismiss"),
  })
  await settle()

  // Far corner is outside the small top-left menu; the root click-away listener
  // (no full-screen backdrop) catches the bubbled left click and dismisses.
  await testSetup.mockMouse.click(59, 15)
  await settle()

  expect(calls).toEqual(["dismiss"])
})

test("a RIGHT click outside the menu does NOT dismiss (the row underneath replaces it)", async () => {
  const calls: string[] = []
  testSetup = await render({
    x: 0,
    y: 0,
    items: [
      { id: "rename", label: "Rename", onSelect: () => calls.push("rename") },
      { id: "delete", label: "Delete", onSelect: () => calls.push("delete") },
    ],
    onDismiss: () => calls.push("dismiss"),
  })
  await settle()

  // A right-click outside is deliberately left for whatever renderable sits under
  // the cursor to handle (e.g. a FileTree row opening a fresh menu) — the menu
  // must stay put rather than dismiss, so the replace happens in one gesture.
  await testSetup.mockMouse.pressDown(59, 15, MouseButton.RIGHT)
  await settle()

  expect(calls).toEqual([])
})

test("captures native focus so a keystroke can't leak into a background input", async () => {
  let inputRef: InputRenderable | null = null
  testSetup = await testRender(
    <box width={60} height={16}>
      <CommandsProvider>
        {/* Starts focused; the menu must steal native focus on mount so the
            keystroke below is swallowed instead of editing this input. */}
        <input
          id="bg-input"
          focused
          ref={(r: InputRenderable | null) => {
            inputRef = r
          }}
        />
        <ContextMenu
          x={2}
          y={2}
          items={[{ id: "a", label: "Action A" }]}
          onDismiss={() => {}}
        />
      </CommandsProvider>
    </box>,
    { width: 60, height: 16 },
  )
  await settle()

  testSetup.mockInput.typeText("Z")
  await settle()

  // The menu owns focus, so the printable key never reached the input.
  expect((inputRef as InputRenderable | null)?.value ?? "").toBe("")
})

test("Escape calls onDismiss", async () => {
  const calls: string[] = []
  testSetup = await render({
    x: 2,
    y: 2,
    items: [{ id: "rename", label: "Rename", onSelect: () => calls.push("rename") }],
    onDismiss: () => calls.push("dismiss"),
  })
  await settle()

  testSetup.mockInput.pressEscape()
  await settle()

  expect(calls).toEqual(["dismiss"])
})

test("renderer blur dismisses the menu so it can't linger invisibly", async () => {
  const calls: string[] = []
  testSetup = await render({
    x: 2,
    y: 2,
    items: [{ id: "rename", label: "Rename", onSelect: () => calls.push("rename") }],
    onDismiss: () => calls.push("dismiss"),
  })
  await settle()

  // Terminal focus-out (the mux popping its own overlay) fires renderer blur;
  // the menu must dismiss rather than stay mounted but unseen.
  testSetup.renderer.emit(CliRenderEvents.BLUR)
  await settle()

  expect(calls).toEqual(["dismiss"])
})

test("ctrl+q is not shadowed while the menu is open (quit binding still fires)", async () => {
  const calls: string[] = []
  testSetup = await testRender(
    <box width={60} height={16}>
      <CommandsProvider>
        <CaptureRegistry />
        <ContextMenu
          x={2}
          y={2}
          items={[{ id: "a", label: "Action A" }]}
          onDismiss={() => calls.push("dismiss")}
        />
      </CommandsProvider>
    </box>,
    { width: 60, height: 16 },
  )
  await settle()

  // The menu no longer pushes a keymap layer that blocks ctrl+q, so a real
  // ctrl+q binding registered elsewhere (App's workbench.quit) still resolves.
  const dispose = registry!.registerCommand({
    id: "test.quit",
    title: "Quit",
    keybinding: "ctrl+q",
    run: () => calls.push("quit"),
  })
  testSetup.mockInput.pressKey("q", { ctrl: true })
  await settle()
  dispose()

  expect(calls).toEqual(["quit"])
})

test("Down skips dividers and disabled items; Enter selects the highlighted one", async () => {
  const calls: string[] = []
  testSetup = await render({
    x: 2,
    y: 2,
    items: [
      { id: "a", label: "Action A", onSelect: () => calls.push("a") },
      { id: "sep", label: "", isDivider: true },
      { id: "b", label: "Disabled B", disabled: true, onSelect: () => calls.push("b") },
      { id: "c", label: "Action C", onSelect: () => calls.push("c") },
    ],
    onDismiss: () => calls.push("dismiss"),
  })
  await settle()

  // Highlight starts on "a"; one Down must skip the divider and disabled item to "c".
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  expect(calls).toEqual(["c", "dismiss"])
})

test("clicking a disabled item does nothing", async () => {
  const calls: string[] = []
  testSetup = await render({
    x: 2,
    y: 2,
    items: [
      { id: "b", label: "Disabled B", disabled: true, onSelect: () => calls.push("b") },
    ],
    onDismiss: () => calls.push("dismiss"),
  })
  await settle()

  const cell = findCell("contextMenu-item-b")
  expect(cell).not.toBeNull()
  await testSetup.mockMouse.click(cell!.x, cell!.y)
  await settle()

  expect(calls).toEqual([])
})

test("clamps to stay on-screen when anchored past the right/bottom edge", async () => {
  testSetup = await render(
    {
      x: 100,
      y: 100,
      items: [
        { id: "rename", label: "Rename" },
        { id: "delete", label: "Delete" },
      ],
      onDismiss: () => {},
    },
    { width: 24, height: 8 },
  )
  await settle()

  const box = findCell("contextMenu-box")
  expect(box).not.toBeNull()
  // menuWidth = "Rename"/"Delete" (6) + 4 chrome = 10; menuHeight = 2 items + 2 border = 4.
  expect(box!.x).toBe(24 - 10)
  expect(box!.y).toBe(8 - 4)
})

test("anchors at x/y when it fits on-screen", async () => {
  testSetup = await render({
    x: 5,
    y: 3,
    items: [{ id: "rename", label: "Rename" }],
    onDismiss: () => {},
  })
  await settle()

  const box = findCell("contextMenu-box")
  expect(box).not.toBeNull()
  expect(box!.x).toBe(5)
  expect(box!.y).toBe(3)
})
