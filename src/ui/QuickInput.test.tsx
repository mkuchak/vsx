import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { workbenchStore } from "../model/workbench"
import { QuickInput } from "./QuickInput"

let testSetup: Awaited<ReturnType<typeof testRender>>
let dir: string

beforeEach(async () => {
  workbenchStore.reset()
  dir = await mkdtemp(join(tmpdir(), "vsx-quickinput-"))
  await mkdir(join(dir, "src"))
  await writeFile(join(dir, "src", "index.ts"), "export {}\n")
  await writeFile(join(dir, "src", "util.ts"), "export {}\n")
  await writeFile(join(dir, "src", "utils_helper.ts"), "export {}\n")
  await writeFile(join(dir, "README.md"), "# hi\n")
})

afterEach(async () => {
  if (testSetup) testSetup.renderer.destroy()
  workbenchStore.reset()
  await rm(dir, { recursive: true, force: true })
})

let gotoCalls: Array<[number, number | undefined]>

function render() {
  gotoCalls = []
  return testRender(
    <OverlayProvider>
      <CommandsProvider>
        <QuickInput workspaceRoot={dir} onGotoLine={(line, column) => gotoCalls.push([line, column])} />
      </CommandsProvider>
    </OverlayProvider>,
    // kittyKeyboard lets the mock emit disambiguated Ctrl+Shift+letter and F1
    // sequences (a real terminal needs the same capability for these chords).
    { width: 80, height: 24, kittyKeyboard: true },
  )
}

// Lets React commit state AND run passive effects (which refresh useKeyboard's
// handler ref and the enumerate promise) between simulated inputs.
async function settle() {
  for (let i = 0; i < 6; i++) {
    await testSetup.flush()
    await Bun.sleep(15)
  }
}

function activePath() {
  const state = workbenchStore.getState()
  return state.groups.find((g) => g.id === state.activeGroupId)?.activeTabPath ?? null
}

function activeTab() {
  const state = workbenchStore.getState()
  const group = state.groups.find((g) => g.id === state.activeGroupId)
  return group?.tabs.find((t) => t.path === group.activeTabPath) ?? null
}

// Concatenated text of every span rendered bold this frame.
function boldText(): string {
  return testSetup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .filter((span) => (span.attributes & TextAttributes.BOLD) !== 0)
    .map((span) => span.text)
    .join("")
}

async function open() {
  testSetup.mockInput.pressKey("p", { ctrl: true })
  await settle()
}

test("Ctrl+P opens the overlay", async () => {
  testSetup = await render()
  await settle()
  expect(testSetup.captureCharFrame()).not.toContain("Go to file")

  await open()
  expect(testSetup.captureCharFrame()).toContain("Go to file")
})

test("typing filters + ranks results and bolds the matched characters", async () => {
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText("util")
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("util.ts")
  expect(frame).toContain("utils_helper.ts")
  // Non-matching files are filtered out.
  expect(frame).not.toContain("README.md")
  // The matched prefix is rendered bold.
  expect(boldText()).toContain("util")
})

test("Down + Enter opens the second result with preview and closes the overlay", async () => {
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText("util")
  await settle()
  // Results: util.ts (0), utils_helper.ts (1). Move to the second.
  testSetup.mockInput.pressArrow("down")
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  expect(activePath()).toBe(join(dir, "src", "utils_helper.ts"))
  expect(activeTab()?.preview).toBe(true)
  // Overlay is gone from the next frame.
  expect(testSetup.captureCharFrame()).not.toContain("Go to file")
})

test("Escape closes the overlay without opening anything", async () => {
  testSetup = await render()
  await settle()
  await open()
  await testSetup.mockInput.typeText("util")
  await settle()

  testSetup.mockInput.pressEscape()
  await settle()

  expect(activePath()).toBeNull()
  expect(testSetup.captureCharFrame()).not.toContain("Go to file")
})

test("typing '>' alone shows all commands in MRU-first order with keybindings", async () => {
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText(">")
  await settle()

  const frame = testSetup.captureCharFrame()
  // Registered commands are listed…
  expect(frame).toContain("Quick Open")
  expect(frame).toContain("Show All Commands")
  // …with their keybindings formatted and shown.
  expect(frame).toContain("Ctrl+P")
  // Files are NOT shown in command mode.
  expect(frame).not.toContain("README.md")
})

test("'>' plus a fragment fuzzy-filters + ranks commands and bolds matches", async () => {
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText(">quick")
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Quick Open")
  // Non-matching commands are filtered out.
  expect(frame).not.toContain("Show All Commands")
  expect(boldText()).toContain("Quick")
})

test("accepting a command result closes the overlay before executing", async () => {
  testSetup = await render()
  await settle()
  await open()

  // Route to command mode and accept "Quick Open" itself. Its run() reopens the
  // palette with an empty query, so after acceptance the overlay is visible and
  // in file mode ("Go to file"), which only holds if we closed-then-executed.
  await testSetup.mockInput.typeText(">quick open")
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Go to file")
})

test("Ctrl+Shift+P opens the palette seeded to command mode", async () => {
  testSetup = await render()
  await settle()

  testSetup.mockInput.pressKey("p", { ctrl: true, shift: true })
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Show All Commands")
  expect(frame).not.toContain("Go to file")
})

test("F1 opens the palette seeded to command mode", async () => {
  testSetup = await render()
  await settle()

  testSetup.mockInput.pressKey("F1")
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Show All Commands")
})

test("':42' shows a go-to-line hint and accepting fires onGotoLine(42)", async () => {
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText(":42")
  await settle()
  expect(testSetup.captureCharFrame()).toContain("Go to line 42")

  testSetup.mockInput.pressEnter()
  await settle()
  expect(gotoCalls).toEqual([[42, undefined]])
  expect(testSetup.captureCharFrame()).not.toContain("Go to file")
})

test("':42:10' fires onGotoLine(42, 10)", async () => {
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText(":42:10")
  await settle()
  expect(testSetup.captureCharFrame()).toContain("Go to line 42, column 10")

  testSetup.mockInput.pressEnter()
  await settle()
  expect(gotoCalls).toEqual([[42, 10]])
})

test("':' with a non-numeric remainder shows the invalid hint and does not crash", async () => {
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText(":abc")
  await settle()
  expect(testSetup.captureCharFrame()).toContain("Type a line number")

  testSetup.mockInput.pressEnter()
  await settle()
  expect(gotoCalls).toEqual([])
})

test("switching from file text to a leading '>' re-routes to command mode live", async () => {
  testSetup = await render()
  await settle()
  await open()

  // Start in file mode.
  await testSetup.mockInput.typeText("util")
  await settle()
  expect(testSetup.captureCharFrame()).toContain("util.ts")

  // Clear the input, then type ">" — the memo re-routes on the derived query.
  for (let i = 0; i < 8; i++) testSetup.mockInput.pressBackspace()
  await settle()
  await testSetup.mockInput.typeText(">")
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Show All Commands")
  expect(frame).not.toContain("util.ts")
})

test("reopening with an empty query shows the recently-opened list", async () => {
  testSetup = await render()
  await settle()

  // Accept a file once to populate the MRU.
  await open()
  await testSetup.mockInput.typeText("index")
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()
  expect(activePath()).toBe(join(dir, "src", "index.ts"))

  // Reopen with an empty query — the accepted file appears without retyping.
  await open()
  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Go to file")
  expect(frame).toContain("index.ts")
})
