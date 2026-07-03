import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import type { CommitInfo } from "../services/git"
import { CommandsProvider } from "../workbench/CommandsProvider"
import { CommitDetailsOverlay } from "./CommitDetailsOverlay"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

function commit(over: Partial<CommitInfo> = {}): CommitInfo {
  const at = new Date("2026-07-01T12:00:00Z")
  return {
    hash: "abcdef1234567890",
    authorName: "Tester",
    authorEmail: "a@b.com",
    authorDate: at,
    commitDate: at,
    parents: ["1111111aaaa"],
    refs: [],
    message: "subject line",
    ...over,
  }
}

async function render(c: CommitInfo, now: Date) {
  testSetup = await testRender(
    <CommandsProvider>
      <box width={80} height={24}>
        <CommitDetailsOverlay commit={c} fetchStats={async () => null} onClose={() => {}} now={now} />
      </box>
    </CommandsProvider>,
    { width: 80, height: 24 },
  )
  for (let i = 0; i < 4; i++) {
    await testSetup.flush()
    await Bun.sleep(10)
  }
  return testSetup.captureCharFrame()
}

// `now` is injected for a deterministic relative date; the relative bucket comes
// from a getTime() delta so it is timezone-independent (unlike the absolute date).
const NOW = new Date("2026-07-03T12:00:00Z")

test("shows only the author date when author and commit dates match", async () => {
  const frame = await render(commit(), NOW)
  expect(frame).toContain("2d ago") // 2026-07-01 relative to NOW
  expect(frame).not.toContain("Committed")
})

test("adds a labelled commit-date line when it differs (rebase/amend)", async () => {
  const frame = await render(
    commit({ commitDate: new Date("2026-07-03T11:59:55Z") }), // 5s before NOW
    NOW,
  )
  expect(frame).toContain("2d ago") // author date
  expect(frame).toContain("Committed")
  expect(frame).toContain("just now") // commit date, 5s before NOW
})
