import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDragArmed } from "../ui/dragManager"
import { workbenchStore } from "../model/workbench"
import { destroyRendererAndWait } from "../testUtils/rendererTeardown"
import { App } from "./App"

let root: string
let testSetup: Awaited<ReturnType<typeof testRender>>

async function settle(ms = 200) {
  await Bun.sleep(ms)
  await testSetup.renderOnce()
}

/** Find a renderable by id anywhere in the tree (mirrors App.test's tree walk). */
function findById(id: string): { x: number; width: number } | null {
  let found: { x: number; width: number } | null = null
  const walk = (node: { id?: string; getChildren: () => unknown[] }) => {
    if (node.id === id) found = node as unknown as { x: number; width: number }
    for (const child of node.getChildren()) walk(child as typeof node)
  }
  walk(testSetup.renderer.root as unknown as { getChildren: () => unknown[] })
  return found
}

function focusedTextareaCount(): number {
  let count = 0
  const walk = (node: { id?: string; focused?: boolean; getChildren: () => unknown[] }) => {
    if (node.id === "editor-textarea" && node.focused) count++
    for (const child of node.getChildren()) walk(child as typeof node)
  }
  walk(testSetup.renderer.root as unknown as { getChildren: () => unknown[] })
  return count
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vsx-resize-"))
  await writeFile(join(root, "hello.ts"), "const greeting = 'hi'\n")
  workbenchStore.reset()
})

afterEach(async () => {
  if (testSetup) await destroyRendererAndWait(testSetup.renderer)
  workbenchStore.reset()
  await rm(root, { recursive: true, force: true })
})

// Drives a real pointer-capture drag against the 1-cell sash: the down arms the
// gesture, the FIRST drag must land on the divider column so the renderer captures
// the pointer to it, then subsequent drags route to the divider even as x moves
// into the editor area beyond the handle.
async function dragDivider(fromX: number, toX: number, y = 5) {
  const mm = testSetup.mockMouse
  await mm.pressDown(fromX, y)
  await mm.emitMouseEvent("drag", fromX, y) // arms pointer capture on the divider
  await mm.emitMouseEvent("drag", toX, y)
  await mm.release(toX, y)
}

// A REAL drag: the first motion report already lands several cells off the 1-col
// sash, so the renderer captures the neighboring editor pane, not the sash. The
// pane's drag events bubble to the App main row, which services the gesture.
async function dragDividerFast(fromX: number, toX: number, y = 5) {
  const mm = testSetup.mockMouse
  await mm.pressDown(fromX, y)
  await mm.emitMouseEvent("drag", toX, y) // FIRST drag already off the sash column
  await mm.release(toX, y)
}

test("dragging the sash widens the sidebar, and double-click resets it to 32", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle()

  const sidebar = findById("sidebar")!
  expect(sidebar.width).toBe(32)
  const dividerX = sidebar.x + sidebar.width // column immediately after the sidebar

  // Drag the sash 8 columns to the right → 32 + 8 = 40.
  await dragDivider(dividerX, dividerX + 8)
  await settle()
  expect(findById("sidebar")!.width).toBe(40)

  // Double-click the sash (now at its shifted column) resets to the default width.
  const widened = findById("sidebar")!
  await testSetup.mockMouse.doubleClick(widened.x + widened.width, 5)
  await settle()
  expect(findById("sidebar")!.width).toBe(32)
})

test("dragging the sash resizes even when the first motion lands off the sash", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle()

  const sidebar = findById("sidebar")!
  expect(sidebar.width).toBe(32)
  const dividerX = sidebar.x + sidebar.width

  // The first (and only) drag event is already 8 cells into the editor area, so
  // the renderer captures a pane, not the 1-col sash — the real-world bug that
  // made dragging dead. The App main row now services the bubbled drag.
  await dragDividerFast(dividerX, dividerX + 8)
  await settle()
  expect(findById("sidebar")!.width).toBe(40)
  // The gesture disarms cleanly on release even though the drag ended off the sash.
  expect(isDragArmed()).toBe(false)
})

test("a drag that starts on the editor textarea leaves the sidebar width untouched", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle()

  // Open a file and move focus to the editor so a real, selectable textarea exists.
  workbenchStore.openFile(join(root, "hello.ts"), { preview: true })
  await settle()
  testSetup.mockInput.pressEscape()
  await settle()

  expect(findById("sidebar")!.width).toBe(32)

  // Mousedown ON the textarea (deep in the editor area) then drag: this is a text
  // SELECTION, not a sash gesture. No gesture is armed, so the ancestor's drag
  // handler must ignore it and the sidebar must not resize.
  const mm = testSetup.mockMouse
  await mm.pressDown(60, 10)
  await mm.emitMouseEvent("drag", 70, 10)
  await mm.emitMouseEvent("drag", 80, 10)
  await mm.release(80, 10)
  await settle()

  expect(findById("sidebar")!.width).toBe(32)
  expect(isDragArmed()).toBe(false)
})

test("grabbing and dragging the sash does not steal focus from the editor", async () => {
  testSetup = await testRender(<App workspaceRoot={root} />, { width: 100, height: 30 })
  await settle()

  // Open a file and move focus into the editor so a real textarea is focused.
  workbenchStore.openFile(join(root, "hello.ts"), { preview: true })
  await settle()
  testSetup.mockInput.pressEscape() // sidebar → editor
  await settle()
  expect(focusedTextareaCount()).toBe(1)

  const sidebar = findById("sidebar")!
  const dividerX = sidebar.x + sidebar.width

  await dragDivider(dividerX, dividerX + 8)
  await settle()

  // The resize happened…
  expect(findById("sidebar")!.width).toBe(40)
  // …but focus is unchanged: the editor textarea is still the focused one.
  expect(focusedTextareaCount()).toBe(1)
})
