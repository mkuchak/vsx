import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DocumentRegistry,
  FileTooLargeError,
  MAX_FILE_SIZE,
  detectLanguage,
} from "./documents.ts"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vsx-docs-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

describe("detectLanguage", () => {
  test("maps known extensions", () => {
    expect(detectLanguage("/a/b.ts")).toBe("typescript")
    expect(detectLanguage("comp.tsx")).toBe("typescript")
    expect(detectLanguage("x.js")).toBe("javascript")
    expect(detectLanguage("x.jsx")).toBe("javascript")
    expect(detectLanguage("s.py")).toBe("python")
    expect(detectLanguage("m.rs")).toBe("rust")
    expect(detectLanguage("m.go")).toBe("go")
    expect(detectLanguage("p.json")).toBe("json")
    expect(detectLanguage("i.html")).toBe("html")
    expect(detectLanguage("s.css")).toBe("css")
    expect(detectLanguage("r.md")).toBe("markdown")
    expect(detectLanguage("run.sh")).toBe("bash")
  })

  test("returns undefined for unknown or extensionless", () => {
    expect(detectLanguage("file.xyz")).toBeUndefined()
    expect(detectLanguage("Makefile")).toBeUndefined()
    expect(detectLanguage("/dir/.bashrc")).toBeUndefined()
  })
})

describe("DocumentRegistry sharing", () => {
  test("two opens of same path share one instance and refcount", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("shared.ts", "hello")

    const a = await reg.openDocument(path)
    const b = await reg.openDocument(path)
    expect(a).toBe(b)

    a.setText("changed", "edit")
    expect(b.getText()).toBe("changed")

    // one release keeps it alive
    reg.releaseDocument(path)
    expect(reg.get(path)).toBe(a)

    // second release disposes
    reg.releaseDocument(path)
    expect(reg.get(path)).toBeUndefined()
  })

  test("reopening after full release reloads from disk", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("reopen.ts", "disk-content")

    const a = await reg.openDocument(path)
    a.setText("in-memory", "edit")
    reg.releaseDocument(path)

    const b = await reg.openDocument(path)
    expect(b).not.toBe(a)
    expect(b.getText()).toBe("disk-content")
  })
})

describe("dirty flag lifecycle", () => {
  test("edit sets dirty, save clears it", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("dirty.ts", "original")
    const doc = await reg.openDocument(path)

    expect(doc.isDirty).toBe(false)

    doc.setText("edited", "edit")
    expect(doc.isDirty).toBe(true)

    await doc.save()
    expect(doc.isDirty).toBe(false)
    expect(await readFile(path, "utf8")).toBe("edited")
  })

  test("editing back to saved content clears dirty", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("toggle.ts", "same")
    const doc = await reg.openDocument(path)

    doc.setText("different", "edit")
    expect(doc.isDirty).toBe(true)
    doc.setText("same", "edit")
    expect(doc.isDirty).toBe(false)
  })

  test("onDidSave fires on save", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("save-event.ts", "x")
    const doc = await reg.openDocument(path)

    let fired = 0
    doc.onDidSave(() => fired++)
    doc.setText("y", "edit")
    await doc.save()
    expect(fired).toBe(1)
  })
})

describe("version and change events", () => {
  test("version increments on every setText", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("ver.ts", "a")
    const doc = await reg.openDocument(path)

    expect(doc.version).toBe(0)
    doc.setText("b", "edit")
    expect(doc.version).toBe(1)
    doc.setText("c", "edit")
    expect(doc.version).toBe(2)
    doc.setText("d", "disk")
    expect(doc.version).toBe(3)
  })

  test("onDidChange delivers version and source, unsubscribe stops delivery", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("change.ts", "a")
    const doc = await reg.openDocument(path)

    const events: Array<{ version: number; source: string }> = []
    const off = doc.onDidChange((e) => events.push(e))

    doc.setText("b", "edit")
    doc.setText("c", "save")
    off()
    doc.setText("d", "edit")

    expect(events).toEqual([
      { version: 1, source: "edit" },
      { version: 2, source: "save" },
    ])
  })
})

describe("reloadFromDisk", () => {
  test("blocked while dirty, succeeds while clean", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("reload.ts", "v1")
    const doc = await reg.openDocument(path)

    // dirty: reload is a no-op
    doc.setText("local", "edit")
    await writeFile(path, "v2")
    await doc.reloadFromDisk()
    expect(doc.getText()).toBe("local")

    // clean: reload picks up disk content
    await doc.save() // writes "local", clears dirty
    await writeFile(path, "v3")
    await doc.reloadFromDisk()
    expect(doc.getText()).toBe("v3")
    expect(doc.isDirty).toBe(false)
  })
})

describe("save / reload races", () => {
  test("edit during in-flight save keeps dirty; next save persists newer content", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("race-save.ts", "v0")
    const doc = await reg.openDocument(path)

    doc.setText("v1", "edit")
    const inFlight = doc.save() // snapshots "v1", write in flight
    doc.setText("v2", "edit") // lands during the write
    await inFlight

    // "v1" is on disk, but the buffer holds the newer "v2" — must stay dirty.
    expect(doc.isDirty).toBe(true)
    expect(await readFile(path, "utf8")).toBe("v1")

    await doc.save()
    expect(doc.isDirty).toBe(false)
    expect(await readFile(path, "utf8")).toBe("v2")
  })

  test("edit during in-flight reloadFromDisk keeps the edit and stays dirty", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("race-reload.ts", "disk-v1")
    const doc = await reg.openDocument(path)

    await writeFile(path, "disk-v2")
    const inFlight = doc.reloadFromDisk() // captures version, read in flight
    doc.setText("mid-edit", "edit") // lands during the read
    await inFlight

    expect(doc.getText()).toBe("mid-edit")
    expect(doc.isDirty).toBe(true)
  })

  test("two overlapping saves end with the later content, uncorrupted", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("race-overlap.ts", "start")
    const doc = await reg.openDocument(path)

    doc.setText("first", "edit")
    const p1 = doc.save() // snapshots "first"
    doc.setText("second", "edit")
    const p2 = doc.save() // snapshots "second"
    await Promise.all([p1, p2])

    expect(await readFile(path, "utf8")).toBe("second")
    expect(doc.isDirty).toBe(false)
  })

  test("CRLF EOL is preserved through a serialized save", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("race-crlf.ts", "one\r\ntwo\r\nthree")
    const doc = await reg.openDocument(path)

    doc.setText("one\ntwo\nfour", "edit")
    await doc.save()

    expect(await readFile(path, "utf8")).toBe("one\r\ntwo\r\nfour")
  })
})

describe("file size cap", () => {
  test("rejects files over 5MB with typed error", async () => {
    const reg = new DocumentRegistry()
    const path = join(dir, "big.txt")
    await writeFile(path, Buffer.alloc(MAX_FILE_SIZE + 1, 0x61))
    const info = await stat(path)
    expect(info.size).toBeGreaterThan(MAX_FILE_SIZE)

    let err: unknown
    try {
      await reg.openDocument(path)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(FileTooLargeError)
    expect((err as FileTooLargeError).size).toBeGreaterThan(MAX_FILE_SIZE)
  })
})

describe("line ending round-trip", () => {
  test("CRLF file preserves CRLF on save; getText is normalized to \\n", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("crlf.ts", "one\r\ntwo\r\nthree")
    const doc = await reg.openDocument(path)

    expect(doc.getText()).toBe("one\ntwo\nthree")

    doc.setText("one\ntwo\nfour", "edit")
    await doc.save()

    const onDisk = await readFile(path, "utf8")
    expect(onDisk).toBe("one\r\ntwo\r\nfour")
  })

  test("LF file stays LF on save", async () => {
    const reg = new DocumentRegistry()
    const path = await fixture("lf.ts", "a\nb\nc")
    const doc = await reg.openDocument(path)

    doc.setText("a\nb\nd", "edit")
    await doc.save()

    const onDisk = await readFile(path, "utf8")
    expect(onDisk).toBe("a\nb\nd")
  })
})
