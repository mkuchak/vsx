import { useSyncExternalStore } from "react"
import { workbenchStore, type WorkbenchState, type WorkbenchStore } from "../model/workbench.ts"

/**
 * Subscribe a React component to a WorkbenchStore and re-render on any change.
 * Returns the live {@link WorkbenchState}; defaults to the app-wide singleton.
 */
export function useWorkbenchStore(store: WorkbenchStore = workbenchStore): WorkbenchState {
  useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getVersion(),
  )
  return store.getState()
}
