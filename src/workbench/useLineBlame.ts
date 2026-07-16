import { useEffect, useRef, useState } from "react"
import type { Document } from "../model/documents.ts"
import type { GitService, LineBlame } from "../services/git.ts"

/** How long the cursor must rest on a line before we shell out to `git blame`.
 *  Kept a touch below EditorPane's 160ms syntax-highlight debounce: blame is a
 *  single cheap `git blame -L n,n` spawn and the annotation should feel prompt,
 *  but rapid up/down arrow scrolling must not spawn a process per line grazed. */
const BLAME_DEBOUNCE_MS = 120

export type BlameState =
  // No repo, no cursor line, a DIRTY buffer, or the current line's blame is not
  // resolved yet — the consumer renders nothing. A distinct "loading" kind is
  // deliberately folded into this: the annotation is either present or absent,
  // there is no useful intermediate UX, and collapsing the two keeps the
  // presentational component (BlameAnnotation) trivially a function of `blame`.
  | { kind: "none" }
  | { kind: "ready"; blame: LineBlame }

/**
 * Compute the GitLens-style inline blame for the document's current cursor line.
 *
 * Two correctness rules drive the design:
 *
 *  1. DIRTY-GATING. `git blame` blames the last-saved-to-disk content, not the
 *     in-memory buffer. While the doc has unsaved edits the live line number no
 *     longer lines up with what git would blame, so we return `{ kind: "none" }`
 *     the instant the doc is dirty and never spawn git. (This is unrelated to
 *     `LineBlame.uncommitted`, which is git's own report that the LAST COMMITTED
 *     state of the line was itself an uncommitted change.)
 *
 *  2. DON'T RE-SHELL ON EVERY KEYSTROKE. The effect keys on the tuple that
 *     actually changes the answer — (repoRootRelativePath, cursorLine, the doc's
 *     version, dirtiness) — so typing more characters mid-line (line number
 *     unchanged) or an unrelated re-render does NOT re-blame. Moving to a
 *     genuinely different line re-blames directly.
 *
 *     A save is the awkward case: `Document.save()` clears dirtiness but does NOT
 *     advance `version` or fire `onDidChange`, and if the cursor hasn't moved
 *     nothing else re-renders the consumer either — so the main effect would never
 *     notice the dirty -> clean flip and the annotation would stay hidden until the
 *     next genuine line change. We therefore subscribe to `doc.onDidSave` here and
 *     bump an internal `saveTick`, which is in the main effect's deps: a save fires
 *     exactly one re-evaluation, going through the same eligibility + debounce +
 *     stale-cancellation path a line change does (at most once per save).
 *
 * Stale in-flight results are discarded via a monotonic `reqId` ref: a resolved
 * blame is applied only if its captured id is still the latest, so line 10's
 * slow spawn can't clobber line 20's newer result. Mirrors the `highlightReqId`
 * pattern in EditorPane.
 */
export function useLineBlame(
  doc: Document | undefined,
  cursorLine: number | null,
  service: GitService | null,
  repoRootRelativePath: string | null,
): BlameState {
  const [state, setState] = useState<BlameState>({ kind: "none" })
  const reqId = useRef(0)

  const dirty = doc?.isDirty
  const version = doc?.version

  // A save clears dirtiness without advancing `version` or firing `onDidChange`,
  // so bump this on every save to force the main effect to re-evaluate. Keyed to
  // `doc` identity so switching files tears the old subscription down.
  const [saveTick, setSaveTick] = useState(0)
  useEffect(() => {
    if (!doc) return
    return doc.onDidSave(() => setSaveTick((n) => n + 1))
  }, [doc])

  useEffect(() => {
    const eligible =
      dirty === false &&
      service !== null &&
      repoRootRelativePath !== null &&
      cursorLine !== null

    // Bump the id on every (re-)run so any blame still in flight from the
    // previous line resolves stale and is dropped.
    const id = ++reqId.current

    if (!eligible) {
      // Dirty / no repo / no line: clear any annotation and don't spawn git.
      setState({ kind: "none" })
      return
    }

    // The line/doc key genuinely changed (deps below): the previous line's
    // annotation is now stale, so clear it immediately rather than showing the
    // wrong line's blame during the debounce + spawn.
    setState({ kind: "none" })

    const timer = setTimeout(() => {
      service
        .blame(repoRootRelativePath, cursorLine)
        .then((blame) => {
          if (id !== reqId.current) return // a newer line won
          setState(blame ? { kind: "ready", blame } : { kind: "none" })
        })
        .catch(() => {
          if (id !== reqId.current) return
          setState({ kind: "none" })
        })
    }, BLAME_DEBOUNCE_MS)

    return () => clearTimeout(timer)
    // `version` re-blames on an edit; `saveTick` re-blames after a save (which
    // flips dirty -> clean without advancing version). Unrelated re-renders touch
    // none of these and are ignored.
  }, [dirty, version, saveTick, service, repoRootRelativePath, cursorLine])

  return state
}
