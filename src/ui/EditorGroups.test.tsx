import type { Renderable, RGBA } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { theme } from "../theme"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act, useState } from "react"
import { documentRegistry } from "../model/documents"
import { workbenchStore } from "../model/workbench"
import { CommandsProvider, useCommands } from "../workbench/CommandsProvider"
import { OverlayProvider } from "../workbench/OverlayProvider"
import type { CommandRegistry } from "../services/commands"
import { EditorGroups } from "./EditorGroups"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined
let dir: string
let registry: CommandRegistry | null = null

/** Captures the registry so tests can dispatch commands by id (like ctrl+1/ctrl+2). */
function CaptureRegistry() {
  registry = useCommands()
  return null
}

// Lets a test flip EditorGroups' `editorFocused` prop at runtime, standing in for
// App's sidebar↔editor focusArea state that drives the same prop in production.
let setEditorFocused: ((v: boolean) => void) | undefined
function FocusHarness({ initial }: { initial: boolean }) {
  const [editorFocused, set] = useState(initial)
  setEditorFocused = set
  return <EditorGroups editorFocused={editorFocused} />
}

beforeEach(async () => {
  workbenchStore.reset()
  registry = null
  setEditorFocused = undefined
  dir = await mkdtemp(join(tmpdir(), "vsx-editorgroups-"))
})

afterEach(async () => {
  testSetup?.renderer.destroy()
  testSetup = undefined
  workbenchStore.reset()
  await rm(dir, { recursive: true, force: true })
})

async function render(dims = { width: 80, height: 12 }) {
  testSetup = await testRender(
    <OverlayProvider>
      <CommandsProvider>
        <box width={dims.width} height={dims.height}>
          <EditorGroups />
        </box>
        <CaptureRegistry />
      </CommandsProvider>
    </OverlayProvider>,
    dims,
  )
  return testSetup
}

// Renders EditorGroups filling the terminal (no fixed-width wrapper) so its pane
// widths track the terminal size — needed to exercise divider drags and resizes.
async function renderFull(dims = { width: 80, height: 12 }) {
  testSetup = await testRender(
    <OverlayProvider>
      <CommandsProvider>
        <box width="100%" height="100%">
          <EditorGroups />
        </box>
        <CaptureRegistry />
      </CommandsProvider>
    </OverlayProvider>,
    dims,
  )
  return testSetup
}

async function renderFocusHarness(initial: boolean, dims = { width: 80, height: 12 }) {
  testSetup = await testRender(
    <OverlayProvider>
      <CommandsProvider>
        <box width={dims.width} height={dims.height}>
          <FocusHarness initial={initial} />
        </box>
      </CommandsProvider>
    </OverlayProvider>,
    dims,
  )
  return testSetup
}

/** Depth-first collect every renderable matching a predicate, in document order. */
function collect(root: Renderable, pred: (r: Renderable) => boolean): Renderable[] {
  const out: Renderable[] = []
  const walk = (node: Renderable) => {
    if (pred(node)) out.push(node)
    for (const child of node.getChildren()) walk(child)
  }
  walk(root)
  return out
}

/** All editor textareas, left-to-right (both panes share the stable id). */
function textareas(): Renderable[] {
  return collect(testSetup!.renderer.root, (r) => r.id === "editor-textarea")
}

/** Locate a renderable by id and read its rendered geometry. */
function geom(id: string): { x: number; width: number } {
  const [node] = collect(testSetup!.renderer.root, (r) => r.id === id)
  if (!node) throw new Error(`no renderable with id ${id}`)
  return node as unknown as { x: number; width: number }
}

/** RGB triplet of a pane's border color, so accent-vs-neutral is easy to assert. */
function paneBorderRgb(groupId: string): [number, number, number] {
  const [node] = collect(testSetup!.renderer.root, (r) => r.id === `editor-group-${groupId}`)
  if (!node) throw new Error(`no pane for group ${groupId}`)
  const [r, g, b] = (node as unknown as { borderColor: RGBA }).borderColor.toInts()
  return [r, g, b]
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

// Real pointer-capture drag against the 1-cell sash (mirrors sidebarResize.test):
// the first drag must land on the divider column so the renderer captures the
// pointer, then later drags route to the divider even as x moves past the handle.
async function dragDivider(fromX: number, toX: number, y = 5) {
  const mm = testSetup!.mockMouse
  await mm.pressDown(fromX, y)
  await mm.emitMouseEvent("drag", fromX, y)
  await mm.emitMouseEvent("drag", toX, y)
  await mm.release(toX, y)
}

// Reproduces a REAL drag: the very first motion report already lands several cells
// off the 1-col sash, so the renderer captures the NEIGHBORING pane, not the sash.
// The pane's bubbled drag events must reach the row ancestor for the resize to
// happen. On the pre-fix code (resize math only on the sash) nothing moved.
async function dragDividerFast(fromX: number, toX: number, y = 5) {
  const mm = testSetup!.mockMouse
  await mm.pressDown(fromX, y)
  await mm.emitMouseEvent("drag", toX, y) // FIRST drag already off the sash column
  await mm.release(toX, y)
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

test("splitGroup renders two panes side by side", async () => {
  const file = join(dir, "a.ts")
  await writeFile(file, "const answer = 42\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup()

  await render()
  await waitForText("const answer")

  // Two panes, so two editor textareas exist simultaneously.
  expect(textareas()).toHaveLength(2)
  expect(testSetup!.captureCharFrame()).toMatchSnapshot()
})

test("only the active group's pane is focused; ctrl+1 / ctrl+2 switch focus", async () => {
  const file = join(dir, "focus.ts")
  await writeFile(file, "line one\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup() // second (right) group becomes active

  await render()
  await waitForText("line one")

  const focusedCount = () => textareas().filter((t) => t.focused).length

  // Exactly one textarea focused — the right pane (the just-split active group).
  expect(focusedCount()).toBe(1)
  const [left, right] = textareas()
  expect(left.focused).toBe(false)
  expect(right.focused).toBe(true)

  // Ctrl+1 focuses the first (left) group.
  expect(registry!.executeCommand("workbench.focusGroup1")).toBe(true)
  await testSetup!.flush()
  expect(focusedCount()).toBe(1)
  expect(textareas()[0].focused).toBe(true)
  expect(textareas()[1].focused).toBe(false)

  // Ctrl+2 focuses the second (right) group again.
  expect(registry!.executeCommand("workbench.focusGroup2")).toBe(true)
  await testSetup!.flush()
  expect(focusedCount()).toBe(1)
  expect(textareas()[0].focused).toBe(false)
  expect(textareas()[1].focused).toBe(true)
})

test("ctrl+1..ctrl+4 focus each of four split panes", async () => {
  const file = join(dir, "quad.ts")
  await writeFile(file, "quad line\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup()
  workbenchStore.splitGroup()
  workbenchStore.splitGroup() // four panes: [g0, g1, g2, g3]

  await render()
  await waitForText("quad line")
  expect(textareas()).toHaveLength(4)

  const focusedCount = () => textareas().filter((t) => t.focused).length
  const cmds = [
    "workbench.focusGroup1",
    "workbench.focusGroup2",
    "workbench.focusGroup3",
    "workbench.focusGroup4",
  ]
  for (let i = 0; i < 4; i++) {
    expect(registry!.executeCommand(cmds[i])).toBe(true)
    await testSetup!.flush()
    expect(focusedCount()).toBe(1)
    expect(textareas()[i].focused).toBe(true)
  }
})

test("Focus Next/Previous Editor Group commands cycle across all groups", async () => {
  const file = join(dir, "cycle.ts")
  await writeFile(file, "cycle line\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup()
  workbenchStore.splitGroup()
  workbenchStore.splitGroup()
  workbenchStore.splitGroup() // five panes

  await render()
  await waitForText("cycle line")
  expect(textareas()).toHaveLength(5)

  const focusedIndex = () => textareas().findIndex((t) => t.focused)
  workbenchStore.focusGroupByIndex(0)
  await testSetup!.flush()
  expect(focusedIndex()).toBe(0)

  expect(registry!.executeCommand("workbench.focusNextGroup")).toBe(true)
  await testSetup!.flush()
  expect(focusedIndex()).toBe(1)

  // Jump to the last pane then wrap forward to the first.
  workbenchStore.focusGroupByIndex(4)
  await testSetup!.flush()
  expect(registry!.executeCommand("workbench.focusNextGroup")).toBe(true)
  await testSetup!.flush()
  expect(focusedIndex()).toBe(0)

  // Wrap backward from the first to the last.
  expect(registry!.executeCommand("workbench.focusPreviousGroup")).toBe(true)
  await testSetup!.flush()
  expect(focusedIndex()).toBe(4)
})

test("each of two dividers in a three-pane layout resizes independently", async () => {
  const file = join(dir, "three.ts")
  await writeFile(file, "three panes\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup()
  workbenchStore.splitGroup() // three panes

  await renderFull({ width: 120, height: 12 })
  await waitForText("three panes")
  workbenchStore.resetSplitSizes()
  await testSetup!.flush()

  const [g0, g1, g2] = workbenchStore.getState().groups
  const w = (id: string) => geom(`editor-group-${id}`).width
  const x = (id: string) => geom(`editor-group-${id}`).x

  // Drag divider 0 (between g0 and g1) to the right: g0 grows, g1 shrinks.
  const g0Before = w(g0.id)
  const g1Before = w(g1.id)
  const divider0X = x(g0.id) + g0Before
  await dragDivider(divider0X, divider0X + 10)
  await testSetup!.flush()
  expect(w(g0.id)).toBeGreaterThan(g0Before)
  expect(w(g1.id)).toBeLessThan(g1Before)
  const g2Untouched = w(g2.id)

  // Now drag divider 1 (between g1 and g2) to the right: g1 grows, g2 shrinks,
  // and g0's boundary is unaffected by this second gesture.
  const g0Steady = w(g0.id)
  const divider1X = x(g1.id) + w(g1.id)
  await dragDivider(divider1X, divider1X + 10)
  await testSetup!.flush()
  expect(w(g2.id)).toBeLessThan(g2Untouched)
  expect(w(g0.id)).toBe(g0Steady)
})

test("clicking a pane's body focuses that group and preserves the single-focus invariant", async () => {
  const a = join(dir, "a.ts")
  const b = join(dir, "b.ts")
  await writeFile(a, "aaa\n")
  await writeFile(b, "bbb\n")
  workbenchStore.openFile(a, { preview: false })
  workbenchStore.splitGroup() // second (right) group active, holds a clone of a
  workbenchStore.openFile(b, { preview: false }) // right pane now shows b

  await render()
  await waitForText("bbb")

  const before = textareas()
  expect(before[0].focused).toBe(false) // left (group0) unfocused
  expect(before[1].focused).toBe(true) // right (group1) focused

  // Click in the LEFT pane's BODY (below its 1-row tab strip, not the strip).
  await testSetup!.mockMouse.click(3, 5)
  await testSetup!.flush()

  const after = textareas()
  expect(after[0].focused).toBe(true) // left is now focused
  expect(after[1].focused).toBe(false) // right lost focus — single-focus preserved
  expect(workbenchStore.getState().activeGroupId).toBe(workbenchStore.getState().groups[0].id)
})

test("clicking a tab in the second group focuses it and activates the tab within it", async () => {
  const a = join(dir, "a.ts")
  const b = join(dir, "b.ts")
  await writeFile(a, "aaa\n")
  await writeFile(b, "bbb\n")
  workbenchStore.openFile(a, { preview: false })
  workbenchStore.splitGroup() // right group active, clone of a
  workbenchStore.openFile(b, { preview: false }) // right group: [a, b], active b
  // Focus the LEFT group so the right group is the non-focused one under test.
  workbenchStore.focusGroupByIndex(0)

  await render()
  await waitForText("bbb")
  const [g0, g1] = workbenchStore.getState().groups
  expect(workbenchStore.getState().activeGroupId).toBe(g0.id)
  expect(g1.activeTabPath).toBe(b)

  // The right pane's tab strip starts at the mid-column; its FIRST tab (a.ts)
  // sits just past the pane border. Clicking it must focus group1 AND switch
  // its active tab away from b.ts to the clicked a.ts — all within group1.
  await testSetup!.mockMouse.click(42, 0)
  await testSetup!.flush()

  expect(workbenchStore.getState().activeGroupId).toBe(g1.id)
  expect(workbenchStore.getState().groups[1].activeTabPath).toBe(a)
})

test("editing the focused pane flows through the shared Document to the other pane", async () => {
  const file = join(dir, "shared.ts")
  await writeFile(file, "hello\n")
  // Pre-open so the shared Document is registered before both panes mount.
  const doc = await documentRegistry.openDocument(file)
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup() // both panes now show the same path → same Document

  await render()
  await waitForText("hello")

  // Focus the LEFT pane and type into it.
  workbenchStore.focusGroupByIndex(0)
  await testSetup!.flush()
  await testSetup!.mockInput.typeText("Z")
  await testSetup!.flush()
  await Bun.sleep(30)
  await testSetup!.flush()

  // The shared Document received the edit...
  expect(doc.getText()).toContain("Z")
  // ...and BOTH panes' textareas reflect it (the unfocused right pane synced).
  const buffers = textareas().map((t) => (t as unknown as { plainText: string }).plainText)
  expect(buffers).toHaveLength(2)
  expect(buffers[0]).toContain("Z")
  expect(buffers[1]).toContain("Z")

  documentRegistry.releaseDocument(file)
})

test("closing the last tab in the second group collapses back to one pane", async () => {
  const file = join(dir, "collapse.ts")
  await writeFile(file, "content here\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup() // second group active, holds a clone

  await render()
  await waitForText("content here")
  expect(textareas()).toHaveLength(2)

  // Close the active (second) group's only tab → collapse to a single pane.
  workbenchStore.closeActiveTab()
  await testSetup!.flush()

  expect(workbenchStore.getState().groups).toHaveLength(1)
  expect(textareas()).toHaveLength(1)
})

test("editor.closeActiveTab closes the active group's active tab", async () => {
  const a = join(dir, "a.ts")
  const b = join(dir, "b.ts")
  await writeFile(a, "aaa\n")
  await writeFile(b, "bbb\n")
  workbenchStore.openFile(a, { preview: false })
  workbenchStore.openFile(b, { preview: false }) // active

  await render()
  await waitForText("bbb")
  expect(workbenchStore.getState().groups[0].activeTabPath).toBe(b)

  expect(registry!.executeCommand("editor.closeActiveTab")).toBe(true)
  await testSetup!.flush()

  const group = workbenchStore.getState().groups[0]
  expect(group.tabs.map((t) => t.path)).toEqual([a])
  expect(group.activeTabPath).toBe(a)
})

test("editor.nextTab / editor.previousTab cycle tabs in positional order", async () => {
  const a = join(dir, "a.ts")
  const b = join(dir, "b.ts")
  await writeFile(a, "aaa\n")
  await writeFile(b, "bbb\n")
  workbenchStore.openFile(a, { preview: false })
  workbenchStore.openFile(b, { preview: false }) // active (index 1)

  await render()
  await waitForText("bbb")

  // Next from index 1 wraps to index 0 (a).
  expect(registry!.executeCommand("editor.nextTab")).toBe(true)
  await testSetup!.flush()
  expect(workbenchStore.getState().groups[0].activeTabPath).toBe(a)

  // Previous from index 0 wraps back to index 1 (b).
  expect(registry!.executeCommand("editor.previousTab")).toBe(true)
  await testSetup!.flush()
  expect(workbenchStore.getState().groups[0].activeTabPath).toBe(b)
})

test("editorFocused=false blurs every pane; restoring it focuses only the active group", async () => {
  const file = join(dir, "focus.ts")
  await writeFile(file, "line one\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup() // second (right) group becomes active

  // Sidebar owns workbench focus at first: editorFocused starts false.
  await renderFocusHarness(false)
  await waitForText("line one")

  const focusedCount = () => textareas().filter((t) => t.focused).length

  // Both panes exist but NEITHER is focused — no textarea receives keystrokes
  // while the sidebar has focus.
  expect(textareas()).toHaveLength(2)
  expect(focusedCount()).toBe(0)

  // Returning focus to the editor (Esc in the real app) focuses ONLY the active
  // (right) group's pane, not both.
  await act(async () => {
    setEditorFocused!(true)
  })
  await testSetup!.flush()
  expect(focusedCount()).toBe(1)
  expect(textareas()[0].focused).toBe(false)
  expect(textareas()[1].focused).toBe(true)

  // Flipping back to the sidebar blurs it again.
  await act(async () => {
    setEditorFocused!(false)
  })
  await testSetup!.flush()
  expect(focusedCount()).toBe(0)
})

test("the active pane shows an accent border ONLY while the editor is focused", async () => {
  const file = join(dir, "accent.ts")
  await writeFile(file, "line one\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup() // group1 (right) becomes active

  // Editor starts focused so the accent is visible on the active pane.
  await renderFocusHarness(true)
  await waitForText("line one")

  const accent = hexRgb(theme.accent)
  const neutral = hexRgb(theme.border)
  const [g0, g1] = workbenchStore.getState().groups

  // Only the active (right) pane carries the accent border; the other stays neutral.
  expect(paneBorderRgb(g1.id)).toEqual(accent)
  expect(paneBorderRgb(g0.id)).toEqual(neutral)

  // Move active group to the left: the accent follows it, exactly one pane accented.
  workbenchStore.focusGroupByIndex(0)
  await testSetup!.flush()
  expect(paneBorderRgb(g0.id)).toEqual(accent)
  expect(paneBorderRgb(g1.id)).toEqual(neutral)

  // Sidebar takes focus: NO pane shows the accent, active or not.
  await act(async () => {
    setEditorFocused!(false)
  })
  await testSetup!.flush()
  expect(paneBorderRgb(g0.id)).toEqual(neutral)
  expect(paneBorderRgb(g1.id)).toEqual(neutral)
})

test("dragging the divider grows the left pane and preserves proportions on resize", async () => {
  const file = join(dir, "a.ts")
  await writeFile(file, "const answer = 42\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup()

  await renderFull()
  await waitForText("const answer")

  const [g0, g1] = workbenchStore.getState().groups
  const leftBefore = geom(`editor-group-${g0.id}`).width
  const dividerX = geom(`editor-group-${g0.id}`).x + leftBefore

  // Drag the sash ~10 columns to the right → the left pane widens by ~10.
  await dragDivider(dividerX, dividerX + 10)
  await testSetup!.flush()

  const leftAfter = geom(`editor-group-${g0.id}`).width
  expect(leftAfter - leftBefore).toBeGreaterThanOrEqual(7)
  expect(leftAfter - leftBefore).toBeLessThanOrEqual(12)

  // Sizes are fractions, so the ratio is what must survive a terminal resize.
  const rightAfter = geom(`editor-group-${g1.id}`).width
  const ratioBefore = leftAfter / rightAfter
  const sizesBefore = [...workbenchStore.getState().sizes]

  testSetup!.resize(120, 12)
  await testSetup!.flush()

  // The stored fractions are untouched by the resize…
  expect(workbenchStore.getState().sizes).toEqual(sizesBefore)
  // …and the on-screen proportions come back the same (both panes scaled up).
  const leftWide = geom(`editor-group-${g0.id}`).width
  const rightWide = geom(`editor-group-${g1.id}`).width
  expect(leftWide).toBeGreaterThan(leftAfter)
  expect(leftWide / rightWide).toBeCloseTo(ratioBefore, 1)
})

test("dragging the divider resizes even when the first motion lands off the sash", async () => {
  const file = join(dir, "a.ts")
  await writeFile(file, "const answer = 42\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup()

  await renderFull()
  await waitForText("const answer")

  const [g0] = workbenchStore.getState().groups
  const leftBefore = geom(`editor-group-${g0.id}`).width
  const dividerX = geom(`editor-group-${g0.id}`).x + leftBefore

  // The first (and only) drag event is already 8 cells past the sash, so the
  // renderer captures the neighboring pane — the real-world bug that left the
  // sash's own handler dead. The row ancestor must service the bubbled drag.
  await dragDividerFast(dividerX, dividerX + 8)
  await testSetup!.flush()

  const leftAfter = geom(`editor-group-${g0.id}`).width
  expect(leftAfter - leftBefore).toBeGreaterThanOrEqual(5)
})

test("double-clicking the divider resets the split back to equal widths", async () => {
  const file = join(dir, "a.ts")
  await writeFile(file, "const answer = 42\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup()

  await renderFull()
  await waitForText("const answer")

  const [g0] = workbenchStore.getState().groups
  const dividerX = geom(`editor-group-${g0.id}`).x + geom(`editor-group-${g0.id}`).width

  // Skew the split first.
  await dragDivider(dividerX, dividerX + 12)
  await testSetup!.flush()
  expect(workbenchStore.getState().sizes[0]).toBeGreaterThan(0.6)

  // Double-click the (now shifted) sash → equal fractions again.
  const newDividerX = geom(`editor-group-${g0.id}`).x + geom(`editor-group-${g0.id}`).width
  await testSetup!.mockMouse.doubleClick(newDividerX, 5)
  await testSetup!.flush()

  expect(workbenchStore.getState().sizes).toEqual([0.5, 0.5])
})

test("Grow / Shrink Editor Group commands nudge the active group's fraction", async () => {
  const file = join(dir, "a.ts")
  await writeFile(file, "const answer = 42\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup() // group1 (right) is active

  await renderFull()
  await waitForText("const answer")

  // The active group is the right one; growing it must shrink sizes[0].
  expect(registry!.executeCommand("workbench.growEditorGroup")).toBe(true)
  await testSetup!.flush()
  expect(workbenchStore.getState().sizes[1]).toBeGreaterThan(0.5)

  // Shrinking brings it back below where the grow left it.
  const grown = workbenchStore.getState().sizes[1]
  expect(registry!.executeCommand("workbench.shrinkEditorGroup")).toBe(true)
  await testSetup!.flush()
  expect(workbenchStore.getState().sizes[1]).toBeLessThan(grown)
})

test("Grow / Shrink nudges a non-last active group via its RIGHT divider", async () => {
  const file = join(dir, "a.ts")
  await writeFile(file, "const answer = 42\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup() // group1 (right) active
  workbenchStore.focusGroupByIndex(0) // focus the LEFT group — not the last one

  await renderFull()
  await waitForText("const answer")

  // The active group is non-last, so growing it borrows across divider 0: sizes[0] rises.
  expect(registry!.executeCommand("workbench.growEditorGroup")).toBe(true)
  await testSetup!.flush()
  expect(workbenchStore.getState().sizes[0]).toBeGreaterThan(0.5)

  const grown = workbenchStore.getState().sizes[0]
  expect(registry!.executeCommand("workbench.shrinkEditorGroup")).toBe(true)
  await testSetup!.flush()
  expect(workbenchStore.getState().sizes[0]).toBeLessThan(grown)
})

test("repeated Split Editor stops once panes would fall below the min-cell floor", async () => {
  const file = join(dir, "cap.ts")
  await writeFile(file, "cap line\n")
  workbenchStore.openFile(file, { preview: false })

  await renderFull() // 80-cell-wide editor area
  await waitForText("cap line")

  // Fire far more splits than could ever fit; the splitEditor command self-caps.
  for (let i = 0; i < 8; i++) {
    expect(registry!.executeCommand("workbench.splitEditor")).toBe(true)
    await testSetup!.flush()
  }

  // 80 cells: 3 panes (~26 cells each) clear the 20-cell floor; a 4th (~19) would not.
  expect(workbenchStore.getState().groups).toHaveLength(3)
  for (const f of workbenchStore.getState().sizes) expect(f).toBeGreaterThan(0)
})

test("registers each tab command exactly once even with two panes split", async () => {
  const file = join(dir, "once.ts")
  await writeFile(file, "x\n")
  workbenchStore.openFile(file, { preview: false })
  workbenchStore.splitGroup() // two panes render simultaneously

  await render()
  await waitForText("x")
  expect(textareas()).toHaveLength(2)

  const ids = registry!.getCommands().map((c) => c.id)
  for (const id of ["editor.save", "editor.closeActiveTab", "editor.nextTab", "editor.previousTab"]) {
    expect(ids.filter((x) => x === id)).toHaveLength(1)
  }
})

test("editor.save writes the ACTIVE group's file, leaving the other pane's dirty file untouched", async () => {
  const a = join(dir, "a.ts")
  const b = join(dir, "b.ts")
  await writeFile(a, "aaa\n")
  await writeFile(b, "bbb\n")
  const docA = await documentRegistry.openDocument(a)
  const docB = await documentRegistry.openDocument(b)

  // Two groups showing DIFFERENT files: group 1 = a.ts, group 2 = b.ts (active).
  workbenchStore.openFile(a, { preview: false })
  workbenchStore.splitGroup()
  workbenchStore.openFile(b, { preview: false })

  await render()
  await waitForText("bbb")

  docA.setText("AAA-edit\n", "edit")
  docB.setText("BBB-edit\n", "edit")
  expect(docA.isDirty).toBe(true)
  expect(docB.isDirty).toBe(true)

  // Group 2 (b.ts) is active: save must persist b.ts only, not a.ts.
  expect(registry!.executeCommand("editor.save")).toBe(true)
  const start = Date.now()
  while (Date.now() - start < 2000 && docB.isDirty) await Bun.sleep(20)

  expect(await Bun.file(b).text()).toBe("BBB-edit\n")
  expect(docB.isDirty).toBe(false)
  expect(await Bun.file(a).text()).toBe("aaa\n")
  expect(docA.isDirty).toBe(true)

  // Refocus group 1 and save: now a.ts is written.
  workbenchStore.focusGroupByIndex(0)
  await testSetup!.flush()
  expect(registry!.executeCommand("editor.save")).toBe(true)
  const start2 = Date.now()
  while (Date.now() - start2 < 2000 && docA.isDirty) await Bun.sleep(20)
  expect(await Bun.file(a).text()).toBe("AAA-edit\n")
  expect(docA.isDirty).toBe(false)

  documentRegistry.releaseDocument(a)
  documentRegistry.releaseDocument(b)
})
