import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
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

    const dispose = startDocumentReloadWatcher()
    try {
      await writeFile(path, "changed externally\n")
      const ok = await waitFor(() => doc.getText() === "changed externally\n")
      expect(ok).toBe(true)
    } finally {
      dispose()
      documentRegistry.releaseDocument(path)
    }
  })

  test("reloads a document opened AFTER the watcher started", async () => {
    const path = join(root, "later.txt")
    await writeFile(path, "original\n")

    const dispose = startDocumentReloadWatcher()
    const doc = await documentRegistry.openDocument(path)
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

    const dispose = startDocumentReloadWatcher()
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

  test("leaves an open buffer intact when its file is deleted", async () => {
    const path = join(root, "gone.txt")
    await writeFile(path, "still here\n")
    const doc = await documentRegistry.openDocument(path)

    const dispose = startDocumentReloadWatcher()
    try {
      await unlink(path)
      // The deletion event must be observed and then ignored — give it time.
      await Bun.sleep(400)
      expect(doc.getText()).toBe("still here\n")
    } finally {
      dispose()
      documentRegistry.releaseDocument(path)
    }
  })

  test("stops watching a document's dir once it is closed", async () => {
    const path = join(root, "closed.txt")
    await writeFile(path, "start\n")
    const doc = await documentRegistry.openDocument(path)

    const dispose = startDocumentReloadWatcher()
    try {
      // Closing the only doc in this dir drops its watch; a later external
      // write must not reload the (now-closed) buffer.
      documentRegistry.releaseDocument(path)
      await writeFile(path, "changed after close\n")
      await Bun.sleep(400)
      expect(doc.getText()).toBe("start\n")
    } finally {
      dispose()
    }
  })

  test("keeps the shared dir watch alive after closing one of two docs in it", async () => {
    const aPath = join(root, "a.txt")
    const bPath = join(root, "b.txt")
    await writeFile(aPath, "a-start\n")
    await writeFile(bPath, "b-start\n")
    const docA = await documentRegistry.openDocument(aPath)
    const docB = await documentRegistry.openDocument(bPath)

    const dispose = startDocumentReloadWatcher()
    try {
      // Close B; A shares B's parent dir, so the dir's single watch must survive.
      documentRegistry.releaseDocument(bPath)
      void docB
      await writeFile(aPath, "a-changed\n")
      const ok = await waitFor(() => docA.getText() === "a-changed\n")
      expect(ok).toBe(true)
    } finally {
      dispose()
      documentRegistry.releaseDocument(aPath)
    }
  })

  test("disposer stops reloading (no lingering watcher)", async () => {
    const path = join(root, "stop.txt")
    await writeFile(path, "start\n")
    const doc = await documentRegistry.openDocument(path)

    const dispose = startDocumentReloadWatcher()
    dispose()

    await writeFile(path, "after dispose\n")
    await Bun.sleep(300)
    expect(doc.getText()).toBe("start\n")

    documentRegistry.releaseDocument(path)
  })
})
