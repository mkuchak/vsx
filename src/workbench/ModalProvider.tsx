import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { CommitDetailsOverlay } from "../ui/CommitDetailsOverlay"
import { ConfirmDialog, type ConfirmButton } from "../ui/ConfirmDialog"
import type { CommitInfo, CommitStats } from "../services/git"
import { useOverlay } from "./OverlayProvider"

export type ConfirmOptions = {
  message: string
  detail?: string
  /** 2 or 3 choices; the promise resolves with the chosen button's id. */
  buttons: ConfirmButton[]
}

export type CommitDetailsOptions = {
  commit: CommitInfo
  /** Lazily fetched when the overlay opens; resolves null on failure. */
  fetchStats: () => Promise<CommitStats | null>
}

type ModalContextValue = {
  /** Open a confirmation; resolves with the chosen button id, or null if cancelled. */
  confirm: (options: ConfirmOptions) => Promise<string | null>
  /** Open the read-only commit-details inspector over the whole viewport. */
  showCommitDetails: (options: CommitDetailsOptions) => void
}

type PendingModal = ConfirmOptions & { resolve: (choice: string | null) => void }

const ModalContext = createContext<ModalContextValue | null>(null)

/**
 * Root-level modal host. Mounted as a child of the full-size App box so its
 * ConfirmDialog renders centered over the whole viewport (scrim included),
 * instead of being trapped inside whichever panel opened it. Exposes a
 * promise-based `useConfirm()` so callers `await` a choice rather than threading
 * onSelect/onCancel callbacks and their own pending state.
 */
export function ModalProvider({ children }: { children?: ReactNode }) {
  const { setOverlayOpen } = useOverlay()
  const [pending, setPending] = useState<PendingModal | null>(null)
  const [details, setDetails] = useState<CommitDetailsOptions | null>(null)
  const pendingRef = useRef<PendingModal | null>(null)
  pendingRef.current = pending

  // A confirm dialog counts as an overlay: report its open/closed state into the
  // shared signal so global key handlers gate on it and focus is restored on close.
  useEffect(() => {
    setOverlayOpen("modal", pending !== null)
    return () => setOverlayOpen("modal", false)
  }, [pending, setOverlayOpen])

  // The commit-details inspector is a separate overlay id so it gates global keys
  // and restores focus independently of any confirm dialog.
  useEffect(() => {
    setOverlayOpen("commitDetails", details !== null)
    return () => setOverlayOpen("commitDetails", false)
  }, [details, setOverlayOpen])

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<string | null>((resolve) => {
      // A second confirm() while one is open cancels the first, mirroring how a
      // new prompt supersedes a stale one.
      const prev = pendingRef.current
      if (prev) prev.resolve(null)
      setPending({ ...options, resolve })
    })
  }, [])

  const resolveWith = useCallback((choice: string | null) => {
    const current = pendingRef.current
    setPending(null)
    current?.resolve(choice)
  }, [])

  const showCommitDetails = useCallback((options: CommitDetailsOptions) => {
    setDetails(options)
  }, [])

  // Teardown while a modal is still open: settle the dangling promise so awaiters
  // don't hang. ConfirmDialog's own effect cleanup pops the keymap layer.
  useEffect(() => {
    return () => {
      pendingRef.current?.resolve(null)
    }
  }, [])

  const value: ModalContextValue = { confirm, showCommitDetails }

  return (
    <ModalContext.Provider value={value}>
      {children}
      {pending ? (
        <ConfirmDialog
          message={pending.message}
          detail={pending.detail}
          buttons={pending.buttons}
          onSelect={(id) => resolveWith(id)}
          onCancel={() => resolveWith(null)}
        />
      ) : null}
      {details ? (
        <CommitDetailsOverlay
          commit={details.commit}
          fetchStats={details.fetchStats}
          onClose={() => setDetails(null)}
        />
      ) : null}
    </ModalContext.Provider>
  )
}

export function useConfirm(): (options: ConfirmOptions) => Promise<string | null> {
  const ctx = useContext(ModalContext)
  if (!ctx) throw new Error("useConfirm must be used within a ModalProvider")
  return ctx.confirm
}

export function useCommitDetails(): (options: CommitDetailsOptions) => void {
  const ctx = useContext(ModalContext)
  if (!ctx) throw new Error("useCommitDetails must be used within a ModalProvider")
  return ctx.showCommitDetails
}
