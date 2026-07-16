import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { destroyRendererAndWait } from "../testUtils/rendererTeardown"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { TextInputDialog, type TextInputDialogProps } from "./TextInputDialog"

let testSetup: Awaited<ReturnType<typeof testRender>>

afterEach(async () => {
  if (testSetup) await destroyRendererAndWait(testSetup.renderer)
})

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

function render(props: TextInputDialogProps) {
  return testRender(
    <box width={60} height={16}>
      <CommandsProvider>
        <OverlayProvider>
          <TextInputDialog {...props} />
        </OverlayProvider>
      </CommandsProvider>
    </box>,
    { width: 60, height: 16 },
  )
}

async function settle(passes = 4) {
  for (let i = 0; i < passes; i++) {
    await testSetup.flush()
    await Bun.sleep(10)
  }
}

test("renders the title and pre-filled initialValue", async () => {
  testSetup = await render({
    title: "Rename",
    initialValue: "old-name.ts",
    onConfirm: () => {},
    onCancel: () => {},
  })
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Rename")
  expect(frame).toContain("old-name.ts")
  expect(frame).toContain("Cancel")
  expect(frame).toContain("Confirm")
})

test("typing replaces the selected pre-filled value", async () => {
  let confirmed = ""
  testSetup = await render({
    title: "Rename",
    initialValue: "old.ts",
    onConfirm: (v) => (confirmed = v),
    onCancel: () => {},
  })
  await settle()

  await testSetup.mockInput.typeText("new.ts")
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  expect(confirmed).toBe("new.ts")
})

test("Enter with no validate confirms the current text", async () => {
  let confirmed = "UNSET"
  testSetup = await render({
    title: "New File",
    initialValue: "",
    onConfirm: (v) => (confirmed = v),
    onCancel: () => {},
  })
  await settle()

  await testSetup.mockInput.typeText("index.ts")
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  expect(confirmed).toBe("index.ts")
})

test("Enter does not confirm while validate returns an error", async () => {
  let confirmed = "UNSET"
  testSetup = await render({
    title: "New File",
    initialValue: "",
    validate: (v) => (v.trim() === "" ? "cannot be empty" : null),
    onConfirm: (v) => (confirmed = v),
    onCancel: () => {},
  })
  await settle()

  // Value is empty → invalid → Enter must be a no-op.
  testSetup.mockInput.pressEnter()
  await settle()

  expect(confirmed).toBe("UNSET")
})

test("error message shows when invalid and disappears once valid", async () => {
  testSetup = await render({
    title: "New File",
    initialValue: "",
    validate: (v) => (v.trim() === "" ? "cannot be empty" : null),
    onConfirm: () => {},
    onCancel: () => {},
  })
  await settle()

  expect(testSetup.captureCharFrame()).toContain("cannot be empty")

  await testSetup.mockInput.typeText("ok.ts")
  await settle()

  expect(testSetup.captureCharFrame()).not.toContain("cannot be empty")
})

test("Escape triggers onCancel", async () => {
  let cancelled = false
  testSetup = await render({
    title: "Rename",
    initialValue: "x.ts",
    onConfirm: () => {},
    onCancel: () => (cancelled = true),
  })
  await settle()

  testSetup.mockInput.pressEscape()
  await settle()

  expect(cancelled).toBe(true)
})

test("clicking Confirm confirms the current value", async () => {
  let confirmed = "UNSET"
  testSetup = await render({
    title: "Rename",
    initialValue: "keep.ts",
    onConfirm: (v) => (confirmed = v),
    onCancel: () => {},
  })
  await settle()

  const btn = findCell("textInputDialog-confirm")
  expect(btn).not.toBeNull()
  await testSetup.mockMouse.click(btn!.x, btn!.y)
  await settle()

  expect(confirmed).toBe("keep.ts")
})

test("clicking Cancel triggers onCancel", async () => {
  let cancelled = false
  testSetup = await render({
    title: "Rename",
    initialValue: "keep.ts",
    onConfirm: () => {},
    onCancel: () => (cancelled = true),
  })
  await settle()

  const btn = findCell("textInputDialog-cancel")
  expect(btn).not.toBeNull()
  await testSetup.mockMouse.click(btn!.x, btn!.y)
  await settle()

  expect(cancelled).toBe(true)
})

test("clicking Confirm while invalid does not confirm", async () => {
  let confirmed = "UNSET"
  testSetup = await render({
    title: "New File",
    initialValue: "",
    validate: (v) => (v.trim() === "" ? "cannot be empty" : null),
    onConfirm: (v) => (confirmed = v),
    onCancel: () => {},
  })
  await settle()

  const btn = findCell("textInputDialog-confirm")
  expect(btn).not.toBeNull()
  await testSetup.mockMouse.click(btn!.x, btn!.y)
  await settle()

  expect(confirmed).toBe("UNSET")
})
