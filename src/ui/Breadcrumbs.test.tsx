import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { GitService } from "../services/git"
import type { RepoInfo } from "../services/repos"
import { tabFilePath, workbenchStore } from "../model/workbench"
import {
  Breadcrumbs,
  resolveBreadcrumbSegments,
  truncateBreadcrumbSegments,
  type BreadcrumbSegment,
} from "./Breadcrumbs"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

function repo(root: string): RepoInfo {
  return { root, gitDir: join(root, ".git"), commonDir: join(root, ".git"), service: new GitService(root) }
}

function seg(...parts: string[]): BreadcrumbSegment[] {
  return parts.map((p) => ({ label: p, absolutePath: `/x/${p}` }))
}

test("single-repo path resolves to plain relative segments with no repo-name prefix", () => {
  const repos = [repo("/work/proj")]
  const segments = resolveBreadcrumbSegments("/work/proj/src/ui/EditorPane.tsx", repos, "/work")

  expect(segments.map((s) => s.label)).toEqual(["src", "ui", "EditorPane.tsx"])
  expect(segments.map((s) => s.absolutePath)).toEqual([
    "/work/proj/src",
    "/work/proj/src/ui",
    "/work/proj/src/ui/EditorPane.tsx",
  ])
})

test("multi-repo path gets a leading repo-name segment", () => {
  const repos = [repo("/work/api"), repo("/work/web")]
  const segments = resolveBreadcrumbSegments("/work/web/src/App.tsx", repos, "/work")

  expect(segments.map((s) => s.label)).toEqual(["web", "src", "App.tsx"])
  expect(segments[0].absolutePath).toBe("/work/web")
})

test("path outside every repo falls back to workspace-relative segments", () => {
  const repos = [repo("/work/proj")]
  const segments = resolveBreadcrumbSegments("/work/notes/todo.md", repos, "/work")

  expect(segments.map((s) => s.label)).toEqual(["notes", "todo.md"])
  expect(segments.map((s) => s.absolutePath)).toEqual(["/work/notes", "/work/notes/todo.md"])
})

test("truncation collapses middle segments at a narrow width and keeps the full trail when ample", () => {
  const repos = [repo("/work/proj")]
  const deep = resolveBreadcrumbSegments(
    "/work/proj/packages/core/src/services/renderer/pipeline.ts",
    repos,
    "/work",
  )

  const narrow = truncateBreadcrumbSegments(deep, 20)
  expect(narrow.some((s) => s.label === "…")).toBe(true)
  // First and last (filename) always survive the elision.
  expect(narrow[0].label).toBe("packages")
  expect(narrow[narrow.length - 1].label).toBe("pipeline.ts")

  const ample = truncateBreadcrumbSegments(deep, 200)
  expect(ample).toEqual(deep)
  expect(ample.some((s) => s.label === "…")).toBe(false)
})

test("clicking a non-last segment fires onSegmentClick with its directory path; last fires with the file path", async () => {
  const repos = [repo("/work/proj")]
  const clicked: string[] = []
  testSetup = await testRender(
    <Breadcrumbs
      path="/work/proj/src/ui/EditorPane.tsx"
      repos={repos}
      workspaceRoot="/work"
      containerWidth={80}
      onSegmentClick={(p) => clicked.push(p)}
    />,
    { width: 80, height: 3 },
  )
  await testSetup.renderOnce()

  const line = testSetup.captureCharFrame().split("\n")[0]
  const dirX = line.indexOf("src")
  const fileX = line.indexOf("EditorPane.tsx")
  expect(dirX).toBeGreaterThanOrEqual(0)
  expect(fileX).toBeGreaterThanOrEqual(0)

  await testSetup.mockMouse.click(dirX, 0)
  await testSetup.renderOnce()
  await testSetup.mockMouse.click(fileX, 0)
  await testSetup.renderOnce()

  expect(clicked).toEqual(["/work/proj/src", "/work/proj/src/ui/EditorPane.tsx"])
})

test("a null path renders no visible row content and does not throw", async () => {
  testSetup = await testRender(
    <Breadcrumbs path={null} repos={[]} workspaceRoot="/work" containerWidth={80} />,
    { width: 80, height: 3 },
  )
  await testSetup.renderOnce()

  const frame = testSetup.captureCharFrame()
  expect(frame.trim()).toBe("")
})

test("a commitDiff tab's breadcrumb resolves the real underlying file, not its synthetic identity", async () => {
  // A commit-diff tab keys its identity on a synthetic `commitDiff::…` string and
  // carries the real file on `filePath`. The breadcrumb must be fed that real path
  // via the shared `tabFilePath` helper — the old private helper only unwrapped a
  // "diff" tab and leaked a commitDiff tab's synthetic id straight into the trail.
  workbenchStore.reset()
  const filePath = "/work/proj/src/ui/EditorPane.tsx"
  workbenchStore.openCommitDiff(filePath, "abc123^", "abc123", "/work/proj", "EditorPane.tsx (abc123)")
  const group = workbenchStore.getState().groups[0]
  const active = group.tabs.find((t) => t.path === group.activeTabPath)!
  expect(active.kind).toBe("commitDiff")

  const repos = [repo("/work/proj")]
  const resolvedPath = tabFilePath(active)

  // Deterministic guard: resolution keys off the REAL file, so the trail is exactly
  // the underlying path's segments — no synthetic `commitDiff::`/ref markers survive.
  const segments = resolveBreadcrumbSegments(resolvedPath, repos, "/work")
  expect(segments.map((s) => s.label)).toEqual(["src", "ui", "EditorPane.tsx"])

  // And the rendered row shows that trail — never the `commitDiff::…` id.
  testSetup = await testRender(
    <Breadcrumbs path={resolvedPath} repos={repos} workspaceRoot="/work" containerWidth={80} />,
    { width: 80, height: 3 },
  )
  await testSetup.renderOnce()
  const line = testSetup.captureCharFrame().split("\n")[0]
  expect(line).toContain("EditorPane.tsx")
  expect(line).toContain("›")
  expect(line).not.toContain("commitDiff")

  workbenchStore.reset()
})

test("truncated middle ellipsis is inert and does not fire onSegmentClick", () => {
  const segments = seg("a", "b", "c", "d", "e")
  const truncated = truncateBreadcrumbSegments(segments, 10)
  const ellipsis = truncated.find((s) => s.label === "…")
  expect(ellipsis).toBeDefined()
  expect(ellipsis!.absolutePath).toBe("")
})
