import { RGBA, type CapturedFrame, type CapturedLine, type ScrollBarRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { parsePatch } from "diff"
import { realpathSync } from "node:fs"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { documentRegistry } from "../model/documents"
import { workbenchStore, type DiffTab } from "../model/workbench"
import { GitService } from "../services/git"
import { theme } from "../theme"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { WatchersProvider } from "../workbench/watchers"
import {
  buildDiffPatch,
  computeChangeBlockOffsets,
  DiffPane,
  FULL_CONTEXT_MAX_LINES,
  pickHunkTarget,
  resolveDiff,
  resolveDiffContent,
} from "./DiffPane"

let root: string
let git: GitService
let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

async function sh(args: string[], stdin?: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdin: stdin !== undefined ? "pipe" : undefined,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (stdin !== undefined) {
    proc.stdin.write(stdin)
    await proc.stdin.end()
  }
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

/** Build a diff tab pointing at an ABSOLUTE file path under the repo. */
function diffTab(rel: string, diffKind: "staged" | "unstaged", oldRel?: string): DiffTab {
  const filePath = join(root, rel)
  return {
    kind: "diff",
    path: `diff::${diffKind}::${root}::${filePath}`,
    filePath,
    oldPath: oldRel ? join(root, oldRel) : undefined,
    diffKind,
    repoRoot: root,
    preview: false,
    pinned: false,
  }
}

beforeEach(async () => {
  workbenchStore.reset()
  root = await mkdtemp(join(tmpdir(), "vsx-diff-"))
  await sh(["init", "-q", "-b", "main"])
  await sh(["config", "user.email", "a@b.com"])
  await sh(["config", "user.name", "Tester"])
  await sh(["config", "commit.gpgsign", "false"])
  git = new GitService(root)
})

afterEach(async () => {
  testSetup?.renderer.destroy()
  testSetup = undefined
  workbenchStore.reset()
  await Bun.sleep(30)
  await rm(root, { recursive: true, force: true })
  mock.restore()
})

async function renderActiveDiff(dims = { width: 80, height: 12 }) {
  testSetup = await testRender(
    <OverlayProvider>
      <box width={dims.width} height={dims.height}>
        <CommandsProvider>
          <DiffPane focused />
        </CommandsProvider>
      </box>
    </OverlayProvider>,
    dims,
  )
  return testSetup
}

/** Render the active diff under a real WatchersProvider so the shared git watcher drives refreshes. */
async function renderActiveDiffWithWatchers(dims = { width: 80, height: 12 }) {
  testSetup = await testRender(
    <OverlayProvider>
      <WatchersProvider workspaceRoot={root}>
        <box width={dims.width} height={dims.height}>
          <CommandsProvider>
            <DiffPane focused />
          </CommandsProvider>
        </box>
      </WatchersProvider>
    </OverlayProvider>,
    dims,
  )
  return testSetup
}

/** The DiffPane's scroll container, for reading scrollTop after n/p navigation. */
function scrollbox(): { scrollTop: number } {
  const out: { scrollTop: number }[] = []
  const walk = (node: { getChildren(): unknown[]; constructor: { name: string } }) => {
    if (node.constructor.name === "ScrollBoxRenderable") out.push(node as never)
    for (const child of node.getChildren()) walk(child as never)
  }
  walk(testSetup!.renderer.root as never)
  if (out.length !== 1) throw new Error(`expected exactly one scrollbox, found ${out.length}`)
  return out[0]
}

/** Toggle the diff view until it matches `want` (initial view depends on session state). */
async function ensureView(want: "split" | "unified") {
  const label = want === "split" ? "Split" : "Unified"
  for (let i = 0; i < 2; i++) {
    await testSetup!.flush()
    if (testSetup!.captureCharFrame().includes(label)) return
    testSetup!.mockInput.pressKey("v")
    for (let j = 0; j < 6; j++) await testSetup!.flush()
    await Bun.sleep(20)
  }
  await waitForText(label)
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

/** Per-column glyphs for a captured row. */
function rowChars(line: CapturedLine): string[] {
  const out: string[] = []
  for (const span of line.spans) for (const ch of span.text) out.push(ch)
  return out
}

/** Per-column background colors for a captured row (all glyphs here are width 1). */
function rowBackgrounds(line: CapturedLine): RGBA[] {
  const out: RGBA[] = []
  for (const span of line.spans) for (let i = 0; i < span.text.length; i++) out.push(span.bg)
  return out
}

function rgbEquals(a: RGBA, hex: string): boolean {
  const [r, g, b] = a.toInts()
  const [er, eg, eb] = RGBA.fromHex(hex).toInts()
  return r === er && g === eg && b === eb
}

/**
 * Poll `captureSpans()` until `predicate` matches a frame, returning that frame.
 * Intra-line emphasis is applied via `onChunks`, which only runs inside the async
 * syntax-highlight pipeline — a cold tree-sitter worker can take several seconds
 * to initialize the first time it's exercised in a test run, so this needs a much
 * longer bound than `waitForText`'s (plain content renders immediately via
 * `drawUnstyledText`, well before any highlighting completes).
 */
async function waitForSpans(
  predicate: (frame: CapturedFrame) => boolean,
  timeoutMs = 20000,
): Promise<CapturedFrame> {
  const setup = testSetup!
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await setup.flush()
    const frame = setup.captureSpans()
    if (predicate(frame)) return frame
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for a span condition\n${setup.captureCharFrame()}`)
}

describe("resolveDiff content resolution", () => {
  test("unstaged: old = index/HEAD, new = working tree", async () => {
    await write("a.txt", "alpha\nbeta\ngamma\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "alpha\nBETA_CHANGED\ngamma\n")

    const { oldCode, newCode } = await resolveDiff(git, diffTab("a.txt", "unstaged"))
    expect(oldCode).toBe("alpha\nbeta\ngamma\n")
    expect(newCode).toBe("alpha\nBETA_CHANGED\ngamma\n")
  })

  test("staged: old = HEAD, new = index blob", async () => {
    await write("a.txt", "one\ntwo\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "one\nTWO_STAGED\n")
    await sh(["add", "a.txt"])
    // Then dirty the working tree further — staged diff must ignore this.
    await write("a.txt", "one\nWORKTREE_ONLY\n")

    const { oldCode, newCode } = await resolveDiff(git, diffTab("a.txt", "staged"))
    expect(oldCode).toBe("one\ntwo\n")
    expect(newCode).toBe("one\nTWO_STAGED\n")
  })

  test("added file (staged, no HEAD entry) has empty old content", async () => {
    await write("seed.txt", "seed\n")
    await sh(["add", "seed.txt"])
    await sh(["commit", "-qm", "init"])
    await write("new.txt", "brand new\n")
    await sh(["add", "new.txt"])

    const { oldCode, newCode } = await resolveDiff(git, diffTab("new.txt", "staged"))
    expect(oldCode).toBe("")
    expect(newCode).toBe("brand new\n")
  })

  test("staged rename with an edit: old = original content at oldPath, new = edited index blob", async () => {
    await write("old.txt", "one\ntwo\nthree\n")
    await sh(["add", "old.txt"])
    await sh(["commit", "-qm", "init"])
    await sh(["mv", "old.txt", "new.txt"])
    await write("new.txt", "one\nTWO_EDITED\nthree\n")
    await sh(["add", "new.txt"])

    const { oldCode, newCode } = await resolveDiff(git, diffTab("new.txt", "staged", "old.txt"))
    expect(oldCode).toBe("one\ntwo\nthree\n")
    expect(newCode).toBe("one\nTWO_EDITED\nthree\n")

    // The regression this guards: without oldPath threaded through, `old` was
    // fetched from HEAD at the NEW path (empty, since HEAD only has the file
    // under its old name), so every line — not just the edited one — read as
    // added.
    const { patch } = buildDiffPatch(oldCode, newCode, "new.txt")
    const [file] = parsePatch(patch)
    const addedLines = file.hunks.flatMap((h) => h.lines).filter((l) => l.startsWith("+"))
    const removedLines = file.hunks.flatMap((h) => h.lines).filter((l) => l.startsWith("-"))
    expect(addedLines).toEqual(["+TWO_EDITED"])
    expect(removedLines).toEqual(["-two"])
  })

  test("deleted file (working tree gone) has empty new content", async () => {
    await write("gone.txt", "to be removed\n")
    await sh(["add", "gone.txt"])
    await sh(["commit", "-qm", "init"])
    await unlink(join(root, "gone.txt"))

    const { oldCode, newCode } = await resolveDiff(git, diffTab("gone.txt", "unstaged"))
    expect(oldCode).toBe("to be removed\n")
    expect(newCode).toBe("")
  })

  test("unstaged new side reflects unsaved edits from an open Document", async () => {
    await write("live.txt", "saved line\n")
    await sh(["add", "live.txt"])
    await sh(["commit", "-qm", "init"])

    const filePath = join(root, "live.txt")
    const doc = await documentRegistry.openDocument(filePath)
    doc.setText("edited but unsaved\n", "edit")

    const { oldCode, newCode } = await resolveDiff(git, diffTab("live.txt", "unstaged"))
    expect(oldCode).toBe("saved line\n")
    expect(newCode).toBe("edited but unsaved\n") // in-memory edit, not the on-disk blob

    documentRegistry.releaseDocument(filePath)
  })

  test("SCM-opened diff sees a live edit from a FileTree open (path shapes converge)", async () => {
    await write("shared.txt", "on disk\n")
    await sh(["add", "shared.txt"])
    await sh(["commit", "-qm", "init"])

    // FileTree shape: opens the file by ABSOLUTE path.
    const fileTreePath = join(root, "shared.txt")
    const doc = await documentRegistry.openDocument(fileTreePath)
    doc.setText("live edit\n", "edit")

    // ScmPanel shape: git-status-relative path joined onto the repo root. It must
    // resolve to the SAME absolute registry key, so the diff reflects the live
    // buffer instead of stale disk content. `diffTab` performs the join(root, rel).
    const { newCode } = await resolveDiff(git, diffTab("shared.txt", "unstaged"))
    expect(newCode).toBe("live edit\n")

    documentRegistry.releaseDocument(fileTreePath)
  })
})

describe("resolveDiffContent for commitDiff tabs", () => {
  test("resolves old/new content from the two commit refs", async () => {
    await write("a.txt", "one\ntwo\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "first"])
    const parent = (await git.log({ maxEntries: 1 }))[0].hash
    await write("a.txt", "one\nTWO_CHANGED\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "second"])
    const commit = (await git.log({ maxEntries: 1 }))[0].hash

    const { oldCode, newCode } = await resolveDiffContent(git, {
      kind: "commitDiff",
      path: `commitDiff::${root}::${commit}::${join(root, "a.txt")}`,
      filePath: join(root, "a.txt"),
      repoRoot: root,
      oldRef: parent,
      newRef: commit,
      label: "a.txt (second)",
      preview: false,
      pinned: false,
    })
    expect(oldCode).toBe("one\ntwo\n")
    expect(newCode).toBe("one\nTWO_CHANGED\n")
  })

  test("root commit: empty-tree old ref yields empty old content", async () => {
    await write("root.txt", "born\n")
    await sh(["add", "root.txt"])
    await sh(["commit", "-qm", "root"])
    const commit = (await git.log({ maxEntries: 1 }))[0].hash

    const { oldCode, newCode } = await resolveDiffContent(git, {
      kind: "commitDiff",
      path: `commitDiff::${root}::${commit}::${join(root, "root.txt")}`,
      filePath: join(root, "root.txt"),
      repoRoot: root,
      oldRef: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      newRef: commit,
      label: "root.txt (root)",
      preview: false,
      pinned: false,
    })
    expect(oldCode).toBe("")
    expect(newCode).toBe("born\n")
  })
})

describe("DiffPane renders a commitDiff tab opened via openCommitDiff", () => {
  test("resolves and shows both sides of a commit-vs-parent diff", async () => {
    await write("a.txt", "alpha\nbeta\ngamma\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "first"])
    const parent = (await git.log({ maxEntries: 1 }))[0].hash
    await write("a.txt", "alpha\nBETACHANGED\ngamma\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "second"])
    const commit = (await git.log({ maxEntries: 1 }))[0].hash

    workbenchStore.openCommitDiff(
      join(root, "a.txt"),
      parent,
      commit,
      root,
      `a.txt (${commit.slice(0, 7)})`,
      { preview: false },
    )
    await renderActiveDiff()

    await waitForText("BETACHANGED") // after side
    const frame = testSetup!.captureCharFrame()
    expect(frame).toContain("beta") // before side
    expect(frame).toContain(commit.slice(0, 7)) // header label carries the short hash
  })
})

describe("DiffPane refreshes on external git changes via the shared watcher", () => {
  test("an unstaged diff re-resolves after an outside `git add` (old side catches up)", async () => {
    // discoverRepositories realpath-resolves the root, so the shared watcher emits
    // the realpath'd root; the tab's repoRoot must match for the refresh to fire.
    const realRoot = realpathSync(root)
    await write("a.txt", "alpha\nbeta\ngamma\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "alpha\nBETACHANGED\ngamma\n")

    workbenchStore.openDiff(join(realRoot, "a.txt"), "unstaged", realRoot, { preview: false })
    await renderActiveDiffWithWatchers()
    await waitForText("BETACHANGED") // the unstaged diff is showing

    // An outside process stages the change: the index (old side) now matches the
    // working tree, so the pane must re-resolve to "No changes".
    await sh(["add", "a.txt"])
    await waitForText("No changes")
  })
})

describe("DiffPane reloads in the background without unmounting", () => {
  test("a no-op reload keeps the scrollbox mounted, its scroll position, and never flashes Loading", async () => {
    const base = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n"
    await write("big.txt", base)
    await sh(["add", "big.txt"])
    await sh(["commit", "-qm", "init"])

    // An open Document drives the "new" side of an unstaged diff, so a setText fires
    // a deterministic live-edit reload (onDidChange -> reloadVersion bump).
    const filePath = join(root, "big.txt")
    const doc = await documentRegistry.openDocument(filePath)
    const modified = base.replace("line 5", "LINE_FIVE_EDIT")
    doc.setText(modified, "edit")

    workbenchStore.openDiff(filePath, "unstaged", root, { preview: false })
    await renderActiveDiff({ width: 80, height: 8 })
    await waitForText("LINE_FIVE_EDIT")

    const sb = scrollbox()
    sb.scrollTop = 12
    for (let i = 0; i < 4; i++) await testSetup!.flush()
    const scrollBefore = sb.scrollTop
    expect(scrollBefore).toBeGreaterThan(0)

    // Re-resolving to identical content must be invisible: capture every frame
    // across the reload and assert the loading placeholder never appears.
    const frames: string[] = []
    doc.setText(modified, "edit")
    for (let i = 0; i < 8; i++) {
      await testSetup!.flush()
      frames.push(testSetup!.captureCharFrame())
      await Bun.sleep(10)
      await testSetup!.flush()
      frames.push(testSetup!.captureCharFrame())
    }

    expect(frames.some((f) => f.includes("Loading"))).toBe(false)
    const sbAfter = scrollbox()
    expect(sbAfter).toBe(sb) // same scrollbox object — never unmounted
    expect(sbAfter.scrollTop).toBe(scrollBefore) // scroll position preserved

    documentRegistry.releaseDocument(filePath)
  })

  test("a live-edit reload to different content updates the rendered diff", async () => {
    const base = "alpha\nbeta\ngamma\n"
    await write("c.txt", base)
    await sh(["add", "c.txt"])
    await sh(["commit", "-qm", "init"])

    const filePath = join(root, "c.txt")
    const doc = await documentRegistry.openDocument(filePath)
    doc.setText("alpha\nFIRST_EDIT\ngamma\n", "edit")

    workbenchStore.openDiff(filePath, "unstaged", root, { preview: false })
    await renderActiveDiff()
    await waitForText("FIRST_EDIT")

    doc.setText("alpha\nSECOND_EDIT\ngamma\n", "edit")
    await waitForText("SECOND_EDIT")
    expect(testSetup!.captureCharFrame()).not.toContain("FIRST_EDIT")

    documentRegistry.releaseDocument(filePath)
  })

  test("switching to a different diff tab renders the new tab's content", async () => {
    await write("a.txt", "alpha\nbeta\n")
    await write("b.txt", "uno\ndos\n")
    await sh(["add", "."])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "alpha\nA_EDIT\n")
    await write("b.txt", "uno\nB_EDIT\n")

    workbenchStore.openDiff(join(root, "a.txt"), "unstaged", root, { preview: false })
    await renderActiveDiff()
    await waitForText("A_EDIT")

    // An identity change (new tab) is allowed to show the placeholder; what matters
    // is that the new tab's content resolves and renders, replacing the old.
    workbenchStore.openDiff(join(root, "b.txt"), "unstaged", root, { preview: false })
    await waitForText("B_EDIT")
    expect(testSetup!.captureCharFrame()).not.toContain("A_EDIT")
  })

  test("a background resolve error keeps the last-good diff visible", async () => {
    const base = "alpha\nbeta\ngamma\n"
    await write("d.txt", base)
    await sh(["add", "d.txt"])
    await sh(["commit", "-qm", "init"])

    const filePath = join(root, "d.txt")
    const doc = await documentRegistry.openDocument(filePath)
    doc.setText("alpha\nGOOD_EDIT\ngamma\n", "edit")

    workbenchStore.openDiff(filePath, "unstaged", root, { preview: false })
    await renderActiveDiff()
    await waitForText("GOOD_EDIT")

    // Break the repo so the next reload's git lookup (old side) throws mid-flight.
    await rm(join(root, ".git"), { recursive: true, force: true })
    doc.setText("alpha\nWHILE_BROKEN\ngamma\n", "edit")

    for (let i = 0; i < 10; i++) {
      await testSetup!.flush()
      await Bun.sleep(10)
    }
    const frame = testSetup!.captureCharFrame()
    expect(frame).toContain("GOOD_EDIT") // last-good content stayed mounted
    expect(frame).not.toContain("WHILE_BROKEN") // the failed resolve did not land

    documentRegistry.releaseDocument(filePath)
  })
})

describe("pickHunkTarget", () => {
  test("next moves to the following hunk and wraps", () => {
    expect(pickHunkTarget([0, 7, 20], 0, 1)).toBe(7)
    expect(pickHunkTarget([0, 7, 20], 7, 1)).toBe(20)
    expect(pickHunkTarget([0, 7, 20], 20, 1)).toBe(0) // wrap to first
  })

  test("prev moves to the preceding hunk and wraps", () => {
    expect(pickHunkTarget([0, 7, 20], 20, -1)).toBe(7)
    expect(pickHunkTarget([0, 7, 20], 7, -1)).toBe(0)
    expect(pickHunkTarget([0, 7, 20], 0, -1)).toBe(20) // wrap to last
  })

  test("no offsets yields null", () => {
    expect(pickHunkTarget([], 0, 1)).toBeNull()
  })
})

describe("buildDiffPatch", () => {
  test("full context: keeps every unchanged line between and around changes", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const old = lines.join("\n") + "\n"
    const next = [...lines]
    next[2] = "CHANGE_A"
    next[27] = "CHANGE_B"
    const { patch, fullContext } = buildDiffPatch(old, next.join("\n") + "\n", "f.txt")
    expect(fullContext).toBe(true)
    // A 3-line-context patch would drop the far-apart unchanged middle lines; full
    // context must retain them (context rows carry a leading space).
    expect(patch).toContain(" line 14")
    expect(patch).toContain(" line 0")
    expect(patch).toContain(" line 29")
    expect(patch).toContain("+CHANGE_A")
    expect(patch).toContain("+CHANGE_B")
    // The whole file collapses into a single hunk under infinite context.
    const parsed = parsePatch(patch)
    expect(parsed[0].hunks.length).toBe(1)
  })

  test("over the guard threshold: falls back to a compact hunked patch", () => {
    const big = Array.from({ length: FULL_CONTEXT_MAX_LINES + 10 }, (_, i) => `l${i}`)
    const old = big.join("\n") + "\n"
    const next = [...big]
    next[0] = "CHANGED_TOP"
    next[next.length - 1] = "CHANGED_BOTTOM"
    const { patch, fullContext } = buildDiffPatch(old, next.join("\n") + "\n", "big.txt")
    expect(fullContext).toBe(false)
    // Two separated changes in a large file must remain two hunks (3-line context),
    // not one giant full-file hunk.
    expect(parsePatch(patch)[0].hunks.length).toBe(2)
    // A far-away unchanged middle line is dropped by the compact view.
    expect(patch).not.toContain(" l2500")
  })
})

describe("computeChangeBlockOffsets", () => {
  // 30-line file with two separated single-line edits, full-file context.
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
  const next = [...lines]
  next[5] = "C5"
  next[25] = "C25"
  const { patch } = buildDiffPatch(lines.join("\n") + "\n", next.join("\n") + "\n", "f.txt")

  test("unified: a target at the first row of each change run", () => {
    // rows 0-4 context, row 5 `-line 5`, row 6 `+C5`, rows 7-25 context (lines 6-24),
    // row 26 `-line 25`. Two blocks, at rows 5 and 26.
    expect(computeChangeBlockOffsets(patch, "unified")).toEqual([5, 26])
  })

  test("split: change runs collapse to one row (removed/added side by side)", () => {
    // Each single-line change occupies one visual row per side, so the second block
    // lands 20 rows earlier than in unified.
    expect(computeChangeBlockOffsets(patch, "split")).toEqual([5, 25])
  })

  test("no changes yields no targets", () => {
    const same = "a\nb\nc\n"
    const { patch: p } = buildDiffPatch(same, same, "f.txt")
    expect(computeChangeBlockOffsets(p, "unified")).toEqual([])
    expect(computeChangeBlockOffsets(p, "split")).toEqual([])
  })

  test("no-trailing-newline change stays one visual block in both views", () => {
    // old lacks a trailing newline, new adds one: the hunk is
    // [" a", "-b", "\\ No newline at end of file", "+c"]. buildSplitView skips the
    // "\\" marker and renders the remove/add as adjacent rows = ONE visual block,
    // so split must yield a SINGLE offset (not two) — otherwise n stops twice
    // inside one change. Unified likewise treats the marker as run-preserving.
    const { patch } = buildDiffPatch("a\nb", "a\nc\n", "f.txt")
    expect(computeChangeBlockOffsets(patch, "split")).toEqual([1])
    expect(computeChangeBlockOffsets(patch, "unified")).toEqual([1])
  })
})

describe("DiffPane rendering + interaction", () => {
  test("shows a placeholder when no diff tab is active", async () => {
    await renderActiveDiff()
    await waitForText("No diff open")
  })

  test("unstaged modification renders both before and after content in split view", async () => {
    await write("a.txt", "alpha\nbeta\ngamma\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "alpha\nBETACHANGED\ngamma\n")

    workbenchStore.openDiff(join(root, "a.txt"), "unstaged", root, { preview: false })
    await renderActiveDiff()

    await waitForText("BETACHANGED") // the "after" side
    expect(testSetup!.captureCharFrame()).toContain("beta") // the "before" side
  })

  test("staged rename header shows 'oldname → newname'", async () => {
    await write("old.txt", "one\ntwo\n")
    await sh(["add", "old.txt"])
    await sh(["commit", "-qm", "init"])
    await sh(["mv", "old.txt", "new.txt"])

    workbenchStore.openDiff(join(root, "new.txt"), "staged", root, {
      preview: false,
      oldPath: join(root, "old.txt"),
    })
    await renderActiveDiff()

    await waitForText("old.txt → new.txt")
  })

  test("v toggles between split and unified view", async () => {
    await write("a.txt", "one\ntwo\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "one\nCHANGED\n")

    workbenchStore.openDiff(join(root, "a.txt"), "unstaged", root, { preview: false })
    await renderActiveDiff()
    await waitForText("Split")

    testSetup!.mockInput.pressKey("v")
    await waitForText("Unified")
  })

  test("Ctrl+V is a paste chord, not the 'v' view-toggle", async () => {
    await write("a.txt", "one\ntwo\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", "one\nCHANGED\n")

    workbenchStore.openDiff(join(root, "a.txt"), "unstaged", root, { preview: false })
    // kittyKeyboard is required for the mock to deliver a disambiguated Ctrl+V as
    // key.name="v" with ctrl=true — without it, Ctrl+V never reaches the handler
    // as "v" and the bare-letter guard wouldn't even be exercised.
    const dims = { width: 80, height: 12 }
    testSetup = await testRender(
      <OverlayProvider>
        <box width={dims.width} height={dims.height}>
          <CommandsProvider>
            <DiffPane focused />
          </CommandsProvider>
        </box>
      </OverlayProvider>,
      { ...dims, kittyKeyboard: true },
    )
    // The initial view depends on module-level `lastView`, so capture it rather
    // than assuming.
    await waitForText("v toggle")
    const before = testSetup.captureCharFrame().includes("Split") ? "Split" : "Unified"
    const opposite = before === "Split" ? "Unified" : "Split"

    // Ctrl+V (paste) must be ignored; a following bare `v` toggles exactly once,
    // so the view must land on the OPPOSITE. If the guard were missing, Ctrl+V
    // would toggle too and the two presses would cancel back to `before`.
    testSetup.mockInput.pressKey("v", { ctrl: true })
    for (let i = 0; i < 6; i++) await testSetup.flush()
    testSetup.mockInput.pressKey("v")
    await waitForText(opposite)
  })

  test("n hunk navigation scrolls to a later hunk", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`)
    await write("big.txt", lines.join("\n") + "\n")
    await sh(["add", "big.txt"])
    await sh(["commit", "-qm", "init"])
    lines[2] = "HUNK_ONE_CHANGE"
    lines[55] = "HUNK_TWO_CHANGE"
    await write("big.txt", lines.join("\n") + "\n")

    workbenchStore.openDiff(join(root, "big.txt"), "unstaged", root, { preview: false })
    await renderActiveDiff({ width: 80, height: 8 })
    await waitForText("HUNK_ONE_CHANGE")

    const before = testSetup!.captureCharFrame()
    testSetup!.mockInput.pressKey("n")
    for (let i = 0; i < 6; i++) await testSetup!.flush()
    await Bun.sleep(30)
    await testSetup!.flush()
    const after = testSetup!.captureCharFrame()

    expect(after).not.toBe(before) // scroll position moved
  })

  for (const view of ["split", "unified"] as const) {
    test(`n/p navigate every change block and wrap under full-file context (${view})`, async () => {
      // A tall file with two well-separated single-line edits: under full context
      // the whole file is one hunk, so navigation must come from our own
      // change-block offsets rather than the renderable's single hunk start.
      const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`)
      const oldText = lines.join("\n") + "\n"
      await write("big.txt", oldText)
      await sh(["add", "big.txt"])
      await sh(["commit", "-qm", "init"])
      lines[5] = "EDIT_TOP"
      lines[40] = "EDIT_BOTTOM"
      const newText = lines.join("\n") + "\n"
      await write("big.txt", newText)

      workbenchStore.openDiff(join(root, "big.txt"), "unstaged", root, { preview: false })
      await renderActiveDiff({ width: 80, height: 8 })
      await waitForText("EDIT_TOP")
      await ensureView(view)

      const { patch } = buildDiffPatch(oldText, newText, "big.txt")
      const offsets = computeChangeBlockOffsets(patch, view)
      expect(offsets.length).toBe(2) // two change blocks
      const sb = scrollbox()

      const pressAndRead = async (k: "n" | "p") => {
        testSetup!.mockInput.pressKey(k)
        for (let i = 0; i < 6; i++) await testSetup!.flush()
        await Bun.sleep(20)
        await testSetup!.flush()
        return sb.scrollTop
      }

      // From the top, n visits block 1, then block 2, then wraps back to block 1.
      expect(await pressAndRead("n")).toBe(offsets[0])
      expect(await pressAndRead("n")).toBe(offsets[1])
      expect(await pressAndRead("n")).toBe(offsets[0]) // wrap forward
      // p walks back: from block 1 it wraps to the last block.
      expect(await pressAndRead("p")).toBe(offsets[1]) // wrap backward
      expect(await pressAndRead("p")).toBe(offsets[0])
    })
  }
})

/** The DiffPane's diff renderable, for reading scrollX/maxScrollX after horizontal-scroll input. */
function diffRenderable(): { scrollX: number; maxScrollX: number } {
  const out: { scrollX: number; maxScrollX: number }[] = []
  const walk = (node: { getChildren(): unknown[]; constructor: { name: string } }) => {
    if (node.constructor.name === "IntralineDiffRenderable") out.push(node as never)
    for (const child of node.getChildren()) walk(child as never)
  }
  walk(testSetup!.renderer.root as never)
  if (out.length !== 1) throw new Error(`expected exactly one intraline-diff, found ${out.length}`)
  return out[0]
}

describe("DiffPane horizontal scroll", () => {
  async function renderOverflowingLine(char: string) {
    const longLine = char.repeat(200)
    await write("a.txt", "short\n")
    await sh(["add", "a.txt"])
    await sh(["commit", "-qm", "init"])
    await write("a.txt", `${longLine}\n`)

    workbenchStore.openDiff(join(root, "a.txt"), "unstaged", root, { preview: false })
    await renderActiveDiff({ width: 40, height: 10 })
    await waitForText(char.repeat(4))
  }

  /** Press a key and run enough flushes for the handler + re-render to settle. */
  async function press(key: Parameters<NonNullable<typeof testSetup>["mockInput"]["pressKey"]>[0]) {
    testSetup!.mockInput.pressKey(key)
    for (let i = 0; i < 6; i++) await testSetup!.flush()
  }

  /** A horizontal scrollbar by its stable id, or null when the current view doesn't render it. */
  function getBar(id: string): ScrollBarRenderable | null {
    return (testSetup!.renderer.root.findDescendantById(id) as unknown as ScrollBarRenderable) ?? null
  }

  /**
   * Bounded poll until the bar exists and `cond` holds, re-fetching each round (a
   * view toggle remounts the bars, so a held reference can go stale). The bars are
   * fed by DiffPane's per-frame sync, which only runs as flushes drive frames.
   */
  async function waitForBar(
    id: string,
    cond: (bar: ScrollBarRenderable) => boolean,
    timeoutMs = 4000,
  ): Promise<ScrollBarRenderable> {
    const start = Date.now()
    for (;;) {
      const bar = getBar(id)
      if (bar && cond(bar)) return bar
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for scrollbar "${id}"\n${testSetup!.captureCharFrame()}`)
      }
      await testSetup!.flush()
      await Bun.sleep(20)
    }
  }

  for (const view of ["split", "unified"] as const) {
    test(`a line wider than the viewport has scroll room (no-wrap, ${view})`, async () => {
      await renderOverflowingLine("x")
      await ensureView(view)
      expect(diffRenderable().maxScrollX).toBeGreaterThan(0)
    })

    test(`Right/Left arrows scroll the diff horizontally and back (${view})`, async () => {
      await renderOverflowingLine("y")
      await ensureView(view)
      const diff = diffRenderable()
      expect(diff.scrollX).toBe(0)

      testSetup!.mockInput.pressArrow("right")
      for (let i = 0; i < 6; i++) await testSetup!.flush()
      expect(diff.scrollX).toBeGreaterThan(0)

      const afterRight = diff.scrollX
      testSetup!.mockInput.pressArrow("left")
      for (let i = 0; i < 6; i++) await testSetup!.flush()
      expect(diff.scrollX).toBeLessThan(afterRight)
    })
  }

  // Wheel coordinates are view-specific: code rows are content-sized to the diff's
  // line count (not stretched to pane height), and the code column region differs
  // between the split right pane and the unified single surface.
  for (const [view, x, y] of [
    ["split", 30, 1], // inside the right ("new") side's single content row
    ["unified", 20, 2], // inside the "+zzz…" row (row y=1 is the "-short" row)
  ] as const) {
    test(`shift+wheel over the diff content scrolls horizontally (${view})`, async () => {
      await renderOverflowingLine("z")
      await ensureView(view)
      const diff = diffRenderable()
      expect(diff.scrollX).toBe(0)

      for (let i = 0; i < 8; i++) {
        await testSetup!.mockMouse.scroll(x, y, "down", { modifiers: { shift: true } })
        await testSetup!.flush()
      }
      expect(diff.scrollX).toBeGreaterThan(0)
    })
  }

  test("toggling the view resets horizontal scroll (no stale-offset teleport)", async () => {
    await renderOverflowingLine("w")
    await ensureView("split")
    const diff = diffRenderable()

    for (let i = 0; i < 5; i++) {
      testSetup!.mockInput.pressArrow("right")
      await testSetup!.flush()
    }
    for (let i = 0; i < 6; i++) await testSetup!.flush()
    expect(diff.scrollX).toBeGreaterThan(0)

    // Toggle to unified: the detached split-right side must not leak its offset —
    // scroll restarts at 0 and a Left press stays clamped there (no teleport).
    await press("v")
    await waitForText("Unified")
    expect(diff.scrollX).toBe(0)
    testSetup!.mockInput.pressArrow("left")
    for (let i = 0; i < 6; i++) await testSetup!.flush()
    expect(diff.scrollX).toBe(0)

    // And back to split: both sides restart in sync at 0, so the short "old" line
    // is actually visible (a stale clamped-out offset would render it blank).
    await press("v")
    await waitForText("Split")
    expect(diff.scrollX).toBe(0)
    expect(testSetup!.captureCharFrame()).toContain("short")
  })

  test("plain (non-shift) wheel over the diff content still scrolls vertically, not horizontally", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    await write("big.txt", lines.join("\n") + "\n")
    await sh(["add", "big.txt"])
    await sh(["commit", "-qm", "init"])
    lines[2] = "CHANGED"
    await write("big.txt", lines.join("\n") + "\n")

    workbenchStore.openDiff(join(root, "big.txt"), "unstaged", root, { preview: false })
    await renderActiveDiff({ width: 40, height: 8 })
    await waitForText("CHANGED")
    await ensureView("split")

    const diff = diffRenderable()
    const before = testSetup!.captureCharFrame()
    for (let i = 0; i < 5; i++) {
      await testSetup!.mockMouse.scroll(30, 3, "down")
      await testSetup!.flush()
    }
    expect(testSetup!.captureCharFrame()).not.toBe(before) // vertical position moved
    expect(diff.scrollX).toBe(0) // no shift held — stayed vertical-only
  })

  test("split view: the overflowing side's bar shows, the fitting side's auto-hides", async () => {
    await renderOverflowingLine("x")
    await ensureView("split")

    // The 200-col line is the NEW content, i.e. the right side; the old side is
    // just "short". Poll until the per-frame sync has sized the bars.
    const right = await waitForBar("diff-hscrollbar-right", (b) => b.scrollSize > b.viewportSize)
    expect(right.visible).toBe(true)

    const left = getBar("diff-hscrollbar-left")!
    expect(left.scrollSize).toBeLessThanOrEqual(left.viewportSize)
    expect(left.visible).toBe(false)
  })

  test("unified view: a single full-width bar shows (split bars not rendered)", async () => {
    await renderOverflowingLine("u")
    await ensureView("unified")

    const bar = await waitForBar("diff-hscrollbar", (b) => b.scrollSize > b.viewportSize)
    expect(bar.visible).toBe(true)
    expect(getBar("diff-hscrollbar-left")).toBeNull()
    expect(getBar("diff-hscrollbar-right")).toBeNull()
  })

  test("a diff with no long lines keeps the bars auto-hidden", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    await write("big.txt", lines.join("\n") + "\n")
    await sh(["add", "big.txt"])
    await sh(["commit", "-qm", "init"])
    lines[2] = "CHANGED"
    await write("big.txt", lines.join("\n") + "\n")

    workbenchStore.openDiff(join(root, "big.txt"), "unstaged", root, { preview: false })
    await renderActiveDiff({ width: 40, height: 8 })
    await waitForText("CHANGED")
    await ensureView("split")

    // scrollSize > 0 proves the sync has fed the bar real content extents; the
    // content fits both sides, so auto-hide must keep both bars paint-hidden.
    const left = await waitForBar("diff-hscrollbar-left", (b) => b.scrollSize > 0)
    expect(left.scrollSize).toBeLessThanOrEqual(left.viewportSize)
    expect(left.visible).toBe(false)
    const right = getBar("diff-hscrollbar-right")!
    expect(right.scrollSize).toBeLessThanOrEqual(right.viewportSize)
    expect(right.visible).toBe(false)
  })

  test("the bar thumb mirrors keyboard horizontal scrolling (split)", async () => {
    await renderOverflowingLine("m")
    await ensureView("split")
    await waitForBar("diff-hscrollbar-right", (b) => b.scrollSize > b.viewportSize)

    const diff = diffRenderable()
    for (let i = 0; i < 3; i++) {
      testSetup!.mockInput.pressArrow("right")
      for (let j = 0; j < 6; j++) await testSetup!.flush()
    }
    expect(diff.scrollX).toBeGreaterThan(0)

    const right = await waitForBar("diff-hscrollbar-right", (b) => b.scrollPosition === diff.scrollX)
    expect(right.scrollPosition).toBe(diff.scrollX)
    // The never-overflowing left side stays clamped at its own 0 (ScrollBar stores
    // a non-positive position when content fits — never a scroll).
    expect(getBar("diff-hscrollbar-left")!.scrollPosition).toBeLessThanOrEqual(0)
  })

  test("moving the bar thumb scrolls the diff (drag divergence applied by the frame sync)", async () => {
    await renderOverflowingLine("d")
    await ensureView("split")
    const bar = await waitForBar("diff-hscrollbar-right", (b) => b.scrollSize > b.viewportSize)

    const diff = diffRenderable()
    expect(diff.scrollX).toBe(0)

    // A real thumb drag lands in the bar as a scrollPosition change (the slider's
    // onChange writes it back); setting it directly exercises the same divergence
    // path the frame sync watches.
    bar.scrollPosition = 10
    const start = Date.now()
    while (Date.now() - start < 3000 && diff.scrollX !== 10) {
      await testSetup!.flush()
      await Bun.sleep(20)
    }
    expect(diff.scrollX).toBe(10)
  })

  test("wheel over the bar scrolls the diff horizontally (unified)", async () => {
    await renderOverflowingLine("h")
    await ensureView("unified")
    const bar = await waitForBar("diff-hscrollbar", (b) => b.scrollSize > b.viewportSize)

    const diff = diffRenderable()
    expect(diff.scrollX).toBe(0)

    // Wheel-down over the bar's own cells (bar.x/y are absolute) → scroll right.
    for (let i = 0; i < 4; i++) {
      await testSetup!.mockMouse.scroll(bar.x + 5, bar.y, "down")
      await testSetup!.flush()
    }
    expect(diff.scrollX).toBeGreaterThan(0)

    const afterDown = diff.scrollX
    for (let i = 0; i < 2; i++) {
      await testSetup!.mockMouse.scroll(bar.x + 5, bar.y, "up")
      await testSetup!.flush()
    }
    expect(diff.scrollX).toBeLessThan(afterDown)
  })

  test("toggling to unified after a split scroll re-syncs the bar to 0", async () => {
    await renderOverflowingLine("t")
    await ensureView("split")
    await waitForBar("diff-hscrollbar-right", (b) => b.scrollSize > b.viewportSize)

    for (let i = 0; i < 5; i++) {
      testSetup!.mockInput.pressArrow("right")
      await testSetup!.flush()
    }
    for (let i = 0; i < 6; i++) await testSetup!.flush()
    expect(diffRenderable().scrollX).toBeGreaterThan(0)

    await press("v")
    await waitForText("Unified")
    expect(diffRenderable().scrollX).toBe(0)
    // The freshly-mounted unified bar syncs from the reset left side: position 0.
    const bar = await waitForBar(
      "diff-hscrollbar",
      (b) => b.scrollSize > b.viewportSize && b.scrollPosition === 0,
    )
    expect(bar.scrollPosition).toBe(0)
  })
})

describe("DiffPane intra-line emphasis", () => {
  type Row = { chars: string; bgs: RGBA[] }

  function findRow(frame: CapturedFrame, ...needles: string[]): Row | null {
    const line = frame.lines.find((l) => {
      const s = rowChars(l).join("")
      return needles.every((n) => s.includes(n))
    })
    if (!line) return null
    return { chars: rowChars(line).join(""), bgs: rowBackgrounds(line) }
  }

  test("split view: a single-token change emphasizes only the changed token on each side", async () => {
    await write("a.ts", "const a = 1\n")
    await sh(["add", "a.ts"])
    await sh(["commit", "-qm", "init"])
    await write("a.ts", "const a = 2\n")

    workbenchStore.openDiff(join(root, "a.ts"), "unstaged", root, { preview: false })
    await renderActiveDiff()
    await waitForText("const a = 2")
    await ensureView("split")

    // Split view renders the paired removed/added lines on one shared row.
    const frame = await waitForSpans((f) => {
      const row = findRow(f, "const a = 1", "const a = 2")
      return row !== null && rgbEquals(row.bgs[row.chars.indexOf("= 1") + 2], theme.diffRemovedEmphasisBackground)
    })

    const row = findRow(frame, "const a = 1", "const a = 2")!
    const removedDigitIdx = row.chars.indexOf("= 1") + 2
    const addedDigitIdx = row.chars.lastIndexOf("= 2") + 2
    expect(rgbEquals(row.bgs[removedDigitIdx], theme.diffRemovedEmphasisBackground)).toBe(true)
    expect(rgbEquals(row.bgs[addedDigitIdx], theme.diffAddedEmphasisBackground)).toBe(true)

    // The rest of each line keeps only the plain whole-line tint, not the emphasis bg.
    const removedWordIdx = row.chars.indexOf("const a = 1")
    const addedWordIdx = row.chars.lastIndexOf("const a = 2")
    expect(rgbEquals(row.bgs[removedWordIdx], theme.diffRemovedBackground)).toBe(true)
    expect(rgbEquals(row.bgs[addedWordIdx], theme.diffAddedBackground)).toBe(true)
  }, 25000)

  test("unified view: the '-' row and '+' row each carry the same emphasis on their own row", async () => {
    await write("a.ts", "const a = 1\n")
    await sh(["add", "a.ts"])
    await sh(["commit", "-qm", "init"])
    await write("a.ts", "const a = 2\n")

    workbenchStore.openDiff(join(root, "a.ts"), "unstaged", root, { preview: false })
    await renderActiveDiff()
    await waitForText("const a = 2")
    await ensureView("unified")

    const frame = await waitForSpans((f) => {
      const removedRow = findRow(f, "const a = 1")
      return (
        removedRow !== null &&
        rgbEquals(removedRow.bgs[removedRow.chars.indexOf("= 1") + 2], theme.diffRemovedEmphasisBackground)
      )
    })

    const removedRow = findRow(frame, "const a = 1")!
    const addedRow = findRow(frame, "const a = 2")!
    const removedDigitIdx = removedRow.chars.indexOf("= 1") + 2
    const addedDigitIdx = addedRow.chars.indexOf("= 2") + 2
    expect(rgbEquals(removedRow.bgs[removedDigitIdx], theme.diffRemovedEmphasisBackground)).toBe(true)
    expect(rgbEquals(addedRow.bgs[addedDigitIdx], theme.diffAddedEmphasisBackground)).toBe(true)

    const removedWordIdx = removedRow.chars.indexOf("const a = 1")
    const addedWordIdx = addedRow.chars.indexOf("const a = 2")
    expect(rgbEquals(removedRow.bgs[removedWordIdx], theme.diffRemovedBackground)).toBe(true)
    expect(rgbEquals(addedRow.bgs[addedWordIdx], theme.diffAddedBackground)).toBe(true)
  }, 25000)

  test("a pure insertion (no removed counterpart) shows no emphasis — only the plain added tint", async () => {
    await write("a.ts", "alpha\ngamma\n")
    await sh(["add", "a.ts"])
    await sh(["commit", "-qm", "init"])
    await write("a.ts", "alpha\nBETA_NEW_LINE\ngamma\n")

    workbenchStore.openDiff(join(root, "a.ts"), "unstaged", root, { preview: false })
    await renderActiveDiff()
    await waitForText("BETA_NEW_LINE")
    await ensureView("split")

    // Wait for the pipeline to apply the plain added tint (proving `onChunks` —
    // which emphasis would also ride — has had a chance to run at least once)
    // before asserting that no emphasis background appears anywhere on the line.
    const frame = await waitForSpans((f) => {
      const row = findRow(f, "BETA_NEW_LINE")
      return row !== null && rgbEquals(row.bgs[row.chars.indexOf("BETA_NEW_LINE")], theme.diffAddedBackground)
    })

    const row = findRow(frame, "BETA_NEW_LINE")!
    const start = row.chars.indexOf("BETA_NEW_LINE")
    for (let i = start; i < start + "BETA_NEW_LINE".length; i++) {
      expect(rgbEquals(row.bgs[i], theme.diffAddedBackground)).toBe(true)
      expect(rgbEquals(row.bgs[i], theme.diffAddedEmphasisBackground)).toBe(false)
    }
  }, 25000)

  test("a mostly-rewritten line (over the similarity guard) shows no emphasis on either side", async () => {
    await write("a.ts", "hello world foo bar\n")
    await sh(["add", "a.ts"])
    await sh(["commit", "-qm", "init"])
    await write("a.ts", "zzzz yyyy xxxx wwww\n")

    workbenchStore.openDiff(join(root, "a.ts"), "unstaged", root, { preview: false })
    await renderActiveDiff()
    await waitForText("zzzz yyyy xxxx wwww")
    await ensureView("split")

    const frame = await waitForSpans((f) => {
      const row = findRow(f, "hello world foo bar", "zzzz yyyy xxxx wwww")
      return row !== null && rgbEquals(row.bgs[row.chars.indexOf("hello")], theme.diffRemovedBackground)
    })

    const row = findRow(frame, "hello world foo bar", "zzzz yyyy xxxx wwww")!
    const removedStart = row.chars.indexOf("hello world foo bar")
    const addedStart = row.chars.lastIndexOf("zzzz yyyy xxxx wwww")
    for (let i = removedStart; i < removedStart + "hello world foo bar".length; i++) {
      expect(rgbEquals(row.bgs[i], theme.diffRemovedBackground)).toBe(true)
      expect(rgbEquals(row.bgs[i], theme.diffRemovedEmphasisBackground)).toBe(false)
    }
    for (let i = addedStart; i < addedStart + "zzzz yyyy xxxx wwww".length; i++) {
      expect(rgbEquals(row.bgs[i], theme.diffAddedBackground)).toBe(true)
      expect(rgbEquals(row.bgs[i], theme.diffAddedEmphasisBackground)).toBe(false)
    }
  }, 25000)

  test("toggling split<->unified (v) keeps emphasis correct in both views", async () => {
    await write("a.ts", "const a = 1\n")
    await sh(["add", "a.ts"])
    await sh(["commit", "-qm", "init"])
    await write("a.ts", "const a = 2\n")

    workbenchStore.openDiff(join(root, "a.ts"), "unstaged", root, { preview: false })
    await renderActiveDiff()
    await waitForText("const a = 2")
    await ensureView("split")

    const assertSplit = (frame: CapturedFrame) => {
      const row = findRow(frame, "const a = 1", "const a = 2")!
      expect(rgbEquals(row.bgs[row.chars.indexOf("= 1") + 2], theme.diffRemovedEmphasisBackground)).toBe(true)
      expect(rgbEquals(row.bgs[row.chars.lastIndexOf("= 2") + 2], theme.diffAddedEmphasisBackground)).toBe(true)
    }
    const assertUnified = (frame: CapturedFrame) => {
      const removedRow = findRow(frame, "const a = 1")!
      const addedRow = findRow(frame, "const a = 2")!
      expect(rgbEquals(removedRow.bgs[removedRow.chars.indexOf("= 1") + 2], theme.diffRemovedEmphasisBackground)).toBe(
        true,
      )
      expect(rgbEquals(addedRow.bgs[addedRow.chars.indexOf("= 2") + 2], theme.diffAddedEmphasisBackground)).toBe(true)
    }

    const splitFrame = await waitForSpans((f) => {
      const row = findRow(f, "const a = 1", "const a = 2")
      return row !== null && rgbEquals(row.bgs[row.chars.indexOf("= 1") + 2], theme.diffRemovedEmphasisBackground)
    })
    assertSplit(splitFrame)

    testSetup!.mockInput.pressKey("v")
    await waitForText("Unified")
    const unifiedFrame = await waitForSpans((f) => {
      const removedRow = findRow(f, "const a = 1")
      return (
        removedRow !== null &&
        rgbEquals(removedRow.bgs[removedRow.chars.indexOf("= 1") + 2], theme.diffRemovedEmphasisBackground)
      )
    })
    assertUnified(unifiedFrame)

    testSetup!.mockInput.pressKey("v")
    await waitForText("Split")
    const splitFrame2 = await waitForSpans((f) => {
      const row = findRow(f, "const a = 1", "const a = 2")
      return row !== null && rgbEquals(row.bgs[row.chars.indexOf("= 1") + 2], theme.diffRemovedEmphasisBackground)
    })
    assertSplit(splitFrame2)
  }, 30000)
})
