import { CliRenderEvents, type Selection } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { dirname, join } from "node:path"
import { workbenchStore } from "../model/workbench"
import { documentRegistry } from "../model/documents"
import * as clipboard from "../services/clipboard"
import type { Osc52Writer } from "../services/clipboard"
import * as trash from "../services/trash"
import { createFile, createFolder, PathExistsError, renamePath } from "../services/workspace"
import { withMacSuper } from "../services/commands"
import { createFileHistory, type FileHistory } from "../services/fileHistory"
import { KeyInspector } from "../services/keyInspector"
import { getLastRendererSelection, handleRendererSelection } from "./rendererSelection"
import { activeRepoFor } from "../services/repos"
import { theme } from "../theme"
import { CommandsProvider, useCommands } from "./CommandsProvider"
import { startDocumentRetainer } from "./documentRetainer"
import { ModalProvider, useConfirm, type ConfirmOptions } from "./ModalProvider"
import { OverlayProvider, useOverlay } from "./OverlayProvider"
import { getEditorControls } from "./editorControls"
import { useWorkbenchStore } from "./useWorkbenchStore"
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from "./sidebarWidth"
import { ReposProvider, useRepos } from "./ReposProvider"
import { WatchersProvider, useWorkbenchWatchers } from "./watchers"
import { CommitLog } from "../ui/CommitLog"
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu"
import { EditorGroups } from "../ui/EditorGroups"
import type { CursorPosition } from "../ui/EditorPane"
import { FileTree } from "../ui/FileTree"
import { FindWidget } from "../ui/FindWidget"
import { SearchPanel } from "../ui/SearchPanel"
import { QuickInput } from "../ui/QuickInput"
import { ScmPanel } from "../ui/ScmPanel"
import { SidebarFooter } from "../ui/SidebarFooter"
import { SidebarTabs, type SidebarView } from "../ui/SidebarTabs"
import { applyArmedDrag, disarmDrag, endArmedDrag } from "../ui/dragManager"
import { SplitDivider } from "../ui/SplitDivider"
import { StatusBar, type StatusBarProps } from "../ui/StatusBar"
import { TextInputDialog } from "../ui/TextInputDialog"

/**
 * The assembled vsx workbench: sidebar (Explorer / Source Control / History,
 * switchable) | editor groups | status bar, plus the Quick Open overlay
 * mounted once at the root. Wires every panel built in earlier tasks together
 * — opening a file/diff moves keyboard focus into the editor; Esc from the
 * sidebar returns focus to the editor.
 */
export function App({
  workspaceRoot = process.cwd(),
  initialFile,
}: { workspaceRoot?: string; initialFile?: string } = {}) {
  return (
    <CommandsProvider>
      <OverlayProvider>
        <ReposProvider workspaceRoot={workspaceRoot}>
          <WatchersProvider workspaceRoot={workspaceRoot}>
            <Workbench workspaceRoot={workspaceRoot} initialFile={initialFile} />
          </WatchersProvider>
        </ReposProvider>
      </OverlayProvider>
    </CommandsProvider>
  )
}

/** The renderable id EditorPane gives its editable textarea (see EditorPane.tsx). */
const EDITOR_TEXTAREA_ID = "editor-textarea"

/**
 * True when a focused editor textarea is the renderable that will handle Ctrl+C,
 * so the global fallback must stand down to avoid a double-copy. We ask the
 * renderer for the natively-focused renderable rather than inferring it from the
 * store: an editable file mounts the textarea, but a too-large file renders a
 * read-only preview scrollbox under the SAME "file" tab — that preview has no
 * Ctrl+C of its own, so the global handler MUST copy for it. Keying off the
 * focused renderable's id draws the line exactly where the textarea handler runs.
 */
function editorTextareaOwnsClipboard(renderer: { currentFocusedRenderable: { id?: string } | null }): boolean {
  return renderer.currentFocusedRenderable?.id === EDITOR_TEXTAREA_ID
}

function Workbench({ workspaceRoot, initialFile }: { workspaceRoot: string; initialFile?: string }) {
  const renderer = useRenderer()
  const commands = useCommands()
  const { isOverlayOpen } = useOverlay()
  const { width: termWidth } = useTerminalDimensions()
  const workbench = useWorkbenchStore()
  const watchers = useWorkbenchWatchers()

  // Only file tabs have a cursor: diff/commitDiff panes don't, so the status bar
  // must not keep showing the last file's Ln/Col over them. Gate here rather than
  // in StatusBar (which is fed a raw cursor prop directly by its own unit tests).
  const activeGroup = workbench.groups.find((g) => g.id === workbench.activeGroupId)
  const activeTab = activeGroup?.tabs.find((t) => t.path === activeGroup.activeTabPath)
  const activeTabIsFile = activeTab?.kind === "file"

  const [sidebarView, setSidebarView] = useState<SidebarView>("explorer")
  // A breadcrumb-segment click reveals that path in the Explorer tree. The token
  // makes each click a distinct request even when the path repeats, so FileTree's
  // reveal effect re-fires; it never opens a floating picker (product decision).
  const [revealRequest, setRevealRequest] = useState<{ path: string; token: number } | null>(null)
  // Which Explorer row (if any) currently has its right-click context menu open,
  // plus the click coords to anchor the menu at. Lifted out of FileTree so the
  // popup mounts at the App root (see ExplorerContextMenu) — FileTree's own
  // <scrollbox> would clip an absolutely-positioned menu, and the menu needs
  // full-screen coordinates for its backdrop + edge-clamping anyway.
  const [explorerMenu, setExplorerMenu] = useState<ExplorerMenuState | null>(null)
  // The Rename / Move / New File / New Folder text-input modal, opened from the
  // Explorer context menu. Hosted here (not inside the context menu, which
  // unmounts the instant an item is chosen) so the dialog outlives the menu and
  // mounts inside ModalProvider. One dialog at a time; null when closed.
  const [textDialog, setTextDialog] = useState<ExplorerTextDialogRequest | null>(null)
  // Focus lives in the store now (the single source of truth), so a group-focus
  // command can move keyboard focus even though it's registered elsewhere. This
  // re-renders on every store change via the useWorkbenchStore subscription above.
  const focusArea = workbench.focusArea
  const [cursor, setCursor] = useState<CursorPosition | null>(null)
  // Shared with every SCM panel via ReposProvider — one discovery pass, not five.
  // Used here to attach a repoRoot to ScmPanel's (path, kind)-only onOpenDiff.
  const { repos } = useRepos(workspaceRoot)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // Mirror of sidebarCollapsed for the stable toggle callback so it can read the
  // live value without re-registering the Ctrl+B command on every collapse.
  const collapsedRef = useRef(sidebarCollapsed)
  collapsedRef.current = sidebarCollapsed

  // Gate the git working-tree staleness poll on the Source Control view actually
  // being on screen (its tab is active AND the sidebar isn't collapsed). Nothing
  // consumes external-edit staleness otherwise, so the ~10s poll shouldn't run.
  const scmVisible = sidebarView === "scm" && !sidebarCollapsed
  useEffect(() => {
    watchers?.setScmVisible(scmVisible)
  }, [watchers, scmVisible])

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
  // Also un-collapses: revealing a hidden view re-shows the sidebar, matching how
  // VSCode's Ctrl+Shift+E reveals a hidden Explorer.
  const focusView = useCallback((view: SidebarView) => {
    setSidebarView(view)
    setSidebarCollapsed(false)
    workbenchStore.setFocusArea("sidebar")
  }, [])

  // A breadcrumb-segment click (any directory or the filename itself) forces the
  // Explorer view on-screen and reveals that exact path in the tree. Force the
  // sidebar visible (setSidebarCollapsed(false)) rather than toggling — the click
  // must always show, never hide. Bumps the reveal token so an identical repeat
  // path still re-fires FileTree's reveal effect. Setters are stable, so no deps.
  const revealInExplorer = useCallback((path: string) => {
    setSidebarView("explorer")
    setSidebarCollapsed(false)
    setRevealRequest((prev) => ({ path, token: (prev?.token ?? 0) + 1 }))
  }, [])

  // Collapse the sidebar and, if it currently owns keyboard focus, hand focus
  // back to the editor — its subtree is about to unmount, so keys must not keep
  // landing on the tree (mirrors the Esc sidebar→editor handler).
  const collapseSidebar = useCallback(() => {
    setSidebarCollapsed(true)
    if (workbenchStore.getState().focusArea === "sidebar") {
      workbenchStore.setFocusArea("editor")
    }
  }, [])

  // Toggle for Ctrl+B and the status-bar ☰ cell: hide when shown, reveal when
  // hidden. Collapsing performs the same focus handoff as collapseSidebar.
  const toggleSidebar = useCallback(() => {
    const next = !collapsedRef.current
    setSidebarCollapsed(next)
    if (next && workbenchStore.getState().focusArea === "sidebar") {
      workbenchStore.setFocusArea("editor")
    }
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

  // Persisted frecency file-history: records every real file open so Quick Open
  // can rank most-used files across projects. Created once (lazy ref) at render so
  // the SAME instance both records opens and backs Quick Open's ranking/eviction.
  // The recorder wiring below still mounts BEFORE the initialFile effect, so the
  // `vsx <file>` boot open is counted too.
  const fileHistoryRef = useRef<FileHistory | null>(null)
  const fileHistory = (fileHistoryRef.current ??= createFileHistory())
  useEffect(() => {
    workbenchStore.setOpenRecorder(fileHistory.record)
    return () => workbenchStore.setOpenRecorder(null)
  }, [fileHistory])

  // `vsx <file>` opens that file on boot as a permanent tab (matching `code
  // <file>`); openFile also activates it and moves focus into the editor.
  // Mount-once: the CLI arg is fixed for the session, so re-running on prop
  // change would reopen it after the user closed the tab.
  useEffect(() => {
    if (initialFile) workbenchStore.openFile(initialFile, { preview: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Global Ctrl+C copy for the buffer-less surfaces: diff/commitDiff panes, the
  // sidebar panels, and the too-large-file preview. With copy-on-select off, this
  // is their ONLY copy path. EditorPane's own Ctrl+C already copies the focused
  // textarea (falling back to the same cache), so this fires ONLY when that
  // textarea is NOT the focused renderable — see editorTextareaOwnsClipboard.
  // Skips Shift+Ctrl+C and never fires under an overlay (both matching the editor
  // handler's guards) so the two paths can't double-copy.
  useKeyboard((key) => {
    if (overlayOpenRef.current) return
    if (!key.ctrl || key.shift || key.name !== "c") return
    if (editorTextareaOwnsClipboard(renderer)) return
    const text = getLastRendererSelection()
    if (text) void clipboard.write(text, renderer)
  })

  useEffect(
    () =>
      commands.registerCommand({
        id: "workbench.quit",
        title: "Quit vsx",
        category: "Workbench",
        keybinding: ["ctrl+q", "ctrl+alt+q"],
        run: () => {
          // Best-effort: persist the frecency ranking before teardown, but never
          // block quitting for long on a slow cache write — race the flush
          // against a 250ms timeout and destroy either way (usually persists,
          // never hangs). flush() is still invoked synchronously here, before
          // any await, so an immediately-following quit still sees it called.
          const flushed = fileHistoryRef.current?.flush().catch(() => {}) ?? Promise.resolve()
          void Promise.race([flushed, new Promise((resolve) => setTimeout(resolve, 250))]).then(() => {
            renderer.destroy()
          })
        },
      }),
    [commands, renderer],
  )

  useEffect(() => {
    const disposers = [
      commands.registerCommand({
        id: "workbench.focusExplorer",
        title: "Show Explorer",
        category: "View",
        keybinding: withMacSuper("ctrl+shift+e"),
        run: () => focusView("explorer"),
      }),
      commands.registerCommand({
        id: "workbench.focusScm",
        title: "Show Source Control",
        category: "View",
        keybinding: withMacSuper("ctrl+shift+g"),
        run: () => focusView("scm"),
      }),
      commands.registerCommand({
        id: "workbench.focusSearch",
        title: "Show Search",
        category: "View",
        keybinding: withMacSuper("ctrl+shift+f"),
        run: () => focusView("search"),
      }),
      commands.registerCommand({
        id: "workbench.focusHistory",
        title: "Show History",
        category: "View",
        keybinding: withMacSuper("ctrl+shift+h"),
        run: () => focusView("history"),
      }),
      commands.registerCommand({
        id: "workbench.toggleSidebar",
        title: "Toggle Sidebar Visibility",
        category: "View",
        keybinding: withMacSuper("ctrl+b"),
        run: toggleSidebar,
      }),
      // No default keybinding — mirrors VSCode's own Explorer "Collapse All",
      // which is palette/toolbar-only too. Explorer-specific, so it no-ops
      // harmlessly (nothing is ever expanded) while a different sidebar tab is
      // active, rather than needing a `sidebarView` guard here.
      commands.registerCommand({
        id: "workbench.explorer.collapseAll",
        title: "Explorer: Collapse All Folders",
        category: "View",
        run: () => workbenchStore.collapseAllExplorerPaths(),
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [commands, focusView, toggleSidebar])

  // Developer: Toggle Key Inspector — a palette-only command that flips a
  // keypress logger + the console overlay so a user can see, live, exactly which
  // modifier bits (super/option/…) their terminal+tmux actually delivers. The
  // inspector is stable across renders (ref) so toggle state survives; unmount
  // tears down the subscription so no listener leaks.
  const keyInspectorRef = useRef<KeyInspector | null>(null)
  useEffect(() => {
    const inspector = (keyInspectorRef.current ??= new KeyInspector({
      source: renderer.keyInput,
      // Drive the console overlay from the inspector's OWN state rather than
      // toggling it: toggle() assumes exclusive ownership and would HIDE a
      // console shown some other way. `active` is already the post-transition
      // value when this fires (enable/disable set it before calling back).
      toggleConsole: () =>
        keyInspectorRef.current?.active ? renderer.console.show() : renderer.console.hide(),
    }))
    const dispose = commands.registerCommand({
      id: "developer.toggleKeyInspector",
      title: "Developer: Toggle Key Inspector",
      category: "Developer",
      run: () => inspector.toggle(),
    })
    return () => {
      dispose()
      inspector.disable()
    }
  }, [commands, renderer])

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

  const openDiff = (path: string, kind: "staged" | "unstaged", oldPath?: string) => {
    const repo = activeRepoFor(path, repos)
    if (!repo) return
    workbenchStore.openDiff(path, kind, repo.root, { preview: true, oldPath })
  }

  const sidebarFocused = focusArea === "sidebar"
  const editorFocused = focusArea === "editor"

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.background}>
      <ModalProvider>
        <DirtyCloseWiring />
        <ExplorerContextMenu
          menu={explorerMenu}
          onClose={() => setExplorerMenu(null)}
          onRequestTextDialog={setTextDialog}
        />
        {textDialog && (
          <ExplorerTextDialog
            key={textDialog.title + textDialog.initialValue}
            request={textDialog}
            onClose={() => setTextDialog(null)}
          />
        )}
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
          {/* Collapsed: unmount the sidebar AND its sash entirely (not width 0,
              which would leave a phantom draggable sash and keep panels mounted).
              The status bar's ☰ cell re-expands it. */}
          {!sidebarCollapsed && (
            <>
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
                    <FileTree
                      root={workspaceRoot}
                      focused={sidebarFocused}
                      onOpenFile={openFile}
                      revealRequest={revealRequest}
                      onContextMenuRequest={(target, x, y) => setExplorerMenu({ target, x, y })}
                    />
                  ) : sidebarView === "scm" ? (
                    <ScmPanel
                      workspaceRoot={workspaceRoot}
                      focused={sidebarFocused}
                      onOpenFile={(path) => openFile(path, { preview: true })}
                      onOpenDiff={openDiff}
                    />
                  ) : sidebarView === "search" ? (
                    <SearchPanel workspaceRoot={workspaceRoot} focused={sidebarFocused} />
                  ) : (
                    <CommitLog workspaceRoot={workspaceRoot} focused={sidebarFocused} />
                  )}
                </box>
                <SidebarFooter
                  onCollapse={collapseSidebar}
                  overlayOpen={isOverlayOpen}
                  onCollapseAll={
                    sidebarView === "explorer"
                      ? () => workbenchStore.collapseAllExplorerPaths()
                      : undefined
                  }
                />
              </box>
              <SplitDivider
                kind="sidebar"
                onDelta={handleSidebarDelta}
                onCommit={handleSidebarCommit}
                onReset={handleSidebarReset}
              />
            </>
          )}
          {/* position:relative so the find bar's absolute placement is scoped to
              the editor column (top-right of the editor area, not the whole app). */}
          <box position="relative" flexDirection="column" flexGrow={1} height="100%">
            <EditorGroups
              editorFocused={editorFocused}
              onCursorChange={editorFocused ? setCursor : undefined}
              containerWidth={sidebarCollapsed ? termWidth : Math.max(1, termWidth - sidebarWidth - 1)}
              workspaceRoot={workspaceRoot}
              onSegmentClick={revealInExplorer}
            />
            <FindWidget />
          </box>
        </box>
        <StatusBarWithQuit
          workspaceRoot={workspaceRoot}
          cursor={editorFocused && activeTabIsFile ? cursor : null}
          onToggleSidebar={toggleSidebar}
          overlayOpen={isOverlayOpen}
        />
        <QuickInput workspaceRoot={workspaceRoot} onGotoLine={gotoLine} fileHistory={fileHistory} />
      </ModalProvider>
    </box>
  )
}

type ExplorerContextTarget = { path: string; name: string; isDir: boolean }
type ExplorerMenuState = { target: ExplorerContextTarget; x: number; y: number }

/**
 * A pending Rename / Move / New File / New Folder text-input dialog. `submit`
 * performs the actual filesystem mutation; it MAY throw {@link PathExistsError}
 * to signal the destination is taken, which {@link ExplorerTextDialog} surfaces
 * as an inline error without closing the dialog. `validateName` runs on every
 * keystroke for cheap client-side checks (non-empty); the authoritative
 * existence check happens in `submit`.
 */
type ExplorerTextDialogRequest = {
  title: string
  initialValue: string
  validateName?: (value: string) => string | null
  submit: (value: string) => Promise<void>
}

const requireName = (value: string): string | null =>
  value.trim().length === 0 ? "A name is required." : null

/**
 * Builds the Explorer right-click menu for one row. Delete / Copy Path act
 * immediately; Rename / Move / New File / New Folder (below the divider) open a
 * {@link TextInputDialog} via `openTextDialog`. Every entry is a
 * {@link ContextMenuItem}.
 */
function buildExplorerMenuItems(
  target: ExplorerContextTarget,
  confirm: (options: ConfirmOptions) => Promise<string | null>,
  renderer: Osc52Writer,
  openTextDialog: (request: ExplorerTextDialogRequest) => void,
): ContextMenuItem[] {
  const kind = target.isDir ? "folder" : "file"

  // New File / New Folder create a sibling when the clicked row is a file (VSCode
  // convention: right-clicking a file's "New File" makes a sibling, not a child),
  // and a child when it's a folder.
  const targetDir = target.isDir ? target.path : dirname(target.path)

  const retargetOpenTab = (oldPath: string, newPath: string) => {
    // Always safe to call even when nothing is open for oldPath — both are no-ops
    // then. Keeps an open editor pointed at the same buffer across a rename/move.
    //
    // Registry BEFORE tabs, and this order is load-bearing: retargetTabPath fires
    // a store notification that the document retainer observes synchronously. If
    // the tab moved first, the retainer would see `newPath` as a brand-new open
    // path and openDocument() a FRESH document from disk before the registry
    // retarget ran — clobbering the live (possibly dirty) buffer. Retargeting the
    // registry first means that retainer-triggered openDocument dedups onto the
    // same document instead.
    documentRegistry.retarget(oldPath, newPath)
    workbenchStore.retargetTabPath(oldPath, newPath)
  }

  const deleteTarget = async () => {
    const choice = await confirm({
      message: `Are you sure you want to delete the ${kind} '${target.name}'?`,
      detail: `You can restore this ${kind} from the Trash.`,
      buttons: [
        { id: "confirm", label: "Move to Trash", isDefault: true },
        { id: "cancel", label: "Cancel" },
      ],
    })
    if (choice !== "confirm") return
    try {
      // trash.moveToTrash deletes a folder recursively on its own, so no extra
      // recursion is needed here.
      await trash.moveToTrash([target.path])
    } catch {
      // Non-fatal, mirroring ScmPanel's discard: a trash failure leaves the item
      // in place rather than crashing the render loop. trash.ts never escalates
      // to an irreversible hard-delete, so nothing is lost by not retrying.
      return
    }
    // Close the trashed file's tab (or any tab nested under a trashed folder).
    // The parent directory's row list refreshes on its own through FileTree's
    // per-directory fs.watch — no manual refresh call is needed here.
    workbenchStore.closeTabsForPath(target.path)
  }

  return [
    { id: "delete", label: "Delete", onSelect: () => void deleteTarget() },
    {
      id: "copyPath",
      label: "Copy Path",
      onSelect: () => void clipboard.write(target.path, renderer),
    },
    { id: "sep", label: "", isDivider: true },
    {
      id: "rename",
      label: "Rename",
      // Pre-fills the bare basename to edit in place; the new name is joined back
      // onto the item's own directory.
      onSelect: () =>
        openTextDialog({
          title: "Rename",
          initialValue: target.name,
          validateName: requireName,
          submit: async (value) => {
            const newPath = join(dirname(target.path), value)
            await renamePath(target.path, newPath)
            retargetOpenTab(target.path, newPath)
          },
        }),
    },
    {
      id: "move",
      label: "Move",
      // Pre-fills the item's current directory (trailing slash) for the user to
      // extend into a full destination path — the typed value IS the new path.
      onSelect: () =>
        openTextDialog({
          title: "Move",
          initialValue: `${dirname(target.path)}/`,
          validateName: requireName,
          submit: async (value) => {
            await renamePath(target.path, value)
            retargetOpenTab(target.path, value)
          },
        }),
    },
    {
      id: "newFile",
      label: "New File",
      onSelect: () =>
        openTextDialog({
          title: "New File",
          initialValue: "",
          validateName: requireName,
          submit: async (value) => {
            const newPath = join(targetDir, value)
            await createFile(newPath)
            workbenchStore.expandExplorerPath(targetDir)
            workbenchStore.openFile(newPath, { preview: false })
          },
        }),
    },
    {
      id: "newFolder",
      label: "New Folder",
      onSelect: () =>
        openTextDialog({
          title: "New Folder",
          initialValue: "",
          validateName: requireName,
          submit: async (value) => {
            const newPath = join(targetDir, value)
            await createFolder(newPath)
            // Expand the parent so the new folder is visible, then the new folder
            // itself (empty, but marked open for when the user adds to it).
            workbenchStore.expandExplorerPath(targetDir)
            workbenchStore.expandExplorerPath(newPath)
          },
        }),
    },
  ]
}

/**
 * Hosts the Explorer's right-click context menu at the App root — NOT inside
 * FileTree, whose <scrollbox> would clip an absolutely-positioned popup and
 * whose local coordinate space would break the menu's full-screen backdrop and
 * edge-clamping. Mounted inside ModalProvider so the Delete action's useConfirm
 * resolves against the root modal host.
 */
function ExplorerContextMenu({
  menu,
  onClose,
  onRequestTextDialog,
}: {
  menu: ExplorerMenuState | null
  onClose: () => void
  onRequestTextDialog: (request: ExplorerTextDialogRequest) => void
}) {
  const confirm = useConfirm()
  const renderer = useRenderer()
  if (!menu) return null
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={buildExplorerMenuItems(menu.target, confirm, renderer, onRequestTextDialog)}
      onDismiss={onClose}
    />
  )
}

/**
 * Hosts the Rename / Move / New File / New Folder text-input modal. Bridges the
 * generic {@link TextInputDialog} (whose only error channel is a reactive
 * `validate`) to an authoritative async `submit`: on a {@link PathExistsError}
 * it keeps the dialog open and pins the error to the offending value, so
 * `validate` shows it until the user edits the name; on success (or any other
 * error) it closes. Remounted per open (keyed at the call site), so the pinned
 * error never leaks across dialogs.
 */
function ExplorerTextDialog({
  request,
  onClose,
}: {
  request: ExplorerTextDialogRequest
  onClose: () => void
}) {
  const [submitError, setSubmitError] = useState<{ value: string; message: string } | null>(null)

  const validate = (value: string): string | null => {
    if (submitError && value === submitError.value) return submitError.message
    return request.validateName?.(value) ?? null
  }

  const handleConfirm = (value: string) => {
    void (async () => {
      try {
        await request.submit(value)
        onClose()
      } catch (err) {
        if (err instanceof PathExistsError) {
          setSubmitError({ value, message: err.message })
        } else {
          onClose()
        }
      }
    })()
  }

  return (
    <TextInputDialog
      title={request.title}
      initialValue={request.initialValue}
      validate={validate}
      onConfirm={handleConfirm}
      onCancel={onClose}
    />
  )
}

/**
 * Bridges the store's framework-agnostic dirty-close guard to the root modal
 * host: on mount it registers a handler that raises VSCode's Save / Don't Save /
 * Cancel prompt and maps the chosen button back to the store's choice union.
 * Must render inside ModalProvider so useConfirm resolves.
 */
/**
 * Bridges the status bar's ⏻ button to the root modal host: a click raises a
 * "Quit vsx?" confirmation, and only on confirm does it run workbench.quit —
 * the keyboard chords (ctrl+q / ctrl+alt+q) bypass this entirely and keep
 * quitting immediately. Routes through executeCommand rather than calling
 * renderer.destroy() directly so the command's frecency-flush-before-teardown
 * still runs. Must render inside ModalProvider so useConfirm resolves.
 */
function StatusBarWithQuit(props: Omit<StatusBarProps, "onQuit">) {
  const confirm = useConfirm()
  const commands = useCommands()

  const handleQuit = useCallback(async () => {
    const choice = await confirm({
      message: "Quit vsx?",
      buttons: [
        { id: "quit", label: "Quit", isDefault: true },
        { id: "cancel", label: "Cancel" },
      ],
    })
    if (choice === "quit") commands.executeCommand("workbench.quit")
  }, [confirm, commands])

  return <StatusBar {...props} onQuit={handleQuit} />
}

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
