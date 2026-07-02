import { useEffect, useState } from "react"
import { documentRegistry, type Document } from "../model/documents.ts"

/**
 * Subscribe a React component to the shared Document for `path`.
 * Opens (refcounts) the document on mount, releases on unmount, and re-renders
 * whenever the document's text changes OR is saved (so a dirty indicator both
 * appears on the first edit and clears the instant the file is saved).
 *
 * The returned doc is read straight from the registry every render, so a change
 * of `path` reflects the NEW document synchronously instead of lingering on the
 * previous path's state during the async open.
 */
export function useDocument(path: string): Document | undefined {
  const [, forceRender] = useState(0)

  useEffect(() => {
    let disposed = false
    let acquired = false
    let unsubscribe: (() => void) | undefined
    const rerender = () => forceRender((n) => n + 1)

    documentRegistry
      .openDocument(path)
      .then((opened) => {
        acquired = true
        if (disposed) {
          acquired = false
          documentRegistry.releaseDocument(path)
          return
        }
        const offChange = opened.onDidChange(rerender)
        const offSave = opened.onDidSave(rerender)
        unsubscribe = () => {
          offChange()
          offSave()
        }
        rerender()
      })
      .catch(() => {
        // Open failed (e.g. FileTooLargeError): leave the doc undefined so the
        // consumer simply never shows a dirty state — no crash, no unhandled
        // rejection warning in tests.
      })

    return () => {
      disposed = true
      unsubscribe?.()
      if (acquired) {
        acquired = false
        documentRegistry.releaseDocument(path)
      }
    }
  }, [path])

  return documentRegistry.get(path)
}
