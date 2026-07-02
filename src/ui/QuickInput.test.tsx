import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { workbenchStore } from "../model/workbench"
import * as workspace from "../services/workspace"
import type { DirEntry } from "../services/workspace"
import { QuickInput, splitPathQuery } from "./QuickInput"

const HOME = "/home/tester"

describe("splitPathQuery", () => {
  test("splits an absolute path at the last slash", () => {
    expect(splitPathQuery("/foo/ba", HOME)).toEqual({ dir: "/foo", fragment: "ba" })
    expect(splitPathQuery("/foo/bar/baz", HOME)).toEqual({ dir: "/foo/bar", fragment: "baz" })
  })

  test("a trailing slash lists the directory itself with an empty fragment", () => {
    expect(splitPathQuery("/foo/bar/", HOME)).toEqual({ dir: "/foo/bar", fragment: "" })
  })

  test("multiple trailing slashes split at the last one (dir keeps the inner slash)", () => {
    expect(splitPathQuery("/foo//", HOME)).toEqual({ dir: "/foo/", fragment: "" })
  })

  test("a fragment may contain spaces", () => {
    expect(splitPathQuery("/foo/ba r", HOME)).toEqual({ dir: "/foo", fragment: "ba r" })
  })

  test("a slash at the root keeps `/` as the directory", () => {
    expect(splitPathQuery("/foo", HOME)).toEqual({ dir: "/", fragment: "foo" })
    expect(splitPathQuery("/", HOME)).toEqual({ dir: "/", fragment: "" })
  })

  test("bare `~` expands to the home directory's parent + basename fragment", () => {
    expect(splitPathQuery("~", HOME)).toEqual({ dir: "/home", fragment: "tester" })
  })

  test("`~/` lists the home directory itself", () => {
    expect(splitPathQuery("~/", HOME)).toEqual({ dir: HOME, fragment: "" })
  })

  test("`~/frag` expands home and splits the fragment", () => {
    expect(splitPathQuery("~/src", HOME)).toEqual({ dir: HOME, fragment: "src" })
    expect(splitPathQuery("~/src/in", HOME)).toEqual({ dir: `${HOME}/src`, fragment: "in" })
  })
})

let testSetup: Awaited<ReturnType<typeof testRender>>
let dir: string
// Fixture directory created OUTSIDE the workspace root for path-browse tests.
let browseDir: string | undefined

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
  if (browseDir) {
    await rm(browseDir, { recursive: true, force: true })
    browseDir = undefined
  }
})

let gotoCalls: Array<[number, number | undefined]>

function render(homeDir?: string) {
  gotoCalls = []
  return testRender(
    <OverlayProvider>
      <CommandsProvider>
        <QuickInput
          workspaceRoot={dir}
          homeDir={homeDir}
          onGotoLine={(line, column) => gotoCalls.push([line, column])}
        />
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

// Builds a fixture tree OUTSIDE the workspace root: two dirs + two files, plus a
// file nested inside one dir to verify descent.
async function makeBrowseFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vsx-browse-"))
  await mkdir(join(root, "Alpha"))
  await mkdir(join(root, "zeta"))
  await writeFile(join(root, "Apple.txt"), "x")
  await writeFile(join(root, "banana.txt"), "x")
  await writeFile(join(root, "Alpha", "nested.txt"), "x")
  return root
}

test("an absolute path with a trailing slash lists entries dirs-first", async () => {
  browseDir = await makeBrowseFixture()
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText(`${browseDir}/`)
  await settle()

  const frame = testSetup.captureCharFrame()
  // Directories are suffixed with `/` and sorted ahead of files.
  expect(frame).toContain("Alpha/")
  expect(frame).toContain("zeta/")
  expect(frame).toContain("Apple.txt")
  expect(frame).toContain("banana.txt")
  expect(frame.indexOf("Alpha/")).toBeLessThan(frame.indexOf("zeta/"))
  expect(frame.indexOf("zeta/")).toBeLessThan(frame.indexOf("Apple.txt"))
})

test("a trailing fragment filters the directory listing", async () => {
  browseDir = await makeBrowseFixture()
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText(`${browseDir}/ban`)
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("banana.txt")
  expect(frame).not.toContain("Apple.txt")
  expect(frame).not.toContain("zeta/")
})

test("Enter on a directory descends into it and keeps the overlay open", async () => {
  browseDir = await makeBrowseFixture()
  testSetup = await render()
  await settle()
  await open()

  // First result is the "Alpha" directory (dirs-first).
  await testSetup.mockInput.typeText(`${browseDir}/`)
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  const frame = testSetup.captureCharFrame()
  // The overlay stayed open and now lists Alpha's contents (proving descent).
  expect(frame).toContain("nested.txt")
  // Nothing was opened.
  expect(activePath()).toBeNull()
})

test("Enter on a file opens its absolute path outside the workspace root", async () => {
  browseDir = await makeBrowseFixture()
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText(`${browseDir}/banana.txt`)
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  expect(activePath()).toBe(join(browseDir, "banana.txt"))
  expect(activeTab()?.preview).toBe(true)
  expect(testSetup.captureCharFrame()).not.toContain("Go to file")
})

test("a non-existent path shows empty results without crashing", async () => {
  testSetup = await render()
  await settle()
  await open()

  await testSetup.mockInput.typeText("/no/such/vsx-path/xyz")
  await settle()

  const frame = testSetup.captureCharFrame()
  // The overlay is still alive (renders the typed query, no crash) with no
  // results, and nothing was opened.
  expect(frame).toContain("/no/such/vsx-path/xyz")
  expect(activePath()).toBeNull()
})

test("`~/` maps to the injected home directory", async () => {
  // Hermetic: point `~` at a fixture instead of the CI machine's real $HOME.
  browseDir = await makeBrowseFixture()
  testSetup = await render(browseDir)
  await settle()
  await open()

  await testSetup.mockInput.typeText("~/")
  await settle()

  // `~` expanded to the fixture home, so its entries are listed.
  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("Alpha/")
  expect(frame).toContain("banana.txt")
})

// Regression for a cancelled-load cache-poisoning bug: React cancels the
// in-flight `listDir` on every keystroke (the effect's cleanup flips a
// `cancelled` flag), so when a fragment keystroke lands in the SAME directory as
// a slow load already in flight, the dedupe must still re-fire the load rather
// than treat the directory as already resolved. With the old optimistic
// `requestedDirRef` dedupe the replacement load never fired and the listing
// stayed empty forever; deduping on the COMMITTED listing fixes it.
test("a fragment keystroke that cancels an in-flight directory load still lists entries", async () => {
  browseDir = await makeBrowseFixture()
  testSetup = await render()
  await settle()
  await open()

  const realListDir = workspace.listDir
  // Hold every listDir call open until we manually resolve it, so the first load
  // is guaranteed still in flight when the fragment keystroke cancels it.
  const deferred: Array<() => void> = []
  const spy = spyOn(workspace, "listDir").mockImplementation(
    (path: string) =>
      new Promise<DirEntry[]>((resolve) => {
        deferred.push(() => {
          void realListDir(path).then(resolve)
        })
      }),
  )
  try {
    // One commit takes the query straight to the trailing-slash form, firing a
    // (deferred, unresolved) load for browseDir.
    await testSetup.mockInput.typeText(`${browseDir}/`)
    await settle()

    // A separate commit appends a fragment char in the SAME directory. This
    // cancels the in-flight load; the fix must fire a replacement.
    testSetup.mockInput.pressKey("b")
    await settle()

    // Resolve every load. Only the live (non-cancelled) one commits.
    for (const resolve of deferred) resolve()

    const deadline = Date.now() + 3000
    while (!testSetup.captureCharFrame().includes("banana.txt") && Date.now() < deadline) {
      await settle()
    }
    expect(testSetup.captureCharFrame()).toContain("banana.txt")
  } finally {
    spy.mockRestore()
  }
})
