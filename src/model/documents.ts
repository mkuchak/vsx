/**
 * Shared document model registry — clones VSCode's single-text-model-per-path idea.
 * ONE Document instance per file path, shared (refcounted) by every tab/editor view.
 * Framework-agnostic: plain TS + a tiny internal emitter, no React imports here.
 */

import { rename } from "node:fs/promises"

export const MAX_FILE_SIZE = 5 * 1024 * 1024

export class FileTooLargeError extends Error {
  readonly path: string
  readonly size: number

  constructor(path: string, size: number) {
    super(`File too large: ${path} is ${size} bytes (max ${MAX_FILE_SIZE})`)
    this.name = "FileTooLargeError"
    this.path = path
    this.size = size
  }
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  html: "html",
  css: "css",
  md: "markdown",
  sh: "bash",
}

export function detectLanguage(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return LANGUAGE_BY_EXTENSION[ext]
}

type ChangeEvent = { version: number; source: string }
type ChangeListener = (e: ChangeEvent) => void
type SaveListener = () => void

type Eol = "\n" | "\r\n"

/** Detect the dominant EOL style; defaults to "\n" when no CRLF is present. */
function detectEol(raw: string): Eol {
  return raw.includes("\r\n") ? "\r\n" : "\n"
}

function normalizeEol(raw: string): string {
  return raw.replace(/\r\n/g, "\n")
}

export interface Document {
  readonly uri: string
  readonly language: string | undefined
  readonly version: number
  readonly isDirty: boolean
  getText(): string
  setText(text: string, source: "edit" | "disk" | "save"): void
  save(): Promise<void>
  reloadFromDisk(): Promise<void>
  onDidChange(cb: ChangeListener): () => void
  onDidSave(cb: SaveListener): () => void
}

class DocumentModel implements Document {
  readonly uri: string
  readonly language: string | undefined

  private text: string
  private savedText: string
  private eol: Eol
  private _version = 0
  private readonly changeListeners = new Set<ChangeListener>()
  private readonly saveListeners = new Set<SaveListener>()
  private saveChain: Promise<void> = Promise.resolve()

  constructor(path: string, raw: string) {
    this.uri = path
    this.language = detectLanguage(path)
    this.eol = detectEol(raw)
    this.text = normalizeEol(raw)
    this.savedText = this.text
  }

  get version(): number {
    return this._version
  }

  get isDirty(): boolean {
    return this.text !== this.savedText
  }

  getText(): string {
    return this.text
  }

  setText(text: string, source: "edit" | "disk" | "save"): void {
    this.text = normalizeEol(text)
    this._version++
    if (source === "disk" || source === "save") {
      this.savedText = this.text
    }
    const event: ChangeEvent = { version: this._version, source }
    for (const cb of this.changeListeners) cb(event)
  }

  async save(): Promise<void> {
    // Snapshot the buffer synchronously (before any await) so an edit that lands
    // mid-write is not mistaken for saved content — savedText tracks exactly what
    // we persisted, keeping isDirty true when newer edits arrive during the write.
    const snapshot = this.text
    const eol = this.eol
    const run = this.saveChain.then(() => this.writeSnapshot(snapshot, eol))
    // Serialize re-entrant saves; swallow errors on the chain so one failed save
    // does not poison later ones (callers still see this save's rejection via run).
    this.saveChain = run.catch(() => {})
    return run
  }

  private async writeSnapshot(snapshot: string, eol: Eol): Promise<void> {
    const onDisk = eol === "\r\n" ? snapshot.replace(/\n/g, "\r\n") : snapshot
    // Write to a temp file in the same directory, then atomically rename into
    // place so a crash mid-write can never truncate the real file.
    const tmpPath = `${this.uri}.tmp`
    await Bun.write(tmpPath, onDisk)
    await rename(tmpPath, this.uri)
    this.savedText = snapshot
    for (const cb of this.saveListeners) cb()
  }

  async reloadFromDisk(): Promise<void> {
    if (this.isDirty) return
    const v = this._version
    const raw = await readFileChecked(this.uri)
    // An edit landed during the read — never clobber it.
    if (this._version !== v || this.isDirty) return
    this.eol = detectEol(raw)
    this.setText(raw, "disk")
  }

  onDidChange(cb: ChangeListener): () => void {
    this.changeListeners.add(cb)
    return () => {
      this.changeListeners.delete(cb)
    }
  }

  onDidSave(cb: SaveListener): () => void {
    this.saveListeners.add(cb)
    return () => {
      this.saveListeners.delete(cb)
    }
  }

  dispose(): void {
    this.changeListeners.clear()
    this.saveListeners.clear()
  }
}

async function readFileChecked(path: string): Promise<string> {
  const file = Bun.file(path)
  const size = file.size
  if (size > MAX_FILE_SIZE) {
    throw new FileTooLargeError(path, size)
  }
  return file.text()
}

type Entry = { doc: DocumentModel; refCount: number }
/** An open still awaiting its initial disk read; concurrent openers share it. */
type PendingEntry = { promise: Promise<DocumentModel>; refCount: number }

/**
 * Enforce the one-document-per-path invariant: registry keys are ALWAYS absolute
 * paths. A relative path would silently create a second Document for a file that
 * is already open, diverging its dirty state. Throw in tests so regressions are
 * loud; only warn in production so a stray path-shape bug can't crash the app.
 */
function assertAbsolute(path: string, method: string): void {
  if (path.startsWith("/")) return
  const message = `DocumentRegistry.${method} requires an absolute path, got: ${JSON.stringify(path)}`
  if (process.env.NODE_ENV === "test") throw new Error(message)
  console.warn(message)
}

export class DocumentRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, PendingEntry>()

  /**
   * Open (or refcount) the single Document for a path. Concurrent opens of a
   * not-yet-loaded path share ONE in-flight read — without this, the `await`
   * between the existence check and the map insert lets each caller create its
   * own DocumentModel, silently violating the one-document-per-path invariant and
   * orphaning edits when a later release disposes the "winning" entry.
   */
  async openDocument(path: string): Promise<Document> {
    assertAbsolute(path, "openDocument")
    const existing = this.entries.get(path)
    if (existing) {
      existing.refCount++
      return existing.doc
    }
    const inflight = this.pending.get(path)
    if (inflight) {
      inflight.refCount++
      return inflight.promise
    }
    const promise = readFileChecked(path).then(
      (raw) => {
        this.pending.delete(path)
        const doc = new DocumentModel(path, raw)
        // Everyone may have released while the read was in flight — drop it.
        if (pendingEntry.refCount > 0) {
          this.entries.set(path, { doc, refCount: pendingEntry.refCount })
        } else {
          doc.dispose()
        }
        return doc
      },
      (err) => {
        this.pending.delete(path)
        throw err
      },
    )
    const pendingEntry: PendingEntry = { promise, refCount: 1 }
    this.pending.set(path, pendingEntry)
    return promise
  }

  releaseDocument(path: string): void {
    const entry = this.entries.get(path)
    if (entry) {
      entry.refCount--
      if (entry.refCount <= 0) {
        entry.doc.dispose()
        this.entries.delete(path)
      }
      return
    }
    // Released before its initial read resolved: decrement the shared in-flight
    // count so the resolver discards the doc if no opener still wants it.
    const inflight = this.pending.get(path)
    if (inflight) inflight.refCount--
  }

  get(path: string): Document | undefined {
    assertAbsolute(path, "get")
    return this.entries.get(path)?.doc
  }
}

export const documentRegistry = new DocumentRegistry()
