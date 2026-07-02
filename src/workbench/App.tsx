import { CliRenderEvents, type Selection } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { workbenchStore } from "../model/workbench"
import { handleRendererSelection } from "./rendererSelection"
import { activeRepoFor, discoverRepositories, type RepoInfo } from "../services/repos"
import { theme } from "../theme"
import { CommandsProvider, useCommands } from "./CommandsProvider"
import { startDocumentRetainer } from "./documentRetainer"
import { ModalProvider, useConfirm } from "./ModalProvider"
import { OverlayProvider, useOverlay } from "./OverlayProvider"
import { getEditorControls } from "./editorControls"
import { useWorkbenchStore } from "./useWorkbenchStore"
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from "./sidebarWidth"
import { WatchersProvider } from "./watchers"
import { CommitLog } from "../ui/CommitLog"
import { EditorGroups } from "../ui/EditorGroups"
import type { CursorPosition } from "../ui/EditorPane"
import { FileTree } from "../ui/FileTree"
import { QuickInput } from "../ui/QuickInput"
import { ScmPanel } from "../ui/ScmPanel"
import { SidebarTabs, type SidebarView } from "../ui/SidebarTabs"
import { applyArmedDrag, disarmDrag, endArmedDrag } from "../ui/dragManager"
import { SplitDivider } from "../ui/SplitDivider"
import { StatusBar } from "../ui/StatusBar"

/**
 * The assembled vsx workbench: sidebar (Explorer / Source Control / History,
 * switchable) | editor groups | status bar, plus the Quick Open overlay
 * mounted once at the root. Wires every panel built in earlier tasks together
 * — opening a file/diff moves keyboard focus into the editor; Esc from the
 * sidebar returns focus to the editor.
 */
export function App({ workspaceRoot = process.cwd() }: { workspaceRoot?: string } = {}) {
  return (
    <CommandsProvider>
      <OverlayProvider>
        <WatchersProvider workspaceRoot={workspaceRoot}>
          <Workbench workspaceRoot={workspaceRoot} />
        </WatchersProvider>
      </OverlayProvider>
    </CommandsProvider>
  )
}

function Workbench({ workspaceRoot }: { workspaceRoot: string }) {
  const renderer = useRenderer()
  const commands = useCommands()
  const { isOverlayOpen } = useOverlay()
  const { width: termWidth } = useTerminalDimensions()
  const workbench = useWorkbenchStore()

  // Only file tabs have a cursor: diff/commitDiff panes don't, so the status bar
  // must not keep showing the last file's Ln/Col over them. Gate here rather than
  // in StatusBar (which is fed a raw cursor prop directly by its own unit tests).
  const activeGroup = workbench.groups.find((g) => g.id === workbench.activeGroupId)
  const activeTab = activeGroup?.tabs.find((t) => t.path === activeGroup.activeTabPath)
  const activeTabIsFile = activeTab?.kind === "file"

  const [sidebarView, setSidebarView] = useState<SidebarView>("explorer")
  // Focus lives in the store now (the single source of truth), so a group-focus
  // command can move keyboard focus even though it's registered elsewhere. This
  // re-renders on every store change via the useWorkbenchStore subscription above.
  const focusArea = workbench.focusArea
  const [cursor, setCursor] = useState<CursorPosition | null>(null)
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)

  // Width captured at the start of a drag; deltas are measured against it so the
  // continuously-updated live width doesn't compound with each drag event.
  const dragStartWidth = useRef(sidebarWidth)
  const gestureActive = useRef(false)

  const handleSidebarDelta = (delta: number) => {
    if (!gestureActive.current) {
      gestureActive.current = true
      dragStartWidth.current = sidebarWidth
    }
    setSidebarWidth(clampSidebarWidth(dragStartWidth.current, delta, termWidth))
  }
  const handleSidebarCommit = () => {
    gestureActive.current = false
  }
  const handleSidebarReset = () => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)

  // Switch the sidebar to a view AND move keyboard focus onto the sidebar.
  // Shared verbatim by the Ctrl+Shift+E/G/H commands and the SidebarTabs click
  // path so both input methods drive identical state (setters are stable, so the
  // callback identity is too — keeps the command-registration effect from re-running).
  const focusView = useCallback((view: SidebarView) => {
    setSidebarView(view)
    workbenchStore.setFocusArea("sidebar")
  }, [])

  const overlayOpenRef = useRef(isOverlayOpen)
  overlayOpenRef.current = isOverlayOpen

  // While an overlay owns the screen, block every base command from dispatching
  // (keybinding or executeCommand) so a stray chord like Ctrl+W can't fire
  // underneath — and, worse, stack a second overlay on top of the first. Reads
  // the live ref so the gate never re-registers. workbench.quit is exempt so the
  // app can always be quit; palette-run commands bypass the gate explicitly.
  useEffect(() => {
    commands.setDispatchGate((id) => !overlayOpenRef.current || id === "workbench.quit")
    return () => commands.setDispatchGate(undefined)
  }, [commands])

  // Hold a document refcount for every open tab so backgrounded/inactive tabs
  // (and diff panes reading the live file) keep their unsaved edits alive.
  useEffect(() => startDocumentRetainer(), [])

  // Copy-on-select + Ctrl+C fallback cache for renderer-level selections. The
  // renderer emits `selection` on mouse-up with the finished drag — the only
  // signal for surfaces with no edit buffer (diff pane, commit log, SCM panel,
  // too-large preview). Subscribed once here so every such surface is covered.
  useEffect(() => {
    const onSelection = (selection: Selection | null) => {
      if (selection) handleRendererSelection(selection, renderer)
    }
    renderer.on(CliRenderEvents.SELECTION, onSelection)
    return () => {
      renderer.off(CliRenderEvents.SELECTION, onSelection)
    }
  }, [renderer])

  // Resolved once for the workspace; used to attach a repoRoot to ScmPanel's
  // (path, kind)-only onOpenDiff callback via the deepest containing repo.
  useEffect(() => {
    void discoverRepositories(workspaceRoot).then(setRepos)
  }, [workspaceRoot])

  useEffect(
    () =>
      commands.registerCommand({
        id: "workbench.quit",
        title: "Quit vsx",
        category: "Workbench",
        keybinding: "ctrl+q",
        run: () => renderer.destroy(),
      }),
    [commands, renderer],
  )

  useEffect(() => {
    const disposers = [
      commands.registerCommand({
        id: "workbench.focusExplorer",
        title: "Show Explorer",
        category: "View",
        keybinding: "ctrl+shift+e",
        run: () => focusView("explorer"),
      }),
      commands.registerCommand({
        id: "workbench.focusScm",
        title: "Show Source Control",
        category: "View",
        keybinding: "ctrl+shift+g",
        run: () => focusView("scm"),
      }),
      commands.registerCommand({
        id: "workbench.focusHistory",
        title: "Show History",
        category: "View",
        keybinding: "ctrl+shift+h",
        run: () => focusView("history"),
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [commands, focusView])

  // Esc moves focus from the sidebar into the editor's active tab (opening a
  // file/diff does the same); the editor→sidebar direction is driven by the
  // view-focus commands (Ctrl+Shift+E/G/H) instead. Suppressed while an overlay
  // is open so the same Esc that dismisses a Quick Open / confirm dialog doesn't
  // also flip sidebar→editor focus underneath it.
  useKeyboard((key) => {
    if (overlayOpenRef.current) return
    if (workbenchStore.getState().focusArea === "sidebar" && key.name === "escape") {
      workbenchStore.setFocusArea("editor")
    }
  })

  // openFile/openDiff no longer flip focus here: the store's open* methods set
  // focusArea='editor' themselves, so every open path (FileTree, Quick Open,
  // SCM) routes through the SAME single source of truth.
  const openFile = (path: string, opts?: { preview?: boolean }) => {
    workbenchStore.openFile(path, opts)
  }

  // Quick Open's `:line[:col]` accept lands here. Resolve the ACTIVE group's
  // editor controls (absent for a diff pane or an empty group → silent no-op),
  // move the cursor, and flip focus to the editor. Keyboard focus is actually
  // returned to the textarea by the overlay-close focus-restore effect once Quick
  // Open closes; setting focusArea here just makes that pane the restore target.
  const gotoLine = (line: number, column?: number) => {
    const controls = getEditorControls(workbenchStore.getState().activeGroupId)
    if (!controls) return
    workbenchStore.setFocusArea("editor")
    controls.gotoLine(line, column)
  }

  const openDiff = (path: string, kind: "staged" | "unstaged") => {
    const repo = activeRepoFor(path, repos)
    if (!repo) return
    workbenchStore.openDiff(path, kind, repo.root, { preview: true })
  }

  const sidebarFocused = focusArea === "sidebar"
  const editorFocused = focusArea === "editor"

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.background}>
      <ModalProvider>
        <DirtyCloseWiring />
        <box
          flexDirection="row"
          flexGrow={1}
          // The sidebar sash's drag captures the neighboring pane, not the 1-col
          // sash, so its drag events bubble up to this main row. Service the armed
          // "sidebar" gesture here; the kind guard ignores split drags that also
          // bubble through (the editor column is nested under this row).
          onMouseDrag={(e) => applyArmedDrag("sidebar", e.x)}
          onMouseDragEnd={() => endArmedDrag("sidebar")}
          onMouseUp={() => disarmDrag()}
        >
          <box
            id="sidebar"
            width={sidebarWidth}
            flexShrink={0}
            height="100%"
            flexDirection="column"
            backgroundColor={theme.sidebarBackground}
          >
            <SidebarTabs active={sidebarView} onSelect={focusView} />
            <box flexGrow={1} flexShrink={1} width="100%">
              {sidebarView === "explorer" ? (
                <FileTree root={workspaceRoot} focused={sidebarFocused} onOpenFile={openFile} />
              ) : sidebarView === "scm" ? (
                <ScmPanel
                  workspaceRoot={workspaceRoot}
                  focused={sidebarFocused}
                  onOpenFile={(path) => openFile(path, { preview: true })}
                  onOpenDiff={openDiff}
                />
              ) : (
                <CommitLog workspaceRoot={workspaceRoot} focused={sidebarFocused} />
              )}
            </box>
          </box>
          <SplitDivider
            kind="sidebar"
            onDelta={handleSidebarDelta}
            onCommit={handleSidebarCommit}
            onReset={handleSidebarReset}
          />
          <box flexDirection="column" flexGrow={1} height="100%">
            <EditorGroups
              editorFocused={editorFocused}
              onCursorChange={editorFocused ? setCursor : undefined}
              containerWidth={Math.max(1, termWidth - sidebarWidth - 1)}
            />
          </box>
        </box>
        <StatusBar
          workspaceRoot={workspaceRoot}
          cursor={editorFocused && activeTabIsFile ? cursor : null}
        />
        <QuickInput workspaceRoot={workspaceRoot} onGotoLine={gotoLine} />
      </ModalProvider>
    </box>
  )
}

/**
 * Bridges the store's framework-agnostic dirty-close guard to the root modal
 * host: on mount it registers a handler that raises VSCode's Save / Don't Save /
 * Cancel prompt and maps the chosen button back to the store's choice union.
 * Must render inside ModalProvider so useConfirm resolves.
 */
function DirtyCloseWiring() {
  const confirm = useConfirm()

  useEffect(() => {
    workbenchStore.setConfirmDirtyCloseHandler(async (path) => {
      const name = path.slice(path.lastIndexOf("/") + 1)
      const choice = await confirm({
        message: `Do you want to save the changes you made to ${name}?`,
        detail: "Your changes will be lost if you don't save them.",
        buttons: [
          { id: "save", label: "Save", isDefault: true },
          { id: "discard", label: "Don't Save" },
          { id: "cancel", label: "Cancel" },
        ],
      })
      // Esc / teardown resolves null — treat anything but an explicit choice as cancel.
      return choice === "save" || choice === "discard" ? choice : "cancel"
    })
    return () => workbenchStore.setConfirmDirtyCloseHandler(undefined)
  }, [confirm])

  return null
}
