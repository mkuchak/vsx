import type { Renderable, TextareaRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { documentRegistry } from "../model/documents"
import { workbenchStore } from "../model/workbench"
import * as searchService from "../services/search"
import type { SearchResult } from "../services/search"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { consumePendingGoto } from "../workbench/editorControls"
import { OverlayProvider } from "../workbench/OverlayProvider"
import { EditorGroups } from "./EditorGroups"
import { SearchPanel } from "./SearchPanel"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined
let root: string

async function sh(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
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

beforeEach(async () => {
  workbenchStore.reset()
  // realpath so `root` matches git's resolved paths (/var → /private/var on macOS),
  // keeping the panel's workspace-relative display paths clean.
  root = realpathSync(await mkdtemp(join(tmpdir(), "vsx-search-")))
  await sh(["init", "-q"])
  await sh(["config", "user.email", "a@b.com"])
  await sh(["config", "user.name", "Tester"])
})

afterEach(async () => {
  testSetup?.renderer.destroy()
  testSetup = undefined
  workbenchStore.reset()
  mock.restore()
  await Bun.sleep(30)
  await rm(root, { recursive: true, force: true })
})

function collect(pred: (r: Renderable) => boolean): Renderable[] {
  const out: Renderable[] = []
  const walk = (node: Renderable) => {
    if (pred(node)) out.push(node)
    for (const child of node.getChildren()) walk(child)
  }
  walk(testSetup!.renderer.root)
  return out
}

function frame(): string {
  return testSetup!.captureCharFrame()
}

/** Concatenated text of every span rendered bold this frame (the match spans). */
function boldText(): string {
  return testSetup!
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .filter((span) => (span.attributes & TextAttributes.BOLD) !== 0)
    .map((span) => span.text)
    .join("")
}

/** Let a state change (e.g. entering list mode) commit before the next key. */
async function settle() {
  await testSetup!.flush()
  await Bun.sleep(40)
  await testSetup!.flush()
}

function textarea(): TextareaRenderable | null {
  const [n] = collect((r) => r.id === "editor-textarea")
  return (n as unknown as TextareaRenderable) ?? null
}

async function waitFor(text: string, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await testSetup!.flush()
    if (frame().includes(text)) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for "${text}"\n${frame()}`)
}

/** Render the panel alone (most tests) or with an editor column (open-at-line test). */
async function render(opts: { withEditor?: boolean; maxResults?: number } = {}) {
  testSetup = await testRender(
    <OverlayProvider>
      <CommandsProvider>
        <box width={40} height={16} flexDirection="row">
          <box width={28} height="100%">
            <SearchPanel workspaceRoot={root} focused maxResults={opts.maxResults} />
          </box>
          {opts.withEditor ? (
            <box flexGrow={1} height="100%">
              <EditorGroups />
            </box>
          ) : null}
        </box>
      </CommandsProvider>
    </OverlayProvider>,
    { width: 40, height: 16 },
  )
  return testSetup
}

/**
 * Click a match row (by path+line) to activate it. Rendered without an editor
 * column, so the active group NEVER registers controls — the same code path as
 * the real async window before a freshly-opened editor mounts. openMatch's decision
 * (fast gotoLine vs. stash a pending goto) therefore always takes the stash branch,
 * letting us assert the resulting pending-goto slot deterministically.
 */
async function clickMatchRow(path: string, line: number) {
  const prefix = `match::${path}::${line}::`
  const [row] = collect((r) => typeof r.id === "string" && r.id.startsWith(prefix))
  if (!row) throw new Error(`no match row for ${path}:${line}\n${frame()}`)
  const g = row as unknown as { x: number; y: number }
  await testSetup!.mockMouse.click(g.x + 2, g.y)
}

/** Wait until the search input holds native focus (post-render/-remount). */
async function waitForInputFocus() {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && testSetup!.renderer.currentFocusedRenderable?.id !== "search-input") {
    await testSetup!.flush()
    await Bun.sleep(20)
  }
}

/** Wait until the search input holds native focus, then type + Enter to search. */
async function search(query: string) {
  await waitForInputFocus()
  await testSetup!.mockInput.typeText(query)
  await testSetup!.flush()
  testSetup!.mockInput.pressEnter()
}

/**
 * Type a query, flip a mode toggle (Aa / ab / .*) by clicking its label, THEN run.
 * The toggle MUST come after typing: clicking a toggle first desyncs the mock
 * input's controlled value, so subsequent keystrokes never reach onInput and the
 * query would run empty. Settles around the click so the top row is painted (a
 * click on an unrendered frame silently misses) and the new toggle state is
 * flushed into optsRef before Enter reads it; throws if the label isn't visible.
 */
async function searchWithToggle(query: string, label: string) {
  await waitForInputFocus()
  await testSetup!.mockInput.typeText(query)
  await testSetup!.flush()

  await settle()
  const line0 = frame().split("\n")[0]
  const x = line0.indexOf(label)
  if (x < 0) throw new Error(`toggle "${label}" not visible in top row: ${JSON.stringify(line0)}`)
  await testSetup!.mockMouse.click(x, 0)
  await settle()

  testSetup!.mockInput.pressEnter()
}

test("typing a query and pressing Enter renders file-grouped rows with counts", async () => {
  await write("alpha.ts", "const needle = 1\nother\nneedle again\n")
  await write("beta.ts", "no match here\n")
  await write("gamma.ts", "a needle in gamma\n")

  await render()
  await search("needle")
  await waitFor("3 results in 2 files")

  const f = frame()
  expect(f).toContain("alpha.ts")
  expect(f).toContain("gamma.ts")
  expect(f).not.toContain("beta.ts") // no matches → not listed
  // Match previews are shown.
  expect(f).toContain("const needle = 1")
  expect(f).toContain("a needle in gamma")
})

test("Down from the input enters the results list and Enter collapses/expands a file", async () => {
  await write("alpha.ts", "needle one\nneedle two\n")

  await render()
  await search("needle")
  await waitFor("2 results in 1 file")
  expect(frame()).toContain("needle one")

  // ↓ hands focus to the list (first row = the file row); Enter collapses it.
  testSetup!.mockInput.pressArrow("down")
  await settle()
  testSetup!.mockInput.pressEnter()
  const collapseDeadline = Date.now() + 2000
  while (Date.now() < collapseDeadline && frame().includes("needle one")) {
    await testSetup!.flush()
    await Bun.sleep(20)
  }
  expect(frame()).not.toContain("needle one") // matches hidden under the collapsed file

  // Enter again expands it back.
  testSetup!.mockInput.pressEnter()
  await waitFor("needle one")
  expect(frame()).toContain("needle two")
})

test("Enter on a match opens the (not-yet-open) file with the caret on the match", async () => {
  await write("target.ts", "line one\nline two\nfind ME here\nline four\n")

  await render({ withEditor: true })
  // The file must not be open before activating the match.
  expect(textarea()).toBeNull()

  await search("ME")
  await waitFor("1 result in 1 file")

  // Click the match row directly rather than ↓/↓/Enter: under load a dropped
  // second ↓ leaves selection on the file row, so Enter collapses it instead of
  // opening — the editor never mounts and the cursor stays undefined.
  await clickMatchRow(join(root, "target.ts"), 3)

  // The editor mounts and the pending-goto handshake lands the caret at the match
  // (line 3, col 6 → 0-based row 2, col 5). Generous deadline: write → search →
  // open → the #83 handshake all precede the mount, so keep ample headroom.
  const deadline = Date.now() + 8000
  let cursor: { row: number; col: number } | undefined
  while (Date.now() < deadline) {
    await testSetup!.flush()
    const ta = textarea()
    if (ta) {
      cursor = ta.editorView.getCursor()
      if (cursor.row === 2 && cursor.col === 5) break
    }
    await Bun.sleep(20)
  }
  expect(cursor).toEqual({ row: 2, col: 5 })

  documentRegistry.releaseDocument(join(root, "target.ts"))
}, 15000)

test("a tiny maxResults renders the truncated row", async () => {
  await write("a.ts", "hit\nhit\nhit\nhit\nhit\n")

  await render({ maxResults: 2 })
  await search("hit")
  await waitFor("truncated")
  expect(frame().toLowerCase()).toContain("truncated")
})

test("toggling match-case changes the results", async () => {
  await write("case.ts", "Needle upper\nneedle lower\n")

  await render()
  await search("needle")
  await waitFor("2 results in 1 file") // case-insensitive default matches both

  // Click the "Aa" match-case toggle → only the exact-case line matches.
  const line0 = frame().split("\n")[0]
  const aaX = line0.indexOf("Aa")
  expect(aaX).toBeGreaterThanOrEqual(0)
  await testSetup!.mockMouse.click(aaX, 0)
  await waitFor("1 result in 1 file")
  expect(frame()).toContain("needle lower")
})

test("a superseded (stale) run's results never render", async () => {
  // Drive the service manually so run #1 can resolve AFTER run #2, proving the
  // panel discards the stale result rather than flashing it.
  const pending: Array<(r: SearchResult) => void> = []
  const spy = spyOn(searchService, "searchWorkspace").mockImplementation(
    () => new Promise<SearchResult>((resolve) => pending.push(resolve)),
  )

  await write("dummy.ts", "content\n") // present so the fixture is a real repo
  await render()

  // Run #1.
  await search("one")
  await testSetup!.flush()
  // Run #2 (append to the query and re-Enter).
  await testSetup!.mockInput.typeText("two")
  await testSetup!.flush()
  testSetup!.mockInput.pressEnter()
  await testSetup!.flush()
  expect(pending.length).toBe(2)

  const stale: SearchResult = {
    files: [{ path: join(root, "STALE.ts"), matches: [{ line: 1, col: 1, length: 5, preview: "STALE-LINE" }] }],
    truncated: false,
  }
  const fresh: SearchResult = {
    files: [{ path: join(root, "FRESH.ts"), matches: [{ line: 1, col: 1, length: 5, preview: "FRESH-LINE" }] }],
    truncated: false,
  }
  // Resolve the STALE run (#1) first, then the FRESH run (#2).
  pending[0]!(stale)
  pending[1]!(fresh)
  await waitFor("FRESH.ts")

  expect(frame()).not.toContain("STALE")
  expect(frame()).toContain("FRESH.ts")
  spy.mockRestore()
})

test("activating a second match supersedes the first — the first leaves no orphan goto", async () => {
  // Bug 1: activate a match in A, then in B before A's editor mounts. Pre-fix the
  // per-path Map kept BOTH entries, so opening A later silently jumped to A's line.
  // Fixed: the single slot is replaced by B's request, so A's pending is gone —
  // consuming A (what A's editor would do on mount) yields nothing → caret at 1:1.
  await write("a.ts", "needle in A\n")
  await write("b.ts", "needle in B\n")
  const pathA = join(root, "a.ts")
  const pathB = join(root, "b.ts")

  await render()
  await search("needle")
  await waitFor("2 results in 2 files")

  await clickMatchRow(pathA, 1) // requestGoto(A) + openFile(A)
  await clickMatchRow(pathB, 1) // supersedes: requestGoto(B) + openFile(B)

  // A's request was superseded → nothing to consume for A (would open A at 1:1).
  expect(consumePendingGoto(pathA)).toBeUndefined()
})

test("a rapid second activation of the same still-loading file wins (no double-click race)", async () => {
  // Bug 2: with the file already the active tab but its editor not yet registered,
  // pre-fix openMatch called gotoLine on undefined controls (a no-op) and did NOT
  // re-stash — so the first click's line won over the second. Fixed: the else
  // branch always re-requests, so the SECOND activation's line wins.
  await write("multi.ts", "l1\nl2\nneedle three\nl4\nneedle five\n")
  const path = join(root, "multi.ts")

  await render()
  await search("needle")
  await waitFor("2 results in 1 file")

  await clickMatchRow(path, 3) // first activation → line 3
  await clickMatchRow(path, 5) // same file, still no controls → must supersede to line 5

  expect(consumePendingGoto(path)?.line).toBe(5)
})

test("result rows bold the matched text and keep it when the query is edited", async () => {
  // Highlighting now comes straight from each result record's (col, length), so it
  // is a snapshot in itself: editing the input after a search can't re-highlight
  // the existing rows against text ("needleXYZ") that isn't in them.
  await write("hl.ts", "a needle here\nanother needle line\n")

  await render()
  await search("needle")
  await waitFor("2 results in 1 file")

  // Both rows bold the matched token.
  expect(boldText()).toContain("needle")

  // Type more into the input WITHOUT Enter: a re-render, but no new search.
  await testSetup!.mockInput.typeText("XYZ")
  await testSetup!.flush()
  await Bun.sleep(20)
  await testSetup!.flush()

  // The bold stays on the searched "needle", never the un-searched "needleXYZ".
  expect(boldText()).toContain("needle")
  expect(boldText()).not.toContain("XYZ")
})

test("regex rows bold the git-matched token, not what a JS regex would match", async () => {
  // git ERE treats `\d` as a literal 'd', so `\d+` matches "d" in "def" (col 5);
  // a JS RegExp would instead match "123". The bold must follow git's start, so a
  // full JS re-search (the old bug) can't drift the highlight to the wrong token.
  await write("digits.ts", "abc def 123 ghi\n")

  await render()
  await searchWithToggle("\\d+", ".*")
  await waitFor("1 result in 1 file")

  expect(boldText()).toBe("d")
  expect(boldText()).not.toContain("123")
})

test("a POSIX-class regex (invalid as JS) still bolds at the git-reported start", async () => {
  // `[[:digit:]]+` is valid ERE (git matches "123" at col 9) but doesn't match as
  // a JS regex, so the old re-search rendered NO bold at all. Now the bold anchors
  // at git's start; the extent falls back to a minimal span on the dialect gap.
  await write("digits.ts", "abc def 123 ghi\n")

  await render()
  await searchWithToggle("[[:digit:]]+", ".*")
  await waitFor("1 result in 1 file")

  expect(boldText()).toBe("1")
})

test("literal (case-insensitive) rows bold the whole matched word", async () => {
  await write("lit.ts", "a Needle here\n")

  await render()
  await search("needle") // case-insensitive default
  await waitFor("1 result in 1 file")

  // The full match is bold, preserving the file's original casing.
  expect(boldText()).toBe("Needle")
})

test("whole-word rows bold exactly the matched word", async () => {
  // Two lines so whole-word actually changes the outcome: a literal "hello" hits
  // both (helloworld + hello) → "2 results", whole-word keeps only the standalone
  // "hello" → "1 result". So this fails loudly if the toggle didn't register.
  await write("ww.ts", "helloworld\nhello\n")

  await render()
  await searchWithToggle("hello", "ab") // whole-word
  await waitFor("1 result in 1 file")

  expect(boldText()).toBe("hello") // not "helloworld"
})

test("opening a match on a non-ASCII line lands the caret at the match start", async () => {
  // "café résumé " is 12 chars but 14 bytes; git reports byte col 16 for TODO. The
  // byte→char normalization must land the caret at char col 13 (0-based col 12),
  // i.e. exactly on the 'T', not past the match.
  await write("cafe.ts", "café résumé TODO here\n")

  await render({ withEditor: true })
  expect(textarea()).toBeNull()

  await search("TODO")
  await waitFor("1 result in 1 file")

  // Activate the match by clicking its row directly rather than ↓/↓/Enter: under
  // load the two-arrow nav can race (a missed second ↓ leaves selection on the
  // file row, so Enter collapses it instead of opening), which left the editor
  // unmounted and the cursor undefined.
  await clickMatchRow(join(root, "cafe.ts"), 1)

  // Generous deadline: this test does real work (write → search → open → the #83
  // pending-goto handshake) before the editor pane even mounts, so under load 3s
  // wasn't always enough for `textarea()` to appear (cursor stayed undefined).
  const deadline = Date.now() + 8000
  let cursor: { row: number; col: number } | undefined
  while (Date.now() < deadline) {
    await testSetup!.flush()
    const ta = textarea()
    if (ta) {
      cursor = ta.editorView.getCursor()
      if (cursor.row === 0 && cursor.col === 12) break
    }
    await Bun.sleep(20)
  }
  expect(cursor).toEqual({ row: 0, col: 12 })

  documentRegistry.releaseDocument(join(root, "cafe.ts"))
}, 15000)
