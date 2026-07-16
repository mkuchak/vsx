import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { workbenchStore } from "../model/workbench"
import { createFileHistory, type FileHistory } from "../services/fileHistory"
import * as fuzzy from "../services/fuzzy"
import * as workspace from "../services/workspace"
import type { DirEntry } from "../services/workspace"
import { destroyRendererAndWait } from "../testUtils/rendererTeardown"
import { QuickInput, splitPathQuery } from "./QuickInput"

const HOME = "/home/tester"
// The delete key escape sequence; with kittyKeyboard the mock re-encodes it as a
// kitty `delete` so `pressKey(DELETE, { shift: true })` becomes Shift+Delete.
const DELETE = "\x1b[3~"

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
// Isolated state dir backing hermetic FileHistory instances (never the real one).
let historyDir: string

beforeEach(async () => {
  workbenchStore.reset()
  dir = await mkdtemp(join(tmpdir(), "vsx-quickinput-"))
  await mkdir(join(dir, "src"))
  await writeFile(join(dir, "src", "index.ts"), "export {}\n")
  await writeFile(join(dir, "src", "util.ts"), "export {}\n")
  await writeFile(join(dir, "src", "utils_helper.ts"), "export {}\n")
  await writeFile(join(dir, "README.md"), "# hi\n")
  historyDir = await mkdtemp(join(tmpdir(), "vsx-history-"))
})

afterEach(async () => {
  if (testSetup) await destroyRendererAndWait(testSetup.renderer)
  workbenchStore.reset()
  // Clear any recorder a test wired so it can't leak into the next one.
  workbenchStore.setOpenRecorder(null)
  await rm(dir, { recursive: true, force: true })
  await rm(historyDir, { recursive: true, force: true })
  if (browseDir) {
    await rm(browseDir, { recursive: true, force: true })
    browseDir = undefined
  }
})

// A hermetic history backed by the per-test temp state dir.
function makeHistory(): FileHistory {
  return createFileHistory({ baseDir: historyDir })
}

// Record `path` `times` opens into `history`, oldest bump first.
function seed(history: FileHistory, path: string, times = 1): void {
  for (let i = 0; i < times; i++) history.record(path)
}

let gotoCalls: Array<[number, number | undefined]>

function render(homeDir?: string, fileHistory?: FileHistory) {
  gotoCalls = []
  return testRender(
    <OverlayProvider>
      <CommandsProvider>
        <QuickInput
          workspaceRoot={dir}
          homeDir={homeDir}
          fileHistory={fileHistory}
          onGotoLine={(line, column) => gotoCalls.push([line, column])}
        />
      </CommandsProvider>
    </OverlayProvider>,
    // kittyKeyboard lets the mock emit disambiguated Ctrl+Shift+letter, F1, and
    // Shift+Delete sequences (a real terminal needs the same capability).
    { width: 80, height: 24, kittyKeyboard: true },
  )
}

// Screen coordinate (0-based) of the first `glyph` in the current frame, or null.
function findGlyph(glyph: string): { x: number; y: number } | null {
  const lines = testSetup.captureCharFrame().split("\n")
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y]!.indexOf(glyph)
    if (x !== -1) return { x, y }
  }
  return null
}

// Count of `<box id="quick-N">` result rows actually mounted — unlike the
// captured frame (clipped to the scrollbox's visible height), this reflects
// every row in `results`, scrolled-off ones included.
function quickRowCount(): number {
  let count = 0
  const walk = (node: { id?: string; getChildren: () => unknown[] }) => {
    if (node.id?.startsWith("quick-")) count++
    for (const child of node.getChildren()) walk(child as typeof node)
  }
  walk(testSetup.renderer.root as unknown as { id?: string; getChildren: () => unknown[] })
  return count
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

test("a truncated enumeration surfaces a partial-results hint in file mode", async () => {
  // Force enumerateFiles to report truncation without building a huge fixture.
  const enumSpy = spyOn(workspace, "enumerateFiles").mockResolvedValue({
    files: ["src/util.ts", "src/utils_helper.ts"],
    truncated: true,
  })
  try {
    testSetup = await render()
    await settle()
    await open()

    // Empty query draws from history, not the clipped file list — no hint yet.
    expect(testSetup.captureCharFrame()).not.toContain("results are partial")

    await testSetup.mockInput.typeText("util")
    await settle()

    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("util.ts")
    expect(frame).toContain("results are partial")
  } finally {
    enumSpy.mockRestore()
  }
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

test("empty query ranks the most-used files by frecency across projects", async () => {
  const history = makeHistory()
  seed(history, join(dir, "src", "index.ts"), 3)
  seed(history, join(dir, "README.md"), 1)
  testSetup = await render(undefined, history)
  await settle()

  await open()
  await settle()
  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("index.ts")
  expect(frame).toContain("README.md")
  // The 3×-opened file outranks the 1×-opened one.
  expect(frame.indexOf("index.ts")).toBeLessThan(frame.indexOf("README.md"))
})

test("empty query shows an outside-workspace entry with a ~-path and badge", async () => {
  // Injected home holds a file that lives OUTSIDE the workspace root.
  browseDir = await mkdtemp(join(tmpdir(), "vsx-home-"))
  await mkdir(join(browseDir, "proj"))
  const outside = join(browseDir, "proj", "notes.txt")
  await writeFile(outside, "x")

  const history = makeHistory()
  seed(history, outside, 2)
  testSetup = await render(browseDir, history)
  await settle()

  await open()
  await settle()
  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("notes.txt")
  // Home-abbreviated path + the outside badge, not an ugly ../../ chain.
  expect(frame).toContain("~/proj/notes.txt")
  expect(frame).toContain("↗")
})

test("empty query filters out a history entry whose file no longer exists", async () => {
  const history = makeHistory()
  seed(history, join(dir, "README.md"), 1)
  // Never written to disk — should be stat-filtered out of the display.
  seed(history, join(dir, "src", "gone.ts"), 5)
  testSetup = await render(undefined, history)
  await settle()

  await open()
  await settle()
  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("README.md")
  expect(frame).not.toContain("gone.ts")
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

test("a typed-query favorite wins a same-tier tie against a non-favorite", async () => {
  // Both files prefix-match "util" (same tier); util.ts otherwise sorts first.
  const history = makeHistory()
  seed(history, join(dir, "src", "utils_helper.ts"), 5)
  testSetup = await render(undefined, history)
  await settle()
  await open()

  await testSetup.mockInput.typeText("util")
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("util.ts")
  expect(frame).toContain("utils_helper.ts")
  // The frecency boost lifts the favorite above the otherwise-higher util.ts.
  expect(frame.indexOf("utils_helper.ts")).toBeLessThan(frame.indexOf("util.ts"))
})

test("an outside match renders in the trailing group, never above an in-project exact match", async () => {
  browseDir = await mkdtemp(join(tmpdir(), "vsx-home-"))
  await mkdir(join(browseDir, "proj"))
  const outside = join(browseDir, "proj", "index.ts")
  await writeFile(outside, "x")

  const history = makeHistory()
  // Heavily favored, yet still pinned below the in-project index.ts by grouping.
  seed(history, outside, 10)
  testSetup = await render(browseDir, history)
  await settle()
  await open()

  await testSetup.mockInput.typeText("index.ts")
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("src/index.ts")
  expect(frame).toContain("~/proj/index.ts")
  expect(frame).toContain("↗")
  expect(frame.indexOf("src/index.ts")).toBeLessThan(frame.indexOf("~/proj/index.ts"))
})

test("a project file also in history appears once, not duplicated in the outside group", async () => {
  const history = makeHistory()
  seed(history, join(dir, "src", "util.ts"), 3)
  testSetup = await render(undefined, history)
  await settle()
  await open()

  await testSetup.mockInput.typeText("util")
  await settle()

  const frame = testSetup.captureCharFrame()
  // The in-workspace history entry boosts the project row but is not re-listed
  // in the outside group (its display path appears exactly once).
  expect(frame.split("src/util.ts").length - 1).toBe(1)
})

test("accept() opens and records through the store exactly once (no MRU double-count)", async () => {
  const history = makeHistory()
  // Wire the store's recorder to the SAME injected history, as App does.
  workbenchStore.setOpenRecorder(history.record)
  testSetup = await render(undefined, history)
  await settle()
  await open()

  await testSetup.mockInput.typeText("index")
  await settle()
  testSetup.mockInput.pressEnter()
  await settle()

  const abs = join(dir, "src", "index.ts")
  expect(activePath()).toBe(abs)
  // Recorded a single open — the removed mruRef never double-counted the store.
  expect(history.top(10).find((e) => e.path === abs)?.score).toBe(1)
})

test("Shift+Delete on a history row removes it from the list and the store", async () => {
  const history = makeHistory()
  seed(history, join(dir, "src", "index.ts"), 3)
  seed(history, join(dir, "README.md"), 1)
  testSetup = await render(undefined, history)
  await settle()
  await open()
  await settle()

  // index.ts is the top (selected) row; Shift+Delete evicts it.
  testSetup.mockInput.pressKey(DELETE, { shift: true })
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).not.toContain("index.ts")
  expect(frame).toContain("README.md")

  // Persisted: a fresh instance from the same dir no longer knows the path.
  await history.flush()
  const reloaded = makeHistory()
  expect(reloaded.top(10).some((e) => e.path === join(dir, "src", "index.ts"))).toBe(false)
  expect(reloaded.top(10).some((e) => e.path === join(dir, "README.md"))).toBe(true)
})

test("clicking the ✕ evicts the row without opening the file", async () => {
  const history = makeHistory()
  seed(history, join(dir, "README.md"), 1)
  testSetup = await render(undefined, history)
  await settle()
  await open()
  await settle()

  const cross = findGlyph("✕")
  expect(cross).not.toBeNull()
  await testSetup.mockMouse.click(cross!.x, cross!.y)
  await settle()

  // The row is gone AND nothing was opened (stopPropagation kept onAccept silent).
  expect(testSetup.captureCharFrame()).not.toContain("README.md")
  expect(activePath()).toBeNull()
})

test("Shift+Delete on a project (non-history) row is a no-op", async () => {
  const history = makeHistory()
  testSetup = await render(undefined, history)
  await settle()
  await open()

  await testSetup.mockInput.typeText("util")
  await settle()
  // The selected row is a project fuzzy result with no onEvict.
  testSetup.mockInput.pressKey(DELETE, { shift: true })
  await settle()

  // Nothing removed, nothing opened, no crash.
  expect(testSetup.captureCharFrame()).toContain("util.ts")
  expect(activePath()).toBeNull()
})

test("evicting the last row keeps the selection valid", async () => {
  const history = makeHistory()
  seed(history, join(dir, "README.md"), 1)
  testSetup = await render(undefined, history)
  await settle()
  await open()
  await settle()

  testSetup.mockInput.pressKey(DELETE, { shift: true })
  await settle()

  // Empty list, overlay still alive; navigation/accept can't crash or go OOB.
  expect(testSetup.captureCharFrame()).toContain("Go to file")
  testSetup.mockInput.pressArrow("down")
  testSetup.mockInput.pressArrow("up")
  testSetup.mockInput.pressEnter()
  await settle()
  expect(activePath()).toBeNull()
  expect(testSetup.captureCharFrame()).toContain("Go to file")
})

test("plain Delete (no Shift) does not evict a history row", async () => {
  const history = makeHistory()
  seed(history, join(dir, "README.md"), 1)
  testSetup = await render(undefined, history)
  await settle()
  await open()
  await settle()

  testSetup.mockInput.pressKey(DELETE)
  await settle()

  expect(testSetup.captureCharFrame()).toContain("README.md")
  expect(activePath()).toBeNull()
})

test("Shift+Delete evicts an outside-group row during a TYPED query, not just the empty-query list", async () => {
  browseDir = await mkdtemp(join(tmpdir(), "vsx-home-"))
  await mkdir(join(browseDir, "proj"))
  const outside = join(browseDir, "proj", "notes.txt")
  await writeFile(outside, "x")

  const history = makeHistory()
  seed(history, outside, 2)
  testSetup = await render(browseDir, history)
  await settle()
  await open()

  await testSetup.mockInput.typeText("notes")
  await settle()
  expect(testSetup.captureCharFrame()).toContain("notes.txt")

  testSetup.mockInput.pressKey(DELETE, { shift: true })
  await settle()

  expect(testSetup.captureCharFrame()).not.toContain("notes.txt")
  expect(activePath()).toBeNull()

  await history.flush()
  const reloaded = makeHistory()
  expect(reloaded.top(10).some((e) => e.path === outside)).toBe(false)
})

test("clicking the ✕ evicts an outside-group row during a TYPED query", async () => {
  browseDir = await mkdtemp(join(tmpdir(), "vsx-home-"))
  await mkdir(join(browseDir, "proj"))
  const outside = join(browseDir, "proj", "notes.txt")
  await writeFile(outside, "x")

  const history = makeHistory()
  seed(history, outside, 2)
  testSetup = await render(browseDir, history)
  await settle()
  await open()

  await testSetup.mockInput.typeText("notes")
  await settle()

  const cross = findGlyph("✕")
  expect(cross).not.toBeNull()
  await testSetup.mockMouse.click(cross!.x, cross!.y)
  await settle()

  expect(testSetup.captureCharFrame()).not.toContain("notes.txt")
  expect(activePath()).toBeNull()
})

test("empty query backfills to 15 rows even when some top-ranked entries are missing on disk", async () => {
  const history = makeHistory()
  // 3 top-ranked entries point at files never written to disk (missing); 15
  // more, lower-ranked, DO exist. The old cap-then-filter order (top(15) THEN
  // drop missing) would only backfill 12 of them; scanning a deeper buffer
  // first must still surface all 15 live ones.
  for (let i = 0; i < 3; i++) seed(history, join(dir, `missing-${i}.ts`), 100 - i)
  for (let i = 0; i < 15; i++) {
    const p = join(dir, `live-${i}.ts`)
    await writeFile(p, "x")
    seed(history, p, 50 - i)
  }
  testSetup = await render(undefined, history)
  await settle()
  await open()
  await settle()

  expect(quickRowCount()).toBe(15)
})

test("a maxed frecency boost on a PREFIX match never overtakes an unboosted EXACT match", async () => {
  // "index.tsx" PREFIX-matches "index.ts" ("index.tsx".startsWith("index.ts"));
  // src/index.ts EXACT-matches it. Boosting the PREFIX match to the ceiling must
  // still leave it below the tier gap (~131072) separating it from EXACT.
  await writeFile(join(dir, "index.tsx"), "export {}\n")
  const history = makeHistory()
  seed(history, join(dir, "index.tsx"), 500)
  testSetup = await render(undefined, history)
  await settle()
  await open()

  await testSetup.mockInput.typeText("index.ts")
  await settle()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("src/index.ts")
  expect(frame).toContain("index.tsx")
  expect(frame.indexOf("src/index.ts")).toBeLessThan(frame.indexOf("index.tsx"))
})

// Pins the MAJOR fix directly: real fuzzy scores can't organically reach the
// adversarial boundary this guards against (a description-only match's raw DP
// score never gets anywhere near the TIER_CONTAINS clamp for any realistic
// query/path length — the clamp only matters for query lengths in the
// thousands, far past any real filename), so scoreAndSort is mocked to
// engineer the EXACT boundary the review flagged: a description-only match
// clamped just under the tier seam, maxed out on frecency, versus an
// unboosted label match just above it. Proves QuickInput's isLabelMatch gate,
// not the fuzzy engine's real-world score distribution.
test("a maxed frecency boost cannot lift a description-only match across the label-tier seam", async () => {
  const TIER_CONTAINS = 1 << 16
  await writeFile(join(dir, "attacker.ts"), "x")
  await writeFile(join(dir, "victim.ts"), "x")

  const fakeScoreAndSort = (<T,>(_query: string, items: T[], getLabel: (item: T) => { label: string; description?: string }) =>
    items.map((item) => {
      const isAttacker = getLabel(item).description?.endsWith("attacker.ts")
      return {
        item,
        score: isAttacker ? TIER_CONTAINS - 1 : TIER_CONTAINS + 1,
        labelMatches: isAttacker ? [] : ([[0, 1]] as [number, number][]),
        descriptionMatches: isAttacker ? ([[0, 1]] as [number, number][]) : [],
      }
    })) satisfies typeof fuzzy.scoreAndSort
  const scoreSpy = spyOn(fuzzy, "scoreAndSort").mockImplementation(fakeScoreAndSort)
  try {
    const history = makeHistory()
    seed(history, join(dir, "attacker.ts"), 500) // maxes out the frecency boost
    testSetup = await render(undefined, history)
    await settle()
    await open()

    await testSetup.mockInput.typeText("x")
    await settle()

    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("victim.ts")
    expect(frame).toContain("attacker.ts")
    // The boosted description-only match must never cross into label territory.
    expect(frame.indexOf("victim.ts")).toBeLessThan(frame.indexOf("attacker.ts"))
  } finally {
    scoreSpy.mockRestore()
  }
})
