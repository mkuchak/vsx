import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { destroyRendererAndWait } from "../testUtils/rendererTeardown"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { ConfirmDialog, type ConfirmButton } from "./ConfirmDialog"

let testSetup: Awaited<ReturnType<typeof testRender>>

afterEach(async () => {
  if (testSetup) await destroyRendererAndWait(testSetup.renderer)
})

function render(props: {
  message: string
  detail?: string
  buttons: ConfirmButton[]
  onSelect: (id: string) => void
  onCancel: () => void
}) {
  return testRender(
    <box width={60} height={16}>
      <CommandsProvider>
        <ConfirmDialog {...props} />
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

test("renders the message, detail, and button labels", async () => {
  testSetup = await render({
    message: "Delete this file?",
    detail: "You can restore it from the Trash.",
    buttons: [
      { id: "confirm", label: "Move to Trash", isDefault: true },
      { id: "cancel", label: "Cancel" },
    ],
    onSelect: () => {},
    onCancel: () => {},
  })
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Delete this file?")
  expect(frame).toContain("You can restore it from the Trash.")
  expect(frame).toContain("Move to Trash")
  expect(frame).toContain("Cancel")
})

test("Enter selects the default-highlighted button", async () => {
  let picked = ""
  testSetup = await render({
    message: "Discard?",
    buttons: [
      { id: "confirm", label: "Discard File", isDefault: true },
      { id: "cancel", label: "Cancel" },
    ],
    onSelect: (id) => (picked = id),
    onCancel: () => (picked = "onCancel"),
  })
  await settle()

  testSetup.mockInput.pressEnter()
  await settle()

  expect(picked).toBe("confirm")
})

test("Escape triggers onCancel", async () => {
  let picked = ""
  testSetup = await render({
    message: "Discard?",
    buttons: [
      { id: "confirm", label: "Discard File", isDefault: true },
      { id: "cancel", label: "Cancel" },
    ],
    onSelect: (id) => (picked = id),
    onCancel: () => (picked = "onCancel"),
  })
  await settle()

  testSetup.mockInput.pressEscape()
  await settle()

  expect(picked).toBe("onCancel")
})

test("Right moves the highlight so Enter selects the next button", async () => {
  let picked = ""
  testSetup = await render({
    message: "Discard?",
    buttons: [
      { id: "confirm", label: "Discard File", isDefault: true },
      { id: "cancel", label: "Cancel" },
    ],
    onSelect: (id) => (picked = id),
    onCancel: () => (picked = "onCancel"),
  })
  await settle()

  testSetup.mockInput.pressArrow("right")
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  expect(picked).toBe("cancel")
})

test("supports a 3-button layout and selects each by id", async () => {
  let picked = ""
  testSetup = await render({
    message: "Save changes before closing?",
    buttons: [
      { id: "save", label: "Save", isDefault: true },
      { id: "dontSave", label: "Don't Save" },
      { id: "cancel", label: "Cancel" },
    ],
    onSelect: (id) => (picked = id),
    onCancel: () => (picked = "onCancel"),
  })
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Save")
  expect(frame).toContain("Don't Save")
  expect(frame).toContain("Cancel")

  // Move from the default (Save) to the third button and confirm it.
  testSetup.mockInput.pressArrow("right")
  testSetup.mockInput.pressArrow("right")
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  expect(picked).toBe("cancel")
})
