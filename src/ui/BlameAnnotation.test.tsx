import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import type { LineBlame } from "../services/git"
import { BlameAnnotation, layoutAnnotation } from "./BlameAnnotation"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

// Fixed clock so `formatRelativeDate` is deterministic. authorDate below is 2d back.
const NOW = new Date("2026-07-03T12:00:00Z")

function blame(over: Partial<LineBlame> = {}): LineBlame {
  return {
    hash: "abcdef1234567890",
    authorName: "Ada Lovelace",
    authorDate: new Date("2026-07-01T12:00:00Z"),
    summary: "Add the analytical engine",
    prNumber: 42,
    uncommitted: false,
    ...over,
  }
}

async function render(props: Partial<Parameters<typeof BlameAnnotation>[0]> = {}) {
  testSetup = await testRender(
    <box width={80} height={24}>
      <BlameAnnotation
        blame={blame()}
        visualRow={0}
        lineEndColumn={10}
        paneWidth={80}
        paneHeight={24}
        now={NOW}
        {...props}
      />
    </box>,
    { width: 80, height: 24 },
  )
  for (let i = 0; i < 4; i++) {
    await testSetup.flush()
    await Bun.sleep(10)
  }
  return testSetup.captureCharFrame()
}

test("renders author, relative date, and #PR when all fields are present", async () => {
  const frame = await render()
  expect(frame).toContain("Ada Lovelace")
  expect(frame).toContain("2d ago")
  expect(frame).toContain("#42")
})

test("omits the #PR segment when prNumber is null", async () => {
  const frame = await render({ blame: blame({ prNumber: null }) })
  expect(frame).toContain("Ada Lovelace")
  expect(frame).toContain("2d ago")
  expect(frame).not.toContain("#")
})

test("renders an uncommitted label when uncommitted is true", async () => {
  const frame = await render({ blame: blame({ uncommitted: true }) })
  expect(frame).toContain("Uncommitted change")
  expect(frame).not.toContain("Ada Lovelace")
  expect(frame).not.toContain("#42")
})

test("renders nothing when blame is null", async () => {
  const frame = await render({ blame: null })
  expect(frame).not.toContain("Ada Lovelace")
  expect(frame).not.toContain("Uncommitted")
})

test("renders nothing when visualRow is above the viewport", async () => {
  const frame = await render({ visualRow: -1 })
  expect(frame).not.toContain("Ada Lovelace")
})

test("renders nothing when visualRow is at or below the viewport height", async () => {
  const frame = await render({ visualRow: 24 })
  expect(frame).not.toContain("Ada Lovelace")
})

// --- layout unit tests (pure, no render) --------------------------------------

test("keeps the natural position when the annotation fits", () => {
  const { left, text } = layoutAnnotation("author 2d ago", 13, 80)
  expect(left).toBe(13)
  expect(text).toBe("author 2d ago")
})

test("clamps the right edge flush to paneWidth-1 when it would overflow", () => {
  const text = "SomeAuthor  5m ago  #7"
  const { left, text: out } = layoutAnnotation(text, 70, 80)
  expect(out).toBe(text) // full text preserved
  expect(left + out.length).toBe(80) // right edge at column paneWidth-1
})

test("truncates with a leading ellipsis when wider than the whole pane", async () => {
  const longName = "A Person With A Very Very Long Name Indeed"
  const frame = await render({
    blame: blame({ authorName: longName, prNumber: 999 }),
    paneWidth: 20,
    lineEndColumn: 100,
  })
  expect(frame).toContain("…")
  expect(frame).not.toContain(longName)
})

test("layoutAnnotation truncates head and fills the pane exactly when overflowing", () => {
  const { left, text } = layoutAnnotation("0123456789ABCDEF", 100, 10)
  expect(left).toBe(0)
  expect(text.startsWith("…")).toBe(true)
  expect(text.length).toBe(10) // fills paneWidth
  expect(text).toBe("…789ABCDEF") // kept the tail
})
