import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { workbenchStore } from "../model/workbench"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { ModalProvider } from "../workbench/ModalProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { CommitLog, formatRelativeDate, parseRefs } from "./CommitLog"

let root: string
let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

async function sh(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [, err, code] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`)
}

async function write(rel: string, content: string): Promise<void> {
  await writeFile(join(root, rel), content)
}

// root -> change a + add b -> rename b to c. HEAD sits on the rename commit.
async function buildFixture(): Promise<void> {
  await write("a.txt", "a1\na2\na3\n")
  await sh(["add", "a.txt"])
  await sh(["commit", "-qm", "root subject"])
  await write("a.txt", "a1\naX\na3\n")
  await write("b.txt", "b1\nb2\n")
  await sh(["add", "-A"])
  await sh(["commit", "-qm", "change a add b"])
  await sh(["mv", "b.txt", "c.txt"])
  await sh(["commit", "-qm", "rename b to c"])
}

beforeEach(async () => {
  workbenchStore.reset()
  root = await mkdtemp(join(tmpdir(), "vsx-clog-"))
  await sh(["init", "-q"])
  await sh(["config", "user.email", "a@b.com"])
  await sh(["config", "user.name", "Tester"])
  await sh(["config", "commit.gpgsign", "false"])
})

afterEach(async () => {
  testSetup?.renderer.destroy()
  testSetup = undefined
  workbenchStore.reset()
  await Bun.sleep(30)
  await rm(root, { recursive: true, force: true })
  mock.restore()
})

async function renderLog(pageSize?: number, dims = { width: 80, height: 20 }) {
  testSetup = await testRender(
    <CommandsProvider>
      <OverlayProvider>
        <ModalProvider>
          <box width={dims.width} height={dims.height}>
            <CommitLog workspaceRoot={root} focused pageSize={pageSize} />
          </box>
        </ModalProvider>
      </OverlayProvider>
    </CommandsProvider>,
    dims,
  )
  return testSetup
}

// A committed re-render must land between two keypresses: useKeyboard's handler
// is bound (via useEffectEvent) to the LATEST committed render, so a selection
// move only reaches the next keypress once React has flushed the state update.
async function tick() {
  await testSetup!.flush()
  await Bun.sleep(10)
  await testSetup!.flush()
}

async function waitForText(text: string, timeoutMs = 4000) {
  const setup = testSetup!
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await setup.flush()
    if (setup.captureCharFrame().includes(text)) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for "${text}"\n${setup.captureCharFrame()}`)
}

async function waitForGone(text: string, timeoutMs = 4000) {
  const setup = testSetup!
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await setup.flush()
    if (!setup.captureCharFrame().includes(text)) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for "${text}" to disappear\n${setup.captureCharFrame()}`)
}

describe("formatRelativeDate", () => {
  const now = new Date("2026-07-01T12:00:00Z")
  test("recent buckets", () => {
    expect(formatRelativeDate(new Date(now.getTime() - 5_000), now)).toBe("just now")
    expect(formatRelativeDate(new Date(now.getTime() - 5 * 60_000), now)).toBe("5m ago")
    expect(formatRelativeDate(new Date(now.getTime() - 3 * 3_600_000), now)).toBe("3h ago")
    expect(formatRelativeDate(new Date(now.getTime() - 2 * 86_400_000), now)).toBe("2d ago")
  })
  test("beyond ~30 days falls back to a short absolute date", () => {
    const old = new Date("2026-01-05T00:00:00")
    expect(formatRelativeDate(old, now)).toBe("Jan 5")
  })
})

describe("parseRefs", () => {
  test("strips HEAD -> and flags the current tip", () => {
    expect(parseRefs(["HEAD -> main", "origin/main"])).toEqual({
      badges: ["main", "origin/main"],
      isHead: true,
    })
  })
  test("strips tag: prefixes and handles a detached HEAD", () => {
    expect(parseRefs(["HEAD", "tag: v1.0"])).toEqual({
      badges: ["HEAD", "v1.0"],
      isHead: true,
    })
  })
  test("no HEAD ref means not the current tip", () => {
    expect(parseRefs(["origin/feature"])).toEqual({ badges: ["origin/feature"], isHead: false })
  })
})

describe("CommitLog rendering + interaction", () => {
  test("expanding COMMITS lists subjects, short hashes, and the HEAD ref badge", async () => {
    await buildFixture()
    await renderLog()
    await waitForText("COMMITS")

    testSetup!.mockInput.pressEnter() // expand section (selection starts on it)
    await waitForText("rename b to c")

    const frame = testSetup!.captureCharFrame()
    expect(frame).toContain("change a add b")
    expect(frame).toContain("root subject")
    expect(frame).toContain("[main]") // HEAD branch badge

    const head = (await new (await import("../services/git")).GitService(root).log({ maxEntries: 1 }))[0]
    expect(frame).toContain(head.hash.slice(0, 7)) // short hash of HEAD commit
  })

  test("expanding the rename commit lists its changed file with an R status", async () => {
    await buildFixture()
    await renderLog()
    await waitForText("COMMITS")
    testSetup!.mockInput.pressEnter()
    await waitForText("rename b to c")

    testSetup!.mockInput.pressArrow("down") // -> HEAD (rename) commit
    await tick()
    testSetup!.mockInput.pressEnter() // expand its files
    await waitForText("c.txt")

    const frame = testSetup!.captureCharFrame()
    // The renamed destination is shown; its status letter is R.
    const line = frame.split("\n").find((l) => l.includes("c.txt"))!
    expect(line).toContain("R")
  })

  test("expanding the root commit shows its files as added against the empty tree", async () => {
    await buildFixture()
    await renderLog()
    await waitForText("COMMITS")
    testSetup!.mockInput.pressEnter()
    await waitForText("root subject")

    // Rows: section, head, second, root  -> down x3 to the root commit.
    testSetup!.mockInput.pressArrow("down")
    await tick()
    testSetup!.mockInput.pressArrow("down")
    await tick()
    testSetup!.mockInput.pressArrow("down")
    await tick()
    testSetup!.mockInput.pressEnter()
    await waitForText("a.txt")

    const line = testSetup!.captureCharFrame().split("\n").find((l) => l.includes("a.txt"))!
    expect(line).toContain("A")
  })

  test("activating a file row opens a commitDiff tab with the right refs + absolute path", async () => {
    await buildFixture()
    const { GitService } = await import("../services/git")
    const git = new GitService(root)
    const head = (await git.log({ maxEntries: 1 }))[0]

    await renderLog()
    await waitForText("COMMITS")
    testSetup!.mockInput.pressEnter()
    await waitForText("rename b to c")
    testSetup!.mockInput.pressArrow("down") // HEAD commit
    await tick()
    testSetup!.mockInput.pressEnter() // expand files
    await waitForText("c.txt")
    testSetup!.mockInput.pressArrow("down") // the c.txt file row
    await tick()
    testSetup!.mockInput.pressEnter() // open its diff
    await tick()

    const tabs = workbenchStore.getState().groups[0].tabs
    const tab = tabs.find((t) => t.kind === "commitDiff")
    expect(tab).toBeTruthy()
    if (!tab || tab.kind !== "commitDiff") throw new Error("expected commitDiff tab")
    // ABSOLUTE path, rooted at git's canonical (symlink-resolved) repo root.
    expect(tab.filePath).toBe(join(realpathSync(root), "c.txt"))
    expect(tab.newRef).toBe(head.hash)
    expect(tab.oldRef).toBe(head.parents[0]) // parent of the rename commit
    expect(tab.label).toContain(head.hash.slice(0, 7))
  })

  test("Load more pages in older commits without duplicating", async () => {
    await buildFixture()
    await renderLog(2) // page size 2 -> initial load omits the root commit

    await waitForText("COMMITS")
    testSetup!.mockInput.pressEnter()
    await waitForText("rename b to c")
    let frame = testSetup!.captureCharFrame()
    expect(frame).toContain("change a add b")
    expect(frame).not.toContain("root subject") // not yet paged in
    expect(frame).toContain("Load more")

    // Rows: section, head, second, loadMore -> down x3 to Load more.
    testSetup!.mockInput.pressArrow("down")
    await tick()
    testSetup!.mockInput.pressArrow("down")
    await tick()
    testSetup!.mockInput.pressArrow("down")
    await tick()
    testSetup!.mockInput.pressEnter()
    await waitForText("root subject")

    frame = testSetup!.captureCharFrame()
    // No duplicate of the already-shown commits after paging.
    expect(frame.split("rename b to c").length - 1).toBe(1)
    expect(frame.split("change a add b").length - 1).toBe(1)
    expect(frame).not.toContain("Load more") // reached the root; nothing older
  })
})

// HEAD carries a multi-line body plus a two-file change so the overlay can show
// the full message, author, and computed stats.
async function buildDetailFixture(): Promise<void> {
  await write("a.txt", "a1\na2\na3\n")
  await sh(["add", "a.txt"])
  await sh(["commit", "-qm", "root subject"])
  await write("a.txt", "a1\naEDIT\na3\na4\n")
  await write("newfile.txt", "n1\nn2\n")
  await sh(["add", "-A"])
  await sh([
    "commit",
    "-q",
    "-m",
    "detailed subject line",
    "-m",
    "This is a longer body paragraph.",
  ])
}

async function openHeadDetails(): Promise<void> {
  await buildDetailFixture()
  await renderLog()
  await waitForText("COMMITS")
  testSetup!.mockInput.pressEnter() // expand the COMMITS section
  await waitForText("detailed subject line")
  testSetup!.mockInput.pressArrow("down") // select the HEAD (detailed) commit
  await tick()
  testSetup!.mockInput.pressKey("i") // open the details overlay
  await waitForText("This is a longer body paragraph.")
}

describe("CommitDetailsOverlay wiring", () => {
  test("i opens the overlay with the full message, author, email, and stats", async () => {
    await openHeadDetails()

    const frame = testSetup!.captureCharFrame()
    expect(frame).toContain("detailed subject line")
    expect(frame).toContain("This is a longer body paragraph.")
    expect(frame).toContain("Tester")
    expect(frame).toContain("a@b.com")

    // Stats fetch lazily after open; wait for the "N files changed" line.
    await waitForText("changed")
    expect(testSetup!.captureCharFrame()).toContain("+")
  })

  test("Escape closes the overlay and list keys work again", async () => {
    await openHeadDetails()

    testSetup!.mockInput.pressEscape()
    // Wait for the overlay to fully unmount (and isOverlayOpen to settle back to
    // false) before pressing a list key — a keypress while still gated is lost.
    // Generous deadlines: the git fixture + overlay open/close + poll chain runs
    // close to bun:test's 5s default under load (seen finishing at ~4.7s), so the
    // per-test timeout is raised well above the summed poll budget.
    await waitForGone("This is a longer body paragraph.", 8000)
    await tick()

    // The list regained its key handling: Enter now toggles the commit's files.
    testSetup!.mockInput.pressEnter()
    await waitForText("newfile.txt", 8000)
  }, 15000)

  test("the open overlay gates the list's own keys", async () => {
    await openHeadDetails()

    // Enter is swallowed while the overlay owns the screen: it must not toggle
    // the changed-files list, and the overlay stays open.
    testSetup!.mockInput.pressEnter()
    await tick()
    expect(testSetup!.captureCharFrame()).toContain("This is a longer body paragraph.")
    expect(testSetup!.captureCharFrame()).not.toContain("newfile.txt")
  })
})
