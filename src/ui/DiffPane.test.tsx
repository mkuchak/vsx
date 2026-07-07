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
