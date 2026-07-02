import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"

type OverlayContextValue = {
  /** True while ANY overlay (Quick Open, a confirm dialog, …) owns the screen. */
  isOverlayOpen: boolean
  /** Bumps every time the last open overlay closes — a signal to restore focus. */
  overlayCloseEpoch: number
  /** Register/unregister an overlay by a stable id as it opens/closes. */
  setOverlayOpen: (id: string, open: boolean) => void
}

// A no-op default so components used in isolation (unit tests, storybook-style
// renders) work without an OverlayProvider — there's simply no overlay to gate
// on. The real workbench always wraps the tree in an OverlayProvider.
const DEFAULT_OVERLAY: OverlayContextValue = {
  isOverlayOpen: false,
  overlayCloseEpoch: 0,
  setOverlayOpen: () => {},
}

const OverlayContext = createContext<OverlayContextValue>(DEFAULT_OVERLAY)

/**
 * Tracks whether any modal/overlay currently owns the keyboard so every global
 * `useKeyboard` handler can gate itself with one shared `isOverlayOpen` signal,
 * and exposes an `overlayCloseEpoch` that increments on each open→closed
 * transition. OpenTUI focus is singular and the React reconciler only re-focuses
 * a renderable when its `focused` PROP changes, so an overlay stealing native
 * focus (its `<input focused>`) leaves the editor's textarea unfocused after it
 * closes even though the textarea's own prop never changed — consumers watch the
 * epoch to imperatively re-focus via {@link useOverlayFocusRestore}.
 */
export function OverlayProvider({ children }: { children?: ReactNode }) {
  const openIdsRef = useRef<Set<string>>(new Set())
  const [isOverlayOpen, setIsOverlayOpen] = useState(false)
  const [overlayCloseEpoch, setOverlayCloseEpoch] = useState(0)

  const setOverlayOpen = useCallback((id: string, open: boolean) => {
    const set = openIdsRef.current
    const had = set.size > 0
    if (open) set.add(id)
    else set.delete(id)
    const has = set.size > 0
    if (had === has) return
    setIsOverlayOpen(has)
    // Only the transition to "nothing open" restores focus to whatever was
    // logically focused before the overlay took over.
    if (had && !has) setOverlayCloseEpoch((n) => n + 1)
  }, [])

  const value: OverlayContextValue = { isOverlayOpen, overlayCloseEpoch, setOverlayOpen }

  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>
}

export function useOverlay(): OverlayContextValue {
  return useContext(OverlayContext)
}

/**
 * Imperatively re-focus `ref` whenever the last overlay closes, but only while
 * `active` (i.e. this is the pane logical focus should return to). The imperative
 * `.focus()` is required because a prop change alone won't re-focus — the
 * reconciler only calls `.focus()` on a `focused` prop transition, which never
 * happens for a pane whose prop stayed `true` under the overlay.
 */
export function useOverlayFocusRestore<T extends { focus: () => void }>(
  ref: RefObject<T | null>,
  active: boolean,
) {
  const { overlayCloseEpoch } = useOverlay()
  const activeRef = useRef(active)
  activeRef.current = active
  // Skip the mount run (and any epoch already elapsed before this mounted) so a
  // freshly-mounted pane never steals focus retroactively.
  const seenRef = useRef(overlayCloseEpoch)

  useEffect(() => {
    if (overlayCloseEpoch === seenRef.current) return
    seenRef.current = overlayCloseEpoch
    if (activeRef.current) ref.current?.focus()
  }, [overlayCloseEpoch, ref])
}
