import { afterEach, expect, test } from "bun:test"
import { useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import type { Document } from "../model/documents.ts"
import type { GitService, LineBlame } from "../services/git.ts"
import { destroyRendererAndWait } from "../testUtils/rendererTeardown"
import { useLineBlame, type BlameState } from "./useLineBlame.ts"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(async () => {
  if (testSetup) await destroyRendererAndWait(testSetup.renderer)
  testSetup = undefined
})

// The debounce inside the hook is 120ms; wait comfortably past it.
const PAST_DEBOUNCE = 200

// bun's default per-test timeout is 5s. These tests all wait out the hook's 120ms
// debounce, and under heavy combined-suite load the event loop can be starved
// enough to trip that default even though the logic is fine. Give each a generous
// per-test ceiling (kept above waitFor's own give-up ceiling) so only a real hang
// fails them.
const BLAME_TEST_TIMEOUT = 25000
const blameTest = (name: string, fn: () => Promise<void>) => test(name, fn, BLAME_TEST_TIMEOUT)

function blame(over: Partial<LineBlame> = {}): LineBlame {
  return {
    hash: "abcdef1234567890",
    authorName: "Ada Lovelace",
    authorDate: new Date("2026-07-01T12:00:00Z"),
    summary: "Add the analytical engine",
    prNumber: 42,
    uncommitted: false,
    ...over,
  }
}

/** A Document stand-in — the hook reads `isDirty`/`version` and subscribes to
 *  `onDidSave` (here a no-op that never fires). */
function doc(over: Partial<Pick<Document, "isDirty" | "version">> = {}): Document {
  return { isDirty: false, version: 1, onDidSave: () => () => {}, ...over } as unknown as Document
}

/** A stateful Document fake mirroring the real edit/save transitions the hook
 *  cares about: an "edit" flips dirty true + bumps version, a save flips dirty
 *  false and fires `onDidSave` — WITHOUT advancing version (matches DocumentModel). */
function liveDoc(): Document & { setText: Document["setText"]; save: Document["save"] } {
  let version = 1
  let dirty = false
  const saveListeners = new Set<() => void>()
  return {
    get isDirty() {
      return dirty
    },
    get version() {
      return version
    },
    setText(_text: string, source: "edit" | "disk" | "save") {
      version++
      if (source === "edit") dirty = true
      else dirty = false
    },
    async save() {
      dirty = false
      for (const cb of saveListeners) cb()
    },
    onDidSave(cb: () => void) {
      saveListeners.add(cb)
      return () => saveListeners.delete(cb)
    },
  } as unknown as Document & { setText: Document["setText"]; save: Document["save"] }
}

type Props = {
  doc: Document | undefined
  line: number | null
  service: GitService | null
  repo: string | null
  /** Unrelated prop: forces a re-render without changing the blame key. */
  nonce?: number
}

let observed: BlameState = { kind: "none" }
let setProps: (update: (p: Props) => Props) => void = () => {}

function Harness({ initial }: { initial: Props }) {
  const [props, setP] = useState(initial)
  setProps = (update) => setP(update)
  observed = useLineBlame(props.doc, props.line, props.service, props.repo)
  return null
}

async function mount(initial: Props) {
  testSetup = await testRender(<Harness initial={initial} />, { width: 40, height: 4 })
  await testSetup.flush()
}

async function settle(ms = PAST_DEBOUNCE) {
  await testSetup!.flush()
  await Bun.sleep(ms)
  await testSetup!.flush()
}

/** Poll the live hook state (flushing between checks) until `predicate` holds,
 *  instead of sleeping a fixed guessed duration that races the 120ms blame
 *  debounce. Used wherever a test waits for a POSITIVE end-state to arrive; the
 *  remaining `settle()` calls stay only where a test must instead confirm the
 *  ABSENCE of a re-blame across the debounce window (nothing to poll for). */
async function waitFor(predicate: () => boolean, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await testSetup!.flush()
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for condition; last observed ${JSON.stringify(observed)}`)
}

blameTest("dirty document returns none and never spawns git", async () => {
  let calls = 0
  const service = {
    blame: async () => {
      calls++
      return blame()
    },
  } as unknown as GitService

  await mount({ doc: doc({ isDirty: true }), line: 5, service, repo: "src/a.ts" })
  await settle()

  expect(observed).toEqual({ kind: "none" })
  expect(calls).toBe(0)
})

blameTest("clean document blames the line once and returns ready", async () => {
  let calls = 0
  const service = {
    blame: async (rel: string, line: number) => {
      calls++
      return blame({ summary: `${rel}@${line}` })
    },
  } as unknown as GitService

  await mount({ doc: doc(), line: 7, service, repo: "src/a.ts" })
  await waitFor(() => observed.kind === "ready")

  expect(calls).toBe(1)
  expect(observed).toEqual({ kind: "ready", blame: blame({ summary: "src/a.ts@7" }) })
})

blameTest("does not re-blame when an unrelated prop changes", async () => {
  let calls = 0
  const service = {
    blame: async () => {
      calls++
      return blame()
    },
  } as unknown as GitService

  await mount({ doc: doc(), line: 7, service, repo: "src/a.ts", nonce: 0 })
  await waitFor(() => observed.kind === "ready")
  expect(calls).toBe(1)

  // Same (doc, line, version, repo), only the nonce moves. Confirming a re-blame
  // does NOT fire is an absence assertion, so give the debounce window a real
  // chance to (wrongly) elapse rather than polling for something that shouldn't happen.
  setProps((p) => ({ ...p, nonce: 1 }))
  await settle()

  expect(calls).toBe(1)
  expect(observed.kind).toBe("ready")
})

blameTest("re-blames when the cursor line changes", async () => {
  let calls = 0
  const service = {
    blame: async (rel: string, line: number) => {
      calls++
      return blame({ summary: `line-${line}` })
    },
  } as unknown as GitService

  await mount({ doc: doc(), line: 7, service, repo: "src/a.ts" })
  await waitFor(() => observed.kind === "ready")
  expect(calls).toBe(1)

  setProps((p) => ({ ...p, line: 9 }))
  await waitFor(() => observed.kind === "ready" && observed.blame.summary === "line-9")

  expect(calls).toBe(2)
  expect(observed).toEqual({ kind: "ready", blame: blame({ summary: "line-9" }) })
})

blameTest("re-blames after a save without the cursor line changing", async () => {
  let calls = 0
  const service = {
    blame: async (rel: string, line: number) => {
      calls++
      return blame({ summary: `${rel}@${line}` })
    },
  } as unknown as GitService

  const d = liveDoc()
  await mount({ doc: d, line: 7, service, repo: "src/a.ts", nonce: 0 })
  await waitFor(() => observed.kind === "ready")
  expect(observed).toEqual({ kind: "ready", blame: blame({ summary: "src/a.ts@7" }) })
  expect(calls).toBe(1)

  // Edit the line: dirty flips true. Force the re-render the real consumer would
  // get from onDidChange so the hook observes the dirty buffer and hides blame.
  d.setText("mutated", "edit")
  setProps((p) => ({ ...p, nonce: 1 }))
  await waitFor(() => observed.kind === "none")
  expect(observed).toEqual({ kind: "none" })
  expect(calls).toBe(1)

  // Save WITHOUT touching cursorLine: the hook's own onDidSave subscription must
  // drive the re-blame — no prop change here.
  await d.save()
  await waitFor(() => observed.kind === "ready")
  expect(observed).toEqual({ kind: "ready", blame: blame({ summary: "src/a.ts@7" }) })
  expect(calls).toBe(2)
})

blameTest("a stale in-flight result does not overwrite the current line", async () => {
  // Hand back a manually-resolved promise per call so we control ordering.
  const pending: Array<{ line: number; resolve: (b: LineBlame) => void }> = []
  const service = {
    blame: (_rel: string, line: number) =>
      new Promise<LineBlame>((resolve) => pending.push({ line, resolve })),
  } as unknown as GitService

  await mount({ doc: doc(), line: 10, service, repo: "src/a.ts" })
  await waitFor(() => pending.length >= 1) // line 10's debounce fired -> blame(10) in flight
  expect(pending.map((p) => p.line)).toEqual([10])

  setProps((p) => ({ ...p, line: 20 }))
  await waitFor(() => pending.length >= 2) // line 20's debounce fired -> blame(20) in flight
  expect(pending.map((p) => p.line)).toEqual([10, 20])

  // Newer request resolves first: poll until its result lands rather than
  // guessing how long the resolve + re-render takes.
  pending[1].resolve(blame({ summary: "line-20" }))
  await waitFor(() => observed.kind === "ready" && observed.blame.summary === "line-20")
  expect(observed).toEqual({ kind: "ready", blame: blame({ summary: "line-20" }) })

  // Then the stale one resolves: its reqId guard short-circuits WITHOUT setState,
  // so draining its microtask (two flushes) is enough to prove it changed nothing.
  pending[0].resolve(blame({ summary: "line-10" }))
  await testSetup!.flush()
  await testSetup!.flush()

  // Stale line-10 result is discarded; line-20 stands.
  expect(observed).toEqual({ kind: "ready", blame: blame({ summary: "line-20" }) })
})
