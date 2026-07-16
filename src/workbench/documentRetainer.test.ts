import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { documentRegistry } from "../model/documents.ts"
import { workbenchStore } from "../model/workbench.ts"
import { startDocumentRetainer } from "./documentRetainer.ts"

let dir: string
let stop: (() => void) | null = null

/** Let the retainer's async openDocument/releaseDocument calls settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await Bun.sleep(20)
}

beforeEach(async () => {
  workbenchStore.reset()
  dir = await mkdtemp(join(tmpdir(), "vsx-retainer-"))
})

afterEach(async () => {
  stop?.()
  stop = null
  await settle()
  workbenchStore.reset()
  await rm(dir, { recursive: true, force: true })
})

async function makeFile(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

test("keeps a backgrounded dirty tab's Document alive and unchanged on reactivation", async () => {
  const a = await makeFile("a.ts", "aaa\n")
  const b = await makeFile("b.ts", "bbb\n")

  stop = startDocumentRetainer()
  workbenchStore.openFile(a, { preview: false })
  await settle()

  const docA = documentRegistry.get(a)!
  expect(docA).toBeDefined()
  docA.setText("edited A", "edit")
  expect(docA.isDirty).toBe(true)

  // Switch to B, then back to A. The retainer must hold A the whole time.
  workbenchStore.openFile(b, { preview: false })
  await settle()
  workbenchStore.activateTab(a)
  await settle()

  const docAAgain = documentRegistry.get(a)!
  expect(docAAgain).toBe(docA) // same instance — never disposed/reloaded
  expect(docAAgain.getText()).toBe("edited A")
  expect(docAAgain.isDirty).toBe(true)
})

test("a diff tab retains the live file Document even after its file tab closes", async () => {
  const a = await makeFile("a.ts", "aaa\n")

  stop = startDocumentRetainer()
  workbenchStore.openFile(a, { preview: false })
  await settle()

  const docA = documentRegistry.get(a)!
  docA.setText("live edit", "edit")

  // Open A's unstaged diff (same underlying filePath), then close the file tab.
  workbenchStore.openDiff(a, "unstaged", "/repo", { preview: false })
  await settle()
  workbenchStore.closeTab(a)
  await settle()

  // The diff tab still references A's path, so the live edited doc survives.
  const live = documentRegistry.get(a)
  expect(live).toBe(docA)
  expect(live!.getText()).toBe("live edit")
})

describe("no registry leaks under churn", () => {
  test("a path added then immediately replaced releases once its open resolves", async () => {
    const a = await makeFile("a.ts", "aaa\n")
    const b = await makeFile("b.ts", "bbb\n")

    stop = startDocumentRetainer()
    // Preview opens reuse the single slot: A leaves the union before its open
    // resolves, exercising the opening -> cancelled -> release-on-resolve path.
    workbenchStore.openFile(a, { preview: true })
    workbenchStore.openFile(b, { preview: true })
    await settle()

    expect(documentRegistry.get(a)).toBeUndefined()
    expect(documentRegistry.get(b)).toBeDefined()
  })

  test("opening and closing many tabs leaves no registry entries behind", async () => {
    const paths: string[] = []
    for (let i = 0; i < 6; i++) paths.push(await makeFile(`f${i}.ts`, `content ${i}\n`))

    stop = startDocumentRetainer()
    for (const p of paths) workbenchStore.openFile(p, { preview: false })
    await settle()
    for (const p of paths) expect(documentRegistry.get(p)).toBeDefined()

    // Churn activation, then close every tab.
    for (const p of paths) workbenchStore.activateTab(p)
    for (const p of paths) workbenchStore.closeTab(p)
    await settle()

    for (const p of paths) expect(documentRegistry.get(p)).toBeUndefined()
  })

  test("renaming an open file via retarget then closing its tab disposes the doc", async () => {
    const a = await makeFile("a.ts", "aaa\n")
    const b = join(dir, "b.ts")

    stop = startDocumentRetainer()
    workbenchStore.openFile(a, { preview: false })
    await settle()
    expect(documentRegistry.get(a)).toBeDefined()

    // Same order as App.tsx's retargetOpenTab: registry re-keys FIRST, then the
    // tab store re-keys (which synchronously re-runs the retainer's sync()).
    documentRegistry.retarget(a, b)
    workbenchStore.retargetTabPath(a, b)
    await settle()

    // The document lives at its new identity, with a single (not doubled) refcount.
    expect(documentRegistry.get(b)).toBeDefined()
    expect(documentRegistry.get(a)).toBeUndefined()

    // Closing the last tab must drop the refcount to zero and dispose the doc.
    workbenchStore.closeActiveTab()
    await settle()
    expect(documentRegistry.get(b)).toBeUndefined()
  })

  test("the disposer releases every retained document", async () => {
    const a = await makeFile("a.ts", "aaa\n")
    const b = await makeFile("b.ts", "bbb\n")

    const dispose = startDocumentRetainer()
    workbenchStore.openFile(a, { preview: false })
    workbenchStore.openFile(b, { preview: false })
    await settle()
    expect(documentRegistry.get(a)).toBeDefined()
    expect(documentRegistry.get(b)).toBeDefined()

    dispose()
    await settle()
    expect(documentRegistry.get(a)).toBeUndefined()
    expect(documentRegistry.get(b)).toBeUndefined()
  })
})
