import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { documentRegistry } from "../model/documents"
import { startDocumentReloadWatcher } from "./watchers"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vsx-watchers-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await Bun.sleep(20)
  }
  return pred()
}

describe("startDocumentReloadWatcher", () => {
  test("reloads an open, clean document after an external write", async () => {
    const path = join(root, "clean.txt")
    await writeFile(path, "original\n")
    const doc = await documentRegistry.openDocument(path)

    const dispose = startDocumentReloadWatcher(root)
    try {
      await writeFile(path, "changed externally\n")
      const ok = await waitFor(() => doc.getText() === "changed externally\n")
      expect(ok).toBe(true)
    } finally {
      dispose()
      documentRegistry.releaseDocument(path)
    }
  })

  test("does NOT clobber a dirty buffer on an external write", async () => {
    const path = join(root, "dirty.txt")
    await writeFile(path, "on disk\n")
    const doc = await documentRegistry.openDocument(path)
    doc.setText("unsaved edit\n", "edit")
    expect(doc.isDirty).toBe(true)

    const dispose = startDocumentReloadWatcher(root)
    try {
      await writeFile(path, "external overwrite\n")
      // Give the watcher time to fire + attempt (and no-op) the reload.
      await Bun.sleep(400)
      expect(doc.getText()).toBe("unsaved edit\n")
      expect(doc.isDirty).toBe(true)
    } finally {
      dispose()
      documentRegistry.releaseDocument(path)
    }
  })

  test("disposer stops reloading (no lingering watcher)", async () => {
    const path = join(root, "stop.txt")
    await writeFile(path, "start\n")
    const doc = await documentRegistry.openDocument(path)

    const dispose = startDocumentReloadWatcher(root)
    dispose()

    await writeFile(path, "after dispose\n")
    await Bun.sleep(300)
    expect(doc.getText()).toBe("start\n")

    documentRegistry.releaseDocument(path)
  })
})
