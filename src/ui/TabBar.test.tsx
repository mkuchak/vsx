import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act } from "react"
import { type Document, documentRegistry } from "../model/documents.ts"
import { workbenchStore } from "../model/workbench.ts"
import { destroyRendererAndWait } from "../testUtils/rendererTeardown.ts"
import { CommandsProvider } from "../workbench/CommandsProvider.tsx"
import { TabBar } from "./TabBar.tsx"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined
let root: string

beforeEach(async () => {
  workbenchStore.reset()
  root = await mkdtemp(join(tmpdir(), "vsx-tabbar-"))
})

afterEach(async () => {
  if (testSetup) await destroyRendererAndWait(testSetup.renderer)
  testSetup = undefined
  await rm(root, { recursive: true, force: true })
})

async function renderTabBar(width = 80, height = 6) {
  const setup = await testRender(
    <CommandsProvider>
      <TabBar groupId={workbenchStore.getState().activeGroupId} />
    </CommandsProvider>,
    { width, height },
  )
  await setup.renderOnce()
  return setup
}

/**
 * Let useDocument's async openDocument resolve (and its onDidChange/onDidSave
 * subscriptions attach), flush any resulting React state updates, then paint a
 * frame so captureCharFrame reflects the latest state.
 */
async function settle(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => {
    await Bun.sleep(10)
  })
  await setup.renderOnce()
}

/** Apply a (possibly async) document mutation inside act, then repaint. */
async function mutate(
  setup: Awaited<ReturnType<typeof testRender>>,
  fn: () => void | Promise<void>,
): Promise<void> {
  await act(async () => {
    await fn()
  })
  await setup.renderOnce()
}

/**
 * Wrap a Document's subscribe methods to count live listeners, so a test can
 * assert every mount's subscription is torn down on unmount (no leak).
 */
function trackListeners(doc: Document): () => number {
  let count = 0
  const origChange = doc.onDidChange.bind(doc)
  const origSave = doc.onDidSave.bind(doc)
  const wrapped = doc as { onDidChange: Document["onDidChange"]; onDidSave: Document["onDidSave"] }
  wrapped.onDidChange = (cb) => {
    count++
    const off = origChange(cb)
    return () => {
      count--
      off()
    }
  }
  wrapped.onDidSave = (cb) => {
    count++
    const off = origSave(cb)
    return () => {
      count--
      off()
    }
  }
  return () => count
}

/** True if any span containing `substr` is rendered italic. */
function hasItalic(setup: NonNullable<typeof testSetup>, substr: string): boolean {
  const frame = setup.captureSpans()
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes(substr) && (span.attributes & TextAttributes.ITALIC) !== 0) {
        return true
      }
    }
  }
  return false
}

test("renders a tab per open file", async () => {
  workbenchStore.openFile("/dir/alpha.ts", { preview: false })
  workbenchStore.openFile("/dir/beta.ts", { preview: false })

  testSetup = await renderTabBar()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("alpha.ts")
  expect(frame).toContain("beta.ts")
})

test("preview tab renders italic", async () => {
  workbenchStore.openFile("/dir/preview.ts") // preview by default

  testSetup = await renderTabBar()

  expect(hasItalic(testSetup, "preview.ts")).toBe(true)
})

test("permanent tab is not italic", async () => {
  workbenchStore.openFile("/dir/perm.ts", { preview: false })

  testSetup = await renderTabBar()

  expect(hasItalic(testSetup, "perm.ts")).toBe(false)
})

describe("dirty indicator", () => {
  test("dirty document shows a ● prefix", async () => {
    const path = join(root, "dirty.ts")
    await writeFile(path, "hello")
    const doc = await documentRegistry.openDocument(path)
    doc.setText("hello world", "edit") // makes it dirty

    workbenchStore.openFile(path, { preview: false })

    testSetup = await renderTabBar()

    expect(testSetup.captureCharFrame()).toContain("● dirty.ts")

    documentRegistry.releaseDocument(path)
  })

  test("editing a permanent tab shows the dot live with no other store action", async () => {
    const path = join(root, "edit.ts")
    await writeFile(path, "hello")
    workbenchStore.openFile(path, { preview: false })

    testSetup = await renderTabBar()
    await settle(testSetup) // let useDocument open + subscribe
    expect(testSetup.captureCharFrame()).not.toContain("●")

    const doc = documentRegistry.get(path)!
    await mutate(testSetup, () => doc.setText("hello world", "edit"))

    expect(testSetup.captureCharFrame()).toContain("● edit.ts")
  })

  test("saving a dirty tab clears the dot immediately", async () => {
    const path = join(root, "save.ts")
    await writeFile(path, "hello")
    workbenchStore.openFile(path, { preview: false })

    testSetup = await renderTabBar()
    await settle(testSetup)

    const doc = documentRegistry.get(path)!
    await mutate(testSetup, () => doc.setText("hello world", "edit"))
    expect(testSetup.captureCharFrame()).toContain("● save.ts")

    await mutate(testSetup, () => doc.save())
    const frame = testSetup.captureCharFrame()
    expect(frame).not.toContain("●")
    expect(frame).toContain("save.ts")
  })

  test("a file tab dots when dirty but its diff tab never does", async () => {
    const path = join(root, "shared.ts")
    await writeFile(path, "hello")
    workbenchStore.openFile(path, { preview: false })
    workbenchStore.openDiff(path, "unstaged", "/repo", { preview: false })

    testSetup = await renderTabBar()
    await settle(testSetup)

    const doc = documentRegistry.get(path)!
    await mutate(testSetup, () => doc.setText("edited", "edit"))

    const line = testSetup.captureCharFrame().split("\n")[0]
    // Exactly one ● — on the file tab, never on the diff view.
    expect(line.split("●").length - 1).toBe(1)
    expect(line).toContain("● shared.ts")
    expect(line).toContain("Working Tree")
  })

  test("repeated mount/unmount cycles leak no document listeners", async () => {
    const path = join(root, "leak.ts")
    await writeFile(path, "hello")
    // A test-held ref keeps the doc alive across resets so we track ONE instance.
    const doc = await documentRegistry.openDocument(path)
    const liveListeners = trackListeners(doc)

    for (let i = 0; i < 3; i++) {
      workbenchStore.reset()
      workbenchStore.openFile(path, { preview: false })
      const setup = await renderTabBar()
      await settle(setup) // ensure the subscription actually attached while mounted
      // unmounts React, running useDocument's cleanup
      await destroyRendererAndWait(setup.renderer)
      await act(async () => {
        await Bun.sleep(0)
      })
    }

    expect(liveListeners()).toBe(0)
    documentRegistry.releaseDocument(path)
  })
})

test("clicking a tab activates it", async () => {
  workbenchStore.openFile("/dir/one.ts", { preview: false })
  workbenchStore.openFile("/dir/two.ts", { preview: false })
  expect(workbenchStore.getState().groups[0].activeTabPath).toBe("/dir/two.ts")

  testSetup = await renderTabBar()

  // one.ts sits at the far left; click inside its label.
  await testSetup.mockMouse.click(2, 0)
  await testSetup.renderOnce()

  expect(workbenchStore.getState().groups[0].activeTabPath).toBe("/dir/one.ts")
})

test("double-click promotes a preview tab to permanent", async () => {
  workbenchStore.openFile("/dir/preview.ts") // preview
  expect(workbenchStore.getState().groups[0].tabs[0].preview).toBe(true)

  testSetup = await renderTabBar()

  await testSetup.mockMouse.doubleClick(2, 0)
  await testSetup.renderOnce()

  expect(workbenchStore.getState().groups[0].tabs[0].preview).toBe(false)
})

test("close button (✕) renders only on the active tab", async () => {
  workbenchStore.openFile("/dir/a.ts", { preview: false })
  workbenchStore.openFile("/dir/b.ts", { preview: false }) // active

  testSetup = await renderTabBar()

  const line = testSetup.captureCharFrame().split("\n")[0]
  // Exactly one ✕, and it sits on the active tab (b.ts), not the inactive a.ts.
  expect(line.split("✕").length - 1).toBe(1)
  expect(line.indexOf("✕")).toBeGreaterThan(line.indexOf("b.ts"))
})

test("clicking a tab in a non-focused group focuses that group and activates within it", async () => {
  workbenchStore.openFile("/dir/a.ts", { preview: false })
  workbenchStore.openFile("/dir/b.ts", { preview: false }) // group0 active tab: /b.ts
  workbenchStore.splitGroup({ copyActiveTab: false }) // group1 becomes active + empty
  const [g0, g1] = workbenchStore.getState().groups
  expect(workbenchStore.getState().activeGroupId).toBe(g1.id)

  // Render the NON-focused first group's tab strip.
  testSetup = await testRender(
    <CommandsProvider>
      <TabBar groupId={g0.id} />
    </CommandsProvider>,
    { width: 80, height: 6 },
  )
  await testSetup.renderOnce()

  // /a.ts sits at the far left; click inside its label.
  await testSetup.mockMouse.click(2, 0)
  await testSetup.renderOnce()

  // Group0 both became focused AND had /a.ts activated within it.
  expect(workbenchStore.getState().activeGroupId).toBe(g0.id)
  expect(workbenchStore.getState().groups[0].activeTabPath).toBe("/dir/a.ts")
})

test("double-clicking a preview tab promotes it within its own group only", async () => {
  workbenchStore.openFile("/dir/a.ts") // group0 preview tab
  workbenchStore.splitGroup({ copyActiveTab: false }) // group1 active + empty
  workbenchStore.openFile("/dir/b.ts") // group1 preview tab
  const [g0, g1] = workbenchStore.getState().groups
  expect(g0.tabs[0].preview).toBe(true)
  expect(g1.tabs[0].preview).toBe(true)

  // Render (and double-click) the non-focused first group's tab.
  testSetup = await testRender(
    <CommandsProvider>
      <TabBar groupId={g0.id} />
    </CommandsProvider>,
    { width: 80, height: 6 },
  )
  await testSetup.renderOnce()

  await testSetup.mockMouse.doubleClick(2, 0)
  await testSetup.renderOnce()

  const groups = workbenchStore.getState().groups
  expect(groups[0].tabs[0].preview).toBe(false) // group0's tab promoted
  expect(groups[1].tabs[0].preview).toBe(true) // group1's preview untouched
})

test("clicking the ✕ closes that tab without re-activating via bubbling", async () => {
  workbenchStore.openFile("/dir/a.ts", { preview: false })
  workbenchStore.openFile("/dir/b.ts", { preview: false }) // active + shows ✕
  expect(workbenchStore.getState().groups[0].activeTabPath).toBe("/dir/b.ts")

  testSetup = await renderTabBar()

  const x = testSetup.captureCharFrame().split("\n")[0].indexOf("✕")
  await testSetup.mockMouse.click(x, 0)
  await testSetup.renderOnce()

  const group = workbenchStore.getState().groups[0]
  expect(group.tabs.map((t) => t.path)).toEqual(["/dir/a.ts"])
  expect(group.activeTabPath).toBe("/dir/a.ts")
})
