import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkbenchStore } from "./workbench.ts"
import { documentRegistry } from "./documents.ts"

function activeTabs(store: WorkbenchStore): string[] {
  return store.getState().groups[0].tabs.map((t) => t.path)
}

function activePath(store: WorkbenchStore): string | null {
  return store.getState().groups[0].activeTabPath
}

function tab(store: WorkbenchStore, path: string) {
  return store.getState().groups[0].tabs.find((t) => t.path === path)
}

describe("preview semantics", () => {
  test("preview:true reuses the single preview tab (replaces path, no new tab)", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts")
    store.openFile("/b.ts")

    expect(activeTabs(store)).toEqual(["/b.ts"])
    expect(tab(store, "/b.ts")?.preview).toBe(true)
    expect(activePath(store)).toBe("/b.ts")
  })

  test("preview:false always opens/activates a permanent tab", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.openFile("/b.ts", { preview: false })

    expect(activeTabs(store)).toEqual(["/a.ts", "/b.ts"])
    expect(tab(store, "/a.ts")?.preview).toBe(false)
    expect(tab(store, "/b.ts")?.preview).toBe(false)
    expect(activePath(store)).toBe("/b.ts")
  })

  test("preview:true on an existing permanent tab just activates it", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.openFile("/b.ts", { preview: false })
    store.openFile("/a.ts")

    expect(activeTabs(store)).toEqual(["/a.ts", "/b.ts"])
    expect(tab(store, "/a.ts")?.preview).toBe(false)
    expect(activePath(store)).toBe("/a.ts")
  })

  test("preview:false on an already-open preview tab promotes it in place", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts")
    expect(tab(store, "/a.ts")?.preview).toBe(true)

    store.openFile("/a.ts", { preview: false })
    expect(activeTabs(store)).toEqual(["/a.ts"])
    expect(tab(store, "/a.ts")?.preview).toBe(false)
  })

  test("a permanent tab is untouched when a new preview tab is opened", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.openFile("/b.ts")
    store.openFile("/c.ts")

    // The permanent /a.ts stays; the preview slot swapped /b.ts -> /c.ts.
    expect(activeTabs(store)).toEqual(["/a.ts", "/c.ts"])
    expect(tab(store, "/c.ts")?.preview).toBe(true)
  })
})

describe("promotion", () => {
  test("explicit promoteTab promotes a preview tab", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts")
    store.promoteTab("/a.ts")
    expect(tab(store, "/a.ts")?.preview).toBe(false)
  })

  test("promoteActiveIfPreview promotes the active preview tab", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts")
    store.promoteActiveIfPreview()
    expect(tab(store, "/a.ts")?.preview).toBe(false)
  })

  test("promoteTabInGroup promotes a preview tab in a NON-active group", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts") // preview tab in group-0
    store.splitGroup({ copyActiveTab: false }) // group-1 is now active
    store.openFile("/b.ts") // preview tab in the now-active group-1

    const [g0, g1] = store.getState().groups
    // group-0 is NOT the active group, but its preview tab must still promote.
    store.promoteTabInGroup(g0.id, "/a.ts")

    expect(g0.tabs.find((t) => t.path === "/a.ts")?.preview).toBe(false)
    // The active group's preview tab is untouched.
    expect(g1.tabs.find((t) => t.path === "/b.ts")?.preview).toBe(true)
  })

  test("promoteTabInGroup is a no-op for an unknown group or tab", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts")
    const groupId = store.getState().groups[0].id

    store.promoteTabInGroup("group-nope", "/a.ts")
    store.promoteTabInGroup(groupId, "/missing.ts")

    expect(tab(store, "/a.ts")?.preview).toBe(true)
  })
})

describe("close + MRU", () => {
  test("closing the active tab activates the MRU-previous tab", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.openFile("/b.ts", { preview: false })
    store.openFile("/c.ts", { preview: false })

    // Activate a, then b -> MRU is [b, a, c]. Close b -> a is front.
    store.activateTab("/a.ts")
    store.activateTab("/b.ts")
    store.closeTab("/b.ts")

    expect(activePath(store)).toBe("/a.ts")
    expect(activeTabs(store)).toEqual(["/a.ts", "/c.ts"])
  })

  test("closing the last tab leaves no active tab", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.closeTab("/a.ts")
    expect(activePath(store)).toBeNull()
    expect(activeTabs(store)).toEqual([])
  })

  test("closing a non-active tab keeps the active tab", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.openFile("/b.ts", { preview: false })
    store.closeTab("/a.ts")
    expect(activePath(store)).toBe("/b.ts")
    expect(activeTabs(store)).toEqual(["/b.ts"])
  })
})

describe("positional cycling", () => {
  test("next/prev cycle in array order and wrap", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.openFile("/b.ts", { preview: false })
    store.openFile("/c.ts", { preview: false })

    store.activateTab("/a.ts")
    store.activateNextTab()
    expect(activePath(store)).toBe("/b.ts")
    store.activateNextTab()
    expect(activePath(store)).toBe("/c.ts")
    store.activateNextTab()
    expect(activePath(store)).toBe("/a.ts") // wrap
    store.activatePrevTab()
    expect(activePath(store)).toBe("/c.ts") // wrap back
  })
})

describe("diff tabs", () => {
  test("openDiff creates a kind:'diff' tab and activates it", () => {
    const store = new WorkbenchStore()
    store.openDiff("/repo/a.ts", "unstaged", "/repo")

    const tabs = store.getState().groups[0].tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].kind).toBe("diff")
    const diff = tabs[0]
    if (diff.kind !== "diff") throw new Error("expected diff tab")
    expect(diff.filePath).toBe("/repo/a.ts")
    expect(diff.diffKind).toBe("unstaged")
    expect(diff.repoRoot).toBe("/repo")
    expect(activePath(store)).toBe(diff.path)
  })

  test("opening the same path+diffKind reuses/activates the existing diff tab", () => {
    const store = new WorkbenchStore()
    store.openDiff("/repo/a.ts", "unstaged", "/repo", { preview: false })
    store.openFile("/repo/b.ts", { preview: false })
    store.openDiff("/repo/a.ts", "unstaged", "/repo", { preview: false })

    const tabs = store.getState().groups[0].tabs
    const diffTabs = tabs.filter((t) => t.kind === "diff")
    expect(diffTabs).toHaveLength(1)
    expect(activeTabs(store)).toHaveLength(2) // the diff tab + b.ts, no duplicate
    // The dedup reactivates the diff tab.
    expect(activePath(store)).toBe(diffTabs[0].path)
  })

  test("dedup reuses a diff tab even when it is a permanent (non-preview) tab", () => {
    const store = new WorkbenchStore()
    store.openDiff("/repo/a.ts", "staged", "/repo", { preview: false })
    store.openDiff("/repo/a.ts", "staged", "/repo") // preview open of same comparison

    expect(store.getState().groups[0].tabs).toHaveLength(1)
  })

  test("staged and unstaged diffs of the same file are distinct tabs", () => {
    const store = new WorkbenchStore()
    store.openDiff("/repo/a.ts", "unstaged", "/repo", { preview: false })
    store.openDiff("/repo/a.ts", "staged", "/repo", { preview: false })

    expect(store.getState().groups[0].tabs.filter((t) => t.kind === "diff")).toHaveLength(2)
  })

  test("a file tab and a diff tab for the same path coexist", () => {
    const store = new WorkbenchStore()
    store.openFile("/repo/a.ts", { preview: false })
    store.openDiff("/repo/a.ts", "unstaged", "/repo", { preview: false })

    const tabs = store.getState().groups[0].tabs
    expect(tabs).toHaveLength(2)
    expect(tabs.some((t) => t.kind === "file" && t.path === "/repo/a.ts")).toBe(true)
    expect(tabs.some((t) => t.kind === "diff" && t.filePath === "/repo/a.ts")).toBe(true)
  })

  test("a preview diff tab reuses the single preview slot", () => {
    const store = new WorkbenchStore()
    store.openFile("/repo/a.ts") // preview file tab
    store.openDiff("/repo/b.ts", "unstaged", "/repo") // preview diff reuses the slot

    const tabs = store.getState().groups[0].tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].kind).toBe("diff")
  })

  test("closeActiveTab closes a diff tab like any other", () => {
    const store = new WorkbenchStore()
    store.openDiff("/repo/a.ts", "unstaged", "/repo", { preview: false })
    store.closeActiveTab()
    expect(store.getState().groups[0].tabs).toHaveLength(0)
    expect(activePath(store)).toBeNull()
  })
})

describe("commit-diff tabs", () => {
  test("openCommitDiff creates a kind:'commitDiff' tab and activates it", () => {
    const store = new WorkbenchStore()
    store.openCommitDiff("/repo/a.ts", "parentsha", "commitsha", "/repo", "a.ts (commits)")

    const tabs = store.getState().groups[0].tabs
    expect(tabs).toHaveLength(1)
    const t = tabs[0]
    if (t.kind !== "commitDiff") throw new Error("expected commitDiff tab")
    expect(t.filePath).toBe("/repo/a.ts")
    expect(t.oldRef).toBe("parentsha")
    expect(t.newRef).toBe("commitsha")
    expect(t.repoRoot).toBe("/repo")
    expect(t.label).toBe("a.ts (commits)")
    expect(activePath(store)).toBe(t.path)
  })

  test("opening the same file+refs reuses/activates the existing commitDiff tab", () => {
    const store = new WorkbenchStore()
    store.openCommitDiff("/repo/a.ts", "p", "c", "/repo", "a.ts (c)", { preview: false })
    store.openFile("/repo/b.ts", { preview: false })
    store.openCommitDiff("/repo/a.ts", "p", "c", "/repo", "a.ts (c)", { preview: false })

    const tabs = store.getState().groups[0].tabs
    const commitDiffs = tabs.filter((t) => t.kind === "commitDiff")
    expect(commitDiffs).toHaveLength(1)
    expect(activeTabs(store)).toHaveLength(2)
    expect(activePath(store)).toBe(commitDiffs[0].path)
  })

  test("the same file at different commits are distinct commitDiff tabs", () => {
    const store = new WorkbenchStore()
    store.openCommitDiff("/repo/a.ts", "p1", "c1", "/repo", "a.ts (c1)", { preview: false })
    store.openCommitDiff("/repo/a.ts", "p2", "c2", "/repo", "a.ts (c2)", { preview: false })

    expect(store.getState().groups[0].tabs.filter((t) => t.kind === "commitDiff")).toHaveLength(2)
  })

  test("a commitDiff tab and a file tab for the same underlying path coexist", () => {
    const store = new WorkbenchStore()
    store.openFile("/repo/a.ts", { preview: false })
    store.openCommitDiff("/repo/a.ts", "p", "c", "/repo", "a.ts (c)", { preview: false })

    const tabs = store.getState().groups[0].tabs
    expect(tabs).toHaveLength(2)
    expect(tabs.some((t) => t.kind === "file" && t.path === "/repo/a.ts")).toBe(true)
    expect(tabs.some((t) => t.kind === "commitDiff" && t.filePath === "/repo/a.ts")).toBe(true)
  })

  test("a preview commitDiff tab reuses the single preview slot", () => {
    const store = new WorkbenchStore()
    store.openFile("/repo/a.ts") // preview file tab
    store.openCommitDiff("/repo/b.ts", "p", "c", "/repo", "b.ts (c)") // preview reuses slot

    const tabs = store.getState().groups[0].tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].kind).toBe("commitDiff")
  })
})

describe("split editor groups", () => {
  test("splitGroup creates a second group and copies the active tab by default", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup()

    const { groups, activeGroupId } = store.getState()
    expect(groups).toHaveLength(2)
    // The new group is focused, VSCode-style.
    expect(activeGroupId).toBe(groups[1].id)
    // The active tab's identity was cloned into the new group as a permanent tab.
    expect(groups[1].tabs.map((t) => t.path)).toEqual(["/a.ts"])
    expect(groups[1].tabs[0].preview).toBe(false)
    expect(groups[1].activeTabPath).toBe("/a.ts")
  })

  test("the cloned tab is a distinct object, not a shared reference", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup()

    const { groups } = store.getState()
    const left = groups[0].tabs[0]
    const right = groups[1].tabs[0]
    expect(right).not.toBe(left)
    // Both reference the SAME underlying file path (shared Document by construction).
    expect(right.path).toBe(left.path)
    // Mutating one must never affect the other.
    right.pinned = true
    expect(left.pinned).toBe(false)
  })

  test("splitGroup({copyActiveTab:false}) creates an empty second group", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup({ copyActiveTab: false })

    const { groups } = store.getState()
    expect(groups).toHaveLength(2)
    expect(groups[1].tabs).toEqual([])
    expect(groups[1].activeTabPath).toBeNull()
  })

  test("splitting is unbounded: three splits yield four groups, sizes renormalized", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup() // 2 groups
    store.splitGroup() // 3 groups
    store.splitGroup() // 4 groups

    const { groups, sizes } = store.getState()
    expect(groups).toHaveLength(4)
    expect(sizes).toHaveLength(4)
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    // Each split inserts adjacent to the (newly active) source, halving its slot:
    // [1] → [.5,.5] → [.5,.25,.125,.125].
    expect(sizes).toEqual([0.5, 0.25, 0.125, 0.125])
  })

  test("splitGroup with maxGroups is a silent no-op once the cap is reached", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup({ maxGroups: 2 }) // 1 → 2, allowed
    expect(store.getState().groups).toHaveLength(2)

    // At the cap: no new group, no size change, active group unchanged.
    const sizesBefore = [...store.getState().sizes]
    const activeBefore = store.getState().activeGroupId
    store.splitGroup({ maxGroups: 2 })
    expect(store.getState().groups).toHaveLength(2)
    expect(store.getState().sizes).toEqual(sizesBefore)
    expect(store.getState().activeGroupId).toBe(activeBefore)
  })

  test("a deep split followed by an extreme resize never yields a negative fraction", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    for (let i = 0; i < 6; i++) store.splitGroup() // uncapped: panes get very thin
    // A large minFraction relative to the thin rightmost pair — the exact shape
    // that used to write a negative fraction — must clamp safely instead.
    store.resizeSplit(store.getState().sizes.length - 2, 5, 0.645)
    for (const f of store.getState().sizes) expect(f).toBeGreaterThanOrEqual(0)
    expect(store.getState().sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  test("focusNextGroup / focusPrevGroup cycle positionally past four groups", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    // Split four times from the first group so new columns stack to its right,
    // giving five groups whose positional order is [g0, g4, g3, g2, g1].
    const g0 = store.getState().groups[0].id
    for (let i = 0; i < 4; i++) {
      store.focusGroup(g0)
      store.splitGroup({ copyActiveTab: false })
    }
    expect(store.getState().groups).toHaveLength(5)

    const ids = store.getState().groups.map((g) => g.id)
    store.focusGroupByIndex(0)
    store.focusNextGroup()
    expect(store.getState().activeGroupId).toBe(ids[1])
    // Jump to the last group, then wrap forward to the first.
    store.focusGroupByIndex(4)
    store.focusNextGroup()
    expect(store.getState().activeGroupId).toBe(ids[0])
    // Wrap backward from the first to the last.
    store.focusPrevGroup()
    expect(store.getState().activeGroupId).toBe(ids[4])
  })

  test("closing the last tab of a MIDDLE group re-lays-out the survivors", async () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    const g0 = store.getState().groups[0].id
    // Build three groups [g0, g2, g1] each holding one tab, then equalize sizes.
    store.splitGroup() // g1 active
    store.focusGroup(g0)
    store.splitGroup() // g2 active, inserted between g0 and g1
    store.resetSplitSizes()
    expect(store.getState().groups).toHaveLength(3)
    expect(store.getState().sizes).toEqual([1 / 3, 1 / 3, 1 / 3])

    // Close the sole tab of the MIDDLE group (index 1) via the real close path.
    const middle = store.getState().groups[1]
    store.focusGroup(middle.id)
    await store.closeActiveTab()

    const { groups, sizes } = store.getState()
    expect(groups).toHaveLength(2)
    // removeFraction hands the middle's third to its LEFT neighbor.
    expect(sizes[0]).toBeCloseTo(2 / 3)
    expect(sizes[1]).toBeCloseTo(1 / 3)
    // Focus falls to the group that slid into the vacated index.
    expect(store.getState().activeGroupId).toBe(groups[1].id)
  })

  test("focusGroup switches activeGroupId to an existing group", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup()
    const firstId = store.getState().groups[0].id

    store.focusGroup(firstId)
    expect(store.getState().activeGroupId).toBe(firstId)
  })

  test("focusGroup with an unknown id is a no-op", () => {
    const store = new WorkbenchStore()
    const before = store.getState().activeGroupId
    store.focusGroup("group-does-not-exist")
    expect(store.getState().activeGroupId).toBe(before)
  })

  test("focusGroupByIndex resolves the group at a positional index", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup()
    const [g0, g1] = store.getState().groups

    store.focusGroupByIndex(0)
    expect(store.getState().activeGroupId).toBe(g0.id)
    store.focusGroupByIndex(1)
    expect(store.getState().activeGroupId).toBe(g1.id)
    // Out of range: no change.
    store.focusGroupByIndex(5)
    expect(store.getState().activeGroupId).toBe(g1.id)
  })

  test("the same file open in both groups shares one path identity", () => {
    const store = new WorkbenchStore()
    store.openFile("/shared.ts", { preview: false })
    store.splitGroup()

    const [g0, g1] = store.getState().groups
    const leftPath = g0.tabs.find((t) => t.kind === "file")?.path
    const rightPath = g1.tabs.find((t) => t.kind === "file")?.path
    expect(leftPath).toBe("/shared.ts")
    expect(rightPath).toBe("/shared.ts")
  })

  test("closing the last tab in the second group collapses back to one group", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup() // second group is now active, holds a clone of /a.ts

    store.closeActiveTab()

    const { groups, activeGroupId } = store.getState()
    expect(groups).toHaveLength(1)
    // Re-focused onto the remaining (original) group.
    expect(activeGroupId).toBe(groups[0].id)
    expect(groups[0].tabs.map((t) => t.path)).toEqual(["/a.ts"])
  })

  test("emptying the FIRST group re-focuses the remaining group now at index 0", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup() // group1 (clone of /a.ts) is active
    const secondId = store.getState().groups[1].id
    const firstId = store.getState().groups[0].id

    // Give the first group focus, then close its only tab so it empties.
    store.focusGroup(firstId)
    store.closeActiveTab()

    const { groups, activeGroupId } = store.getState()
    expect(groups).toHaveLength(1)
    // The surviving group is the former second group; it now sits at index 0.
    expect(groups[0].id).toBe(secondId)
    expect(activeGroupId).toBe(secondId)
  })

  test("closing the last tab in the ONLY group leaves the group in place", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.closeActiveTab()

    const { groups } = store.getState()
    expect(groups).toHaveLength(1)
    expect(groups[0].tabs).toEqual([])
    expect(groups[0].activeTabPath).toBeNull()
  })

  test("activateTab targets a specific group without changing the active group", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.openFile("/b.ts", { preview: false }) // group0 active tab: /b.ts
    store.splitGroup({ copyActiveTab: false }) // group1 is now active + empty
    const [g0, g1] = store.getState().groups

    // Activate a tab in the NON-active first group by id.
    store.activateTab("/a.ts", g0.id)

    // Group0's active tab changed; the focused group is still group1.
    expect(store.getState().groups[0].activeTabPath).toBe("/a.ts")
    expect(store.getState().activeGroupId).toBe(g1.id)
  })

  test("activateTab is a no-op for a path not in the target group", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup({ copyActiveTab: false }) // group1 active + empty
    const [g0] = store.getState().groups

    // /missing.ts isn't in group0; activation must not change its active tab.
    store.activateTab("/missing.ts", g0.id)
    expect(store.getState().groups[0].activeTabPath).toBe("/a.ts")
  })

  test("activateTab / closeTab with an unknown group id are graceful no-ops", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })

    expect(() => store.activateTab("/a.ts", "group-nope")).not.toThrow()
    expect(() => store.closeTab("/a.ts", "group-nope")).not.toThrow()
    // Nothing was touched.
    expect(store.getState().groups[0].tabs.map((t) => t.path)).toEqual(["/a.ts"])
    expect(store.getState().groups[0].activeTabPath).toBe("/a.ts")
  })

  test("closeTab targets a specific group without changing the active group", async () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.openFile("/b.ts", { preview: false })
    store.splitGroup({ copyActiveTab: false }) // group1 active + empty
    const [g0, g1] = store.getState().groups

    // Close a tab in the non-active first group by id.
    await store.closeTab("/a.ts", g0.id)

    expect(store.getState().groups[0].tabs.map((t) => t.path)).toEqual(["/b.ts"])
    expect(store.getState().activeGroupId).toBe(g1.id)
  })
})

describe("split sizes", () => {
  test("a fresh store has a single full-width group", () => {
    const store = new WorkbenchStore()
    expect(store.getState().sizes).toEqual([1])
  })

  test("splitGroup halves the source group's fraction between it and the new group", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup()
    expect(store.getState().sizes).toEqual([0.5, 0.5])
  })

  test("collapsing a group returns its fraction to the remaining neighbor", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup() // [0.5, 0.5], group1 active with a clone
    store.resizeSplit(0, 0.2, 0.1) // [0.7, 0.3]
    expect(store.getState().sizes[0]).toBeCloseTo(0.7)

    store.closeActiveTab() // group1 empties → collapse back to one group
    expect(store.getState().groups).toHaveLength(1)
    expect(store.getState().sizes).toEqual([1])
  })

  test("resizeSplit moves fraction across the divider and clamps at minFraction", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup() // [0.5, 0.5]

    store.resizeSplit(0, 0.2, 0.1)
    let sizes = store.getState().sizes
    expect(sizes[0]).toBeCloseTo(0.7)
    expect(sizes[1]).toBeCloseTo(0.3)

    // A large delta clamps the shrinking side to the minFraction floor.
    store.resizeSplit(0, 5, 0.15)
    sizes = store.getState().sizes
    expect(sizes[0]).toBeCloseTo(0.85)
    expect(sizes[1]).toBeCloseTo(0.15)
  })

  test("resizeSplit is a no-op for an out-of-range divider", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup()
    store.resizeSplit(1, 0.2, 0.1) // no group at dividerIndex+1
    expect(store.getState().sizes).toEqual([0.5, 0.5])
  })

  test("resetSplitSizes restores equal fractions across all groups", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup()
    store.resizeSplit(0, 0.3, 0.1) // [0.8, 0.2]

    store.resetSplitSizes()
    expect(store.getState().sizes).toEqual([0.5, 0.5])
  })

  test("resizeSplit on a three-group array moves only the targeted pair", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup()
    store.splitGroup() // 3 groups
    store.resetSplitSizes() // [1/3, 1/3, 1/3]

    // Drag the SECOND divider (between groups 1 and 2); group 0 is untouched.
    store.resizeSplit(1, 0.1, 0.1)
    const sizes = store.getState().sizes
    expect(sizes[0]).toBeCloseTo(1 / 3)
    expect(sizes[1]).toBeCloseTo(1 / 3 + 0.1)
    expect(sizes[2]).toBeCloseTo(1 / 3 - 0.1)
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  test("resizeSplit and resetSplitSizes bump the version so subscribers re-render", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup()

    const v0 = store.getVersion()
    store.resizeSplit(0, 0.1, 0.1)
    const v1 = store.getVersion()
    expect(v1).toBeGreaterThan(v0)

    store.resetSplitSizes()
    expect(store.getVersion()).toBeGreaterThan(v1)
  })
})

describe("dirty-close guard", () => {
  async function dirtyDoc(dir: string, name: string, edited: string) {
    const path = join(dir, name)
    await writeFile(path, "original\n")
    const doc = await documentRegistry.openDocument(path)
    doc.setText(edited, "edit")
    return { path, doc }
  }

  test("cancel keeps the dirty tab open and the document dirty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vsx-dirtyclose-"))
    try {
      const { path, doc } = await dirtyDoc(dir, "a.ts", "edited\n")
      const store = new WorkbenchStore()
      store.openFile(path, { preview: false })
      store.setConfirmDirtyCloseHandler(async () => "cancel")

      await store.closeTab(path)

      expect(activeTabs(store)).toEqual([path])
      expect(doc.isDirty).toBe(true)
      documentRegistry.releaseDocument(path)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("save persists the document then closes the tab", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vsx-dirtyclose-"))
    try {
      const { path, doc } = await dirtyDoc(dir, "a.ts", "edited\n")
      const store = new WorkbenchStore()
      store.openFile(path, { preview: false })
      store.setConfirmDirtyCloseHandler(async () => "save")

      await store.closeTab(path)

      expect(activeTabs(store)).toEqual([])
      expect(doc.isDirty).toBe(false)
      expect(await Bun.file(path).text()).toBe("edited\n")
      documentRegistry.releaseDocument(path)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("discard closes the tab immediately without saving", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vsx-dirtyclose-"))
    try {
      const { path, doc } = await dirtyDoc(dir, "a.ts", "edited\n")
      const store = new WorkbenchStore()
      store.openFile(path, { preview: false })
      let saveCalls = 0
      const realSave = doc.save.bind(doc)
      doc.save = async () => {
        saveCalls++
        return realSave()
      }
      store.setConfirmDirtyCloseHandler(async () => "discard")

      await store.closeTab(path)

      expect(activeTabs(store)).toEqual([])
      expect(saveCalls).toBe(0)
      expect(await Bun.file(path).text()).toBe("original\n")
      documentRegistry.releaseDocument(path)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a non-dirty tab never invokes the handler", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vsx-dirtyclose-"))
    try {
      const path = join(dir, "a.ts")
      await writeFile(path, "clean\n")
      const doc = await documentRegistry.openDocument(path) // opened, never edited
      const store = new WorkbenchStore()
      store.openFile(path, { preview: false })
      let handlerCalls = 0
      store.setConfirmDirtyCloseHandler(async () => {
        handlerCalls++
        return "cancel"
      })

      await store.closeTab(path)

      expect(handlerCalls).toBe(0)
      expect(activeTabs(store)).toEqual([])
      expect(doc.isDirty).toBe(false)
      documentRegistry.releaseDocument(path)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("collapsing the last tab of a split group waits for a real close, not a cancel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vsx-dirtyclose-"))
    try {
      const { path, doc } = await dirtyDoc(dir, "a.ts", "edited\n")
      const store = new WorkbenchStore()
      store.openFile(path, { preview: false })
      store.splitGroup() // second group holds a clone of the dirty file, and is active

      // Cancel: the split stays intact, tab remains, doc still dirty.
      store.setConfirmDirtyCloseHandler(async () => "cancel")
      await store.closeActiveTab()
      expect(store.getState().groups).toHaveLength(2)
      expect(doc.isDirty).toBe(true)

      // Discard: the real close now runs and the empty group collapses.
      store.setConfirmDirtyCloseHandler(async () => "discard")
      await store.closeActiveTab()
      expect(store.getState().groups).toHaveLength(1)
      documentRegistry.releaseDocument(path)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("dirty preview replacement", () => {
  test("a dirty preview file auto-promotes instead of being replaced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vsx-dirtypreview-"))
    try {
      const aPath = join(dir, "a.ts")
      const bPath = join(dir, "b.ts")
      await writeFile(aPath, "original\n")
      await writeFile(bPath, "b\n")
      const docA = await documentRegistry.openDocument(aPath)

      const store = new WorkbenchStore()
      store.openFile(aPath) // preview tab
      docA.setText("edited\n", "edit") // now dirty
      store.openFile(bPath) // new preview open of a different file

      const tabs = store.getState().groups[0].tabs
      expect(tabs.map((t) => t.path)).toEqual([aPath, bPath])
      expect(tab(store, aPath)?.preview).toBe(false) // dirty one promoted, kept open
      expect(tab(store, bPath)?.preview).toBe(true) // new file is its own preview tab
      documentRegistry.releaseDocument(aPath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a clean preview file is still silently replaced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vsx-dirtypreview-"))
    try {
      const aPath = join(dir, "a.ts")
      const bPath = join(dir, "b.ts")
      await writeFile(aPath, "a\n")
      await writeFile(bPath, "b\n")
      await documentRegistry.openDocument(aPath) // opened but never edited

      const store = new WorkbenchStore()
      store.openFile(aPath) // preview tab
      store.openFile(bPath) // reuses the single preview slot

      expect(store.getState().groups[0].tabs.map((t) => t.path)).toEqual([bPath])
      documentRegistry.releaseDocument(aPath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("subscriptions", () => {
  test("notifies listeners on state change and bumps version", () => {
    const store = new WorkbenchStore()
    let calls = 0
    const dispose = store.subscribe(() => calls++)
    const v0 = store.getVersion()

    store.openFile("/a.ts")
    expect(calls).toBe(1)
    expect(store.getVersion()).toBeGreaterThan(v0)

    dispose()
    store.openFile("/b.ts")
    expect(calls).toBe(1)
  })
})

describe("absolute-path invariant across open shapes", () => {
  test("FileTree (absolute) and QuickInput (rel-then-joined) opens collapse to one tab + one Document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vsx-pathnorm-"))
    try {
      await mkdir(join(dir, "src"))
      await writeFile(join(dir, "src", "index.ts"), "export {}\n")

      const store = new WorkbenchStore()

      // FileTree opens an already-absolute path.
      const fileTreePath = join(dir, "src", "index.ts")
      // QuickInput enumerates workspace-relative paths and joins the workspace root.
      const quickInputPath = join(dir, "src/index.ts")
      expect(quickInputPath).toBe(fileTreePath)

      store.openFile(fileTreePath, { preview: false })
      store.openFile(quickInputPath, { preview: false })

      // Exactly one tab, keyed by the shared absolute path.
      const tabs = store.getState().groups[0].tabs
      expect(tabs.map((t) => t.path)).toEqual([fileTreePath])

      // Both open shapes resolve to the SAME Document instance in the registry.
      const a = await documentRegistry.openDocument(fileTreePath)
      const b = await documentRegistry.openDocument(quickInputPath)
      expect(a).toBe(b)
      expect(documentRegistry.get(fileTreePath)).toBe(a)

      documentRegistry.releaseDocument(fileTreePath)
      documentRegistry.releaseDocument(quickInputPath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("DocumentRegistry throws on a relative path in test mode", async () => {
    expect(() => documentRegistry.get("relative/path.ts")).toThrow(/absolute path/)
    await expect(documentRegistry.openDocument("relative/path.ts")).rejects.toThrow(/absolute path/)
  })
})

describe("focus area", () => {
  test("a fresh store starts with the sidebar focused", () => {
    expect(new WorkbenchStore().getState().focusArea).toBe("sidebar")
  })

  test("setFocusArea toggles focus and notifies only on a real change", () => {
    const store = new WorkbenchStore()
    let calls = 0
    store.subscribe(() => calls++)

    store.setFocusArea("editor")
    expect(store.getState().focusArea).toBe("editor")
    expect(calls).toBe(1)

    // Setting the same area again is a no-op (no redundant notify).
    store.setFocusArea("editor")
    expect(calls).toBe(1)

    store.setFocusArea("sidebar")
    expect(store.getState().focusArea).toBe("sidebar")
    expect(calls).toBe(2)
  })

  test("opening a file takes editor focus (fixes sidebar-focus-after-open)", () => {
    const store = new WorkbenchStore()
    expect(store.getState().focusArea).toBe("sidebar")
    store.openFile("/a.ts", { preview: false })
    expect(store.getState().focusArea).toBe("editor")
  })

  test("openDiff and openCommitDiff take editor focus", () => {
    const store = new WorkbenchStore()
    store.openDiff("/a.ts", "unstaged", "/repo")
    expect(store.getState().focusArea).toBe("editor")

    store.setFocusArea("sidebar")
    store.openCommitDiff("/a.ts", "old", "new", "/repo", "a.ts (new)")
    expect(store.getState().focusArea).toBe("editor")
  })

  test("splitGroup takes editor focus even when triggered from the sidebar", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.setFocusArea("sidebar")
    store.splitGroup()
    expect(store.getState().focusArea).toBe("editor")
  })

  test("focusGroup / focusGroupByIndex flip focus into the editor from the sidebar", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup() // two groups, editor focused, group1 active
    const [g0, g1] = store.getState().groups

    store.setFocusArea("sidebar")
    store.focusGroupByIndex(0)
    expect(store.getState().activeGroupId).toBe(g0.id)
    expect(store.getState().focusArea).toBe("editor")

    store.setFocusArea("sidebar")
    store.focusGroup(g1.id)
    expect(store.getState().activeGroupId).toBe(g1.id)
    expect(store.getState().focusArea).toBe("editor")
  })

  test("focusing the ALREADY-active group from the sidebar still takes editor focus", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false }) // single group, active
    const g0 = store.getState().groups[0]
    store.setFocusArea("sidebar")

    // Same group is already active, but focus must still move sidebar → editor
    // (this is the pane-click-into-the-active-group case).
    let calls = 0
    store.subscribe(() => calls++)
    store.focusGroup(g0.id)
    expect(store.getState().focusArea).toBe("editor")
    expect(calls).toBe(1)

    // Re-focusing the same, already-editor-focused group is a genuine no-op.
    store.focusGroup(g0.id)
    expect(calls).toBe(1)
  })

  test("next/prev group cycling keeps editor focus", () => {
    const store = new WorkbenchStore()
    store.openFile("/a.ts", { preview: false })
    store.splitGroup()
    store.setFocusArea("sidebar")

    store.focusNextGroup()
    expect(store.getState().focusArea).toBe("editor")
  })
})

describe("explorer expanded paths", () => {
  test("a fresh store starts with nothing expanded", () => {
    expect(new WorkbenchStore().getState().explorerExpandedPaths.size).toBe(0)
  })

  test("expandExplorerPath adds a path and notifies once; a repeat is a no-op", () => {
    const store = new WorkbenchStore()
    let calls = 0
    store.subscribe(() => calls++)

    store.expandExplorerPath("/root/src")
    expect(store.getState().explorerExpandedPaths.has("/root/src")).toBe(true)
    expect(calls).toBe(1)

    store.expandExplorerPath("/root/src")
    expect(calls).toBe(1)
  })

  test("collapseExplorerPath removes a path and notifies once; a repeat is a no-op", () => {
    const store = new WorkbenchStore()
    store.expandExplorerPath("/root/src")
    let calls = 0
    store.subscribe(() => calls++)

    store.collapseExplorerPath("/root/src")
    expect(store.getState().explorerExpandedPaths.has("/root/src")).toBe(false)
    expect(calls).toBe(1)

    store.collapseExplorerPath("/root/src")
    expect(calls).toBe(1)
  })

  test("collapseAllExplorerPaths clears every path and notifies once; empty is a no-op", () => {
    const store = new WorkbenchStore()
    store.expandExplorerPath("/root/src")
    store.expandExplorerPath("/root/src/components")
    let calls = 0
    store.subscribe(() => calls++)

    store.collapseAllExplorerPaths()
    expect(store.getState().explorerExpandedPaths.size).toBe(0)
    expect(calls).toBe(1)

    store.collapseAllExplorerPaths()
    expect(calls).toBe(1)
  })

  test("reset() clears expanded paths along with everything else", () => {
    const store = new WorkbenchStore()
    store.expandExplorerPath("/root/src")
    store.reset()
    expect(store.getState().explorerExpandedPaths.size).toBe(0)
  })
})

describe("open recorder", () => {
  test("records a fresh file open exactly once", () => {
    const store = new WorkbenchStore()
    const recorded: string[] = []
    store.setOpenRecorder((p) => recorded.push(p))

    store.openFile("/a.ts")
    expect(recorded).toEqual(["/a.ts"])
  })

  test("re-activating the already-active tab does NOT record again", () => {
    const store = new WorkbenchStore()
    const recorded: string[] = []
    store.setOpenRecorder((p) => recorded.push(p))

    store.openFile("/a.ts")
    // Repeated opens of the same, already-active file (preview re-click, promote).
    store.openFile("/a.ts")
    store.openFile("/a.ts", { preview: false })
    expect(recorded).toEqual(["/a.ts"])
  })

  test("switching to a different file, then back, records both opens", () => {
    const store = new WorkbenchStore()
    const recorded: string[] = []
    store.setOpenRecorder((p) => recorded.push(p))

    store.openFile("/a.ts", { preview: false })
    store.openFile("/b.ts", { preview: false })
    store.openFile("/a.ts") // a.ts is open but not active → counts as a real open
    expect(recorded).toEqual(["/a.ts", "/b.ts", "/a.ts"])
  })

  test("openDiff and openCommitDiff never record", () => {
    const store = new WorkbenchStore()
    const recorded: string[] = []
    store.setOpenRecorder((p) => recorded.push(p))

    store.openDiff("/repo/a.ts", "unstaged", "/repo")
    store.openCommitDiff("/repo/a.ts", "old", "new", "/repo", "a.ts (new)")
    expect(recorded).toEqual([])
  })

  test("clearing the recorder with null stops recording", () => {
    const store = new WorkbenchStore()
    const recorded: string[] = []
    store.setOpenRecorder((p) => recorded.push(p))
    store.openFile("/a.ts")
    store.setOpenRecorder(null)
    store.openFile("/b.ts")
    expect(recorded).toEqual(["/a.ts"])
  })

  test("a throwing recorder does not break openFile", () => {
    const store = new WorkbenchStore()
    store.setOpenRecorder(() => {
      throw new Error("boom")
    })

    expect(() => store.openFile("/a.ts")).not.toThrow()
    expect(activeTabs(store)).toEqual(["/a.ts"])
    expect(activePath(store)).toBe("/a.ts")
  })
})
