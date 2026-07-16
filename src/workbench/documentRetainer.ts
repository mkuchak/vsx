/**
 * Keeps a DocumentModel alive for as long as ANY open tab references it.
 *
 * VSCode-style: a document must survive being backgrounded. Editor/diff panes
 * only refcount the tab they currently render, so switching away from a dirty
 * tab would drop its refcount to zero and dispose its unsaved edits. This
 * retainer holds one refcount per DISTINCT underlying file path across every
 * open tab in every group, so a document lives until its last tab is closed.
 */

import { documentRegistry } from "../model/documents.ts"
import { workbenchStore, type WorkbenchState } from "../model/workbench.ts"

/**
 * "opening": open in flight, still wanted. "opening-cancelled": open in flight
 * but the path already left the union — release the moment it resolves.
 * "open": acquired a refcount, still wanted.
 */
type Retention = "opening" | "opening-cancelled" | "open"

/** The set of real file paths referenced by open tabs (diff tabs use `filePath`). */
function retainedPaths(state: WorkbenchState): Set<string> {
  const paths = new Set<string>()
  for (const group of state.groups) {
    for (const tab of group.tabs) {
      paths.add(tab.kind === "file" ? tab.path : tab.filePath)
    }
  }
  return paths
}

export function startDocumentRetainer(): () => void {
  const retentions = new Map<string, Retention>()

  const acquire = (path: string) => {
    retentions.set(path, "opening")
    documentRegistry.openDocument(path).then(
      () => {
        // Released between request and resolve: balance the refcount now.
        if (retentions.get(path) === "opening-cancelled") {
          retentions.delete(path)
          documentRegistry.releaseDocument(path)
        } else {
          retentions.set(path, "open")
        }
      },
      () => {
        // Unreadable (e.g. FileTooLargeError) — swallow; the path isn't retained
        // and keeps its own too-large preview handling in the editor pane.
        retentions.delete(path)
      },
    )
  }

  const release = (path: string) => {
    const state = retentions.get(path)
    if (state === "open") {
      retentions.delete(path)
      documentRegistry.releaseDocument(path)
    } else if (state === "opening") {
      retentions.set(path, "opening-cancelled")
    }
  }

  const sync = () => {
    const wanted = retainedPaths(workbenchStore.getState())
    for (const path of wanted) {
      const state = retentions.get(path)
      if (state === undefined) acquire(path)
      else if (state === "opening-cancelled") retentions.set(path, "opening")
    }
    for (const path of [...retentions.keys()]) {
      if (!wanted.has(path)) release(path)
    }
  }

  sync()
  const unsubscribe = workbenchStore.subscribe(sync)

  // A rename/move re-keys the registry entry itself (documentRegistry.retarget
  // runs first, in App.tsx), so the refcount is already correct at the new path.
  // Mirror that here as a PURE local re-key — moving whatever state (including an
  // in-flight "opening"/"opening-cancelled") sits at oldPath to newPath — with no
  // registry acquire/release. Routing this through sync()'s acquire(newPath) /
  // release(oldPath) pair would double-count: acquire would bump the already
  // re-keyed entry's refcount while release(oldPath) no-ops on the vacated key.
  const unsubscribeRetarget = workbenchStore.onTabPathRetargeted((oldPath, newPath) => {
    const state = retentions.get(oldPath)
    if (state === undefined) return
    retentions.delete(oldPath)
    retentions.set(newPath, state)
  })

  return () => {
    unsubscribe()
    unsubscribeRetarget()
    for (const path of [...retentions.keys()]) release(path)
  }
}
