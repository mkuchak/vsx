import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { DEFAULT_SIDEBAR_WIDTH } from "../workbench/sidebarWidth"
import { SidebarTabs } from "./SidebarTabs"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

// The four labels + separators render 31 cols against the 32-col default sidebar
// (one col of slack). Pin it so a future label edit can't silently clip the last
// tab. MIN_SIDEBAR_WIDTH (20) clips by design and is intentionally not asserted.
test("all four tab labels fit uncut at the default sidebar width", async () => {
  testSetup = await testRender(
    <box width={DEFAULT_SIDEBAR_WIDTH} height={1}>
      <SidebarTabs active="explorer" onSelect={() => {}} />
    </box>,
    { width: DEFAULT_SIDEBAR_WIDTH, height: 3 },
  )
  await testSetup.renderOnce()

  const frame = testSetup.captureCharFrame()
  for (const label of ["Explorer", "SCM", "Search", "Commits"]) {
    expect(frame).toContain(label)
  }
})
