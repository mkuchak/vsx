# vsx

A VSCode-like code editor for the terminal, built on [OpenTUI](https://github.com/anomalyco/opentui) (Bun + `@opentui/react`).

File explorer, tabs, an editable buffer with live syntax highlighting, a VSCode-style Source Control panel (stage/unstage/discard/commit), before/after diffs, a linear commit log, `Ctrl+P` fuzzy file finder doubling as a command palette, and side-by-side split editing.

## Install & run

```bash
bun install
bun run start      # or: bun run dev (watch mode)
```

Open any folder as the workspace (like VSCode's `code <dir>`) by passing a directory; with no argument it opens the current directory:

```bash
bun run start ../some/project   # or: bun dev ../some/project
```

Install a global `vsx` command with `bun link`, then use it anywhere:

```bash
bun link            # exposes `vsx` on your PATH
vsx ../some/project # open a folder
vsx                 # open the current directory
```

Requires Bun (the reference runtime for OpenTUI). Node 26.3+ can run the non-renderer parts, but the renderer itself needs Bun's native bindings.

```bash
bun test           # run the test suite
bun run typecheck  # tsc --noEmit
```

## Keybindings

| Key | Action |
|---|---|
| `Ctrl+Q` | Quit |
| `Ctrl+P` | Quick Open — fuzzy file finder |
| `Ctrl+Shift+P` / `F1` | Command Palette (Quick Open seeded with `>`) |
| `:` inside Quick Open | Go to line (`:42` or `:42:10`) |
| `Ctrl+Shift+E` | Show Explorer (file tree) |
| `Ctrl+Shift+G` | Show Source Control |
| `Ctrl+Shift+H` | Show History (commit log) |
| `Esc` (in sidebar) | Focus the editor |
| `Ctrl+S` | Save the active file |
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / Cut / Paste |
| `Shift+Arrow`, `Ctrl+Arrow`, etc. | Selection and word-wise movement (built into OpenTUI's textarea) |
| `Ctrl+W` | Close the active tab |
| `Ctrl+PageUp` / `Ctrl+PageDown` | Previous / next tab (positional) |
| `Ctrl+\` | Split the editor into another pane (bounded by a 20-cell minimum pane width) |
| `Ctrl+1` … `Ctrl+9` | Focus editor group 1–9 (the focused pane shows an accent border) |
| `Ctrl+Enter` (in the SCM commit box) | Commit |

Within the Source Control panel: `↑`/`↓` navigate, `Enter` opens the file, `Space`/`+` stages, `-` unstages, `x` discards (with a confirmation dialog), `o` opens a diff, `i`/`Tab` focuses the commit message box.

Within a diff tab: `v` toggles split/unified view, `n`/`p` jump to the next/previous hunk.

## Mouse & selection

- **Click** positions the cursor in the editor; **double-click** selects a word; **triple-click** selects a line.
- **Copy-on-select**: any mouse selection — in the editor, diff view, commit log, or the too-large-file preview — is copied to the clipboard the moment the drag ends. `Ctrl+C` also copies the current selection explicitly as a fallback.
- **Drag a divider** to resize the sidebar or a split pane; **double-click a divider** to reset it to its default size.
- The sidebar's **activity tabs** (Explorer / SCM / Commits) are clickable with the mouse, mirroring the `Ctrl+Shift+E`/`G`/`H` keybindings.
- **Click a pane** (or press `Ctrl+1`…`Ctrl+9`) to focus an editor group; the focused pane shows an accent border.

## Editor behavior

- **Splits** grow as far as the editor area allows — a new pane is admitted only while every pane stays at or above a 20-cell minimum width, so there is no fixed group cap.
- **`Ctrl+S` saves the focused file**, even in a split showing several different files.
- **Go to line** from Quick Open: type `:42` (or `:42:10`) to jump the cursor to that line/column and scroll it into view.
- The status bar's **Ln/Col updates live** on every cursor move — arrows, page, home/end, undo/redo, and go-to-line — and is hidden (not left stale) while a diff tab is active.
- **Overlays are mutually exclusive**: while any overlay (Quick Open, command palette, confirm dialog) is open, command keybindings are gated, so closing a dialog can't double-fire a command.

## Terminal support

Most of the above works in any terminal via legacy xterm escape sequences — Shift/Ctrl+Arrow selection and word-wise movement are universally supported. **`Ctrl+Shift+<letter>` chords** (Command Palette, Show Source Control, Show History) need a terminal that implements the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) to disambiguate them from plain `Ctrl+<letter>`. This includes Ghostty, kitty, WezTerm, Alacritty, iTerm2 (recent versions), and VSCode's own integrated terminal.

On a non-Kitty terminal (notably **macOS Terminal.app**), those specific chords won't register — use `F1` (always works) for the command palette, and the equivalent commands are still reachable through the palette itself.

## Known limitations

- **No multi-cursor, LSP, or IME/CJK input composition.**
- **Files over 5MB** open in a truncated, read-only plain-text preview rather than the full editor.
- **Syntax-highlight grammars are bundled offline only for TypeScript/JavaScript (incl. TSX/JSX) and Markdown.** Other file types are still detected but render without highlighting unless their grammar is available.
- **Editable-buffer syntax highlighting** re-parses the whole buffer on a 160ms debounce (`TreeSitterClient.highlightOnce`), not an incremental re-parse — fine at normal file sizes, may lag on very large files.
- **Commit log is linear** (no graph/rail rendering) — a deliberate MVP scope cut; VSCode-style branch graphs are a well-known, multi-week yak-shave (see gitui/lazygit's own histories).
- **A diff tab opened *before* its file is open in an editor won't reflect that editor's later unsaved edits** — the live-Document subscription only attaches if the Document already exists when the diff opens. Edits to an already-open file, and external `git` changes, are reflected via the shared watcher.
- **The SCM commit message box doesn't regain focus after an overlay closes** — overlay-close focus restore targets the editor, so click/`i`/`Tab` back into the box.
- **A very fast mouse flick can miss the 1-cell divider** on the arming mousedown, so the resize gesture won't start — land on the sash a little more deliberately.

## Architecture

- `src/model/` — framework-agnostic state: `documents.ts` (one shared `Document` per file path, refcounted, VSCode's core model idea) and `workbench.ts` (editor groups/tabs, including diff and commit-diff tab kinds).
- `src/services/` — `git.ts` (a queued `git` process wrapper matching VSCode's exact command lines), `repos.ts` (repo discovery + worktree-aware watching), `workspace.ts` (file listing/watching), `fuzzy.ts` (VSCode-style fuzzy scorer), `commands.ts` (the command registry over `@opentui/keymap`), `clipboard.ts`, `trash.ts`.
- `src/ui/` — the panels: `FileTree`, `ScmPanel`, `CommitLog`, `EditorPane`, `DiffPane`, `EditorGroups`, `TabBar`, `SidebarTabs`, `SplitDivider`, `QuickInput`, `ConfirmDialog`, `StatusBar`.
- `src/workbench/App.tsx` — final assembly: sidebar (switchable Explorer/Source Control/History) + editor groups + status bar + the Quick Open overlay.
