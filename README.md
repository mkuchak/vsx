# vsx

A VSCode-like code editor for the terminal, built on [OpenTUI](https://github.com/anomalyco/opentui) (Bun + `@opentui/react`).

File explorer, tabs, an editable buffer with live syntax highlighting, a VSCode-style Source Control panel (stage/unstage/discard/commit) with a collapsible directory tree, before/after diffs, a linear commit log with per-commit details, find-in-file (`Ctrl+F`) and workspace text search (`Ctrl+Shift+F`), `Ctrl+P` fuzzy file finder doubling as a command palette, and side-by-side split editing.

## Install & run

```bash
bun install
bun run start      # or: bun run dev (watch mode)
```

Open any folder as the workspace (like VSCode's `code <dir>`) by passing a directory; with no argument it opens the current directory:

```bash
bun run start ../some/project   # or: bun dev ../some/project
```

You can also pass a **file** (like `code <file>`): it opens on boot in a permanent tab with its parent directory as the workspace root. A nonexistent path exits with an error.

Install a global `vsx` command with `bun link`, then use it anywhere:

```bash
bun link                 # exposes `vsx` on your PATH
vsx ../some/project      # open a folder as the workspace
vsx ../some/file.ts      # open a file (its parent dir becomes the workspace)
vsx                      # open the current directory
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
| `Ctrl+Shift+F` | Show Search (workspace text search) |
| `Ctrl+Shift+H` | Show History (commit log) |
| `Ctrl+B` | Toggle the sidebar (collapse / expand) |
| `Esc` (in sidebar) | Focus the editor |
| `Ctrl+F` | Find in the active editor (match-case / whole-word / regex toggles) |
| `Ctrl+S` | Save the active file |
| `Ctrl+A` / `Ctrl+E` | Move to the start / end of the current (visual) line — also what a macOS terminal's `Cmd+Left` / `Cmd+Right` translate to |
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / Cut / Paste |
| `Alt+Up` / `Alt+Down` | Move the current line (or the whole selected block) up / down — one undo step |
| `Alt+Z` | Toggle word wrap for every editor pane (on by default) |
| `Shift+Arrow`, `Ctrl+Arrow`, etc. | Selection and word-wise movement (built into OpenTUI's textarea) |
| `Home` / `End` | Jump to the top / bottom of the document (OpenTUI textarea default; `Shift` extends the selection there) |
| `Ctrl+W` | Close the active tab |
| `Ctrl+PageUp` / `Ctrl+PageDown` | Previous / next tab (positional) |
| `Ctrl+\` | Split the editor into another pane (bounded by a 20-cell minimum pane width) |
| `Ctrl+1` … `Ctrl+9` | Focus editor group 1–9 (the focused pane shows an accent border) |
| `Ctrl+Enter` (in the SCM commit box) | Commit |

On macOS, the **`Cmd` equivalents** of the sidebar/file chords are also registered, so `Cmd+P`, `Cmd+Shift+P`, `Cmd+Shift+E`/`G`/`F`/`H`, `Cmd+B`, `Cmd+S`, `Cmd+W`, `Cmd+\`, `Cmd+F`, and `Cmd+Enter` (SCM commit) work wherever the terminal delivers the `super` modifier. The editor's own `Cmd` shortcuts (`Cmd+Z`/`Cmd+Shift+Z`, `Cmd+A`, `Cmd+↑`/`↓`/`←`/`→`) are OpenTUI textarea built-ins. All of these depend on the terminal forwarding `Cmd` under the Kitty keyboard protocol — see [macOS keys](#macos-keys).

Within the Source Control panel (a collapsible directory tree grouped into Merge / Staged / Changes / Untracked): `↑`/`↓` navigate, `←`/`→` collapse/expand a directory (`Enter` on a directory toggles it, on a file opens it), `Space`/`+` stages, `-` unstages, `x` discards (with a confirmation dialog), `o` opens a diff, `i`/`Tab` focuses the commit message box. The **selected** row (and group header) also shows inline stage (`+`), unstage (`−`), and discard (`↶`) buttons you can click, acting on that file or the whole subtree/group.

Within the History (Commits) panel: `↑`/`↓` navigate, `Enter` expands a commit's changed files (or opens a file's commit diff), and `i` opens a commit-details overlay (full message, author, and per-file stats).

Within a diff tab: `v` toggles split/unified view, `n`/`p` jump to the next/previous change block.

## Mouse & selection

- **Click** positions the cursor in the editor; **double-click** selects a word; **triple-click** selects a line.
- **Selection never auto-copies.** Make a selection with the mouse (or keyboard), then press **`Ctrl+C`** to copy it. This works in the editor *and* in the read-only surfaces — the diff view, commit log, Source Control panel, and the too-large-file preview — via a renderer-level selection fallback (`Ctrl+X`/`Ctrl+V` stay editor-only). A plain **`Shift+click`** extends the selection exactly; **`Shift+drag`** is terminal-dependent — in terminals that forward shift+mouse to the app, the renderer's char-wise drag gesture takes over and the anchor migrates (see [Known limitations](#known-limitations)), while tmux/terminal setups that intercept `Shift+drag` first hand the selection off natively, outside the app.
- **Drag a divider** to resize the sidebar or a split pane; **double-click a divider** to reset it to its default size.
- The sidebar's **activity tabs** (Explorer / SCM / Search / Commits) are clickable with the mouse, mirroring the `Ctrl+Shift+E`/`G`/`F`/`H` keybindings.
- **Click a pane** (or press `Ctrl+1`…`Ctrl+9`) to focus an editor group; the focused pane shows an accent border.

## Editor behavior

- **Splits** grow as far as the editor area allows — a new pane is admitted only while every pane stays at or above a 20-cell minimum width, so there is no fixed group cap.
- **`Ctrl+S` saves the focused file**, even in a split showing several different files.
- **Sidebar toggle**: `Ctrl+B` collapses/expands the sidebar. You can also click the `◂ Hide Sidebar` footer row inside the sidebar to collapse it, and the always-visible `☰` cell at the left of the status bar to bring it back.
- **Word wrap**: enabled by default (matching VSCode's default); `Alt+Z` toggles wrapping for every editor pane at once. A thin scrollbar tracks the buffer — vertical is always present; the horizontal one appears only while wrap is *off* (with wrap on there's nothing to scroll horizontally). Both bars are draggable.
- **Move lines**: `Alt+Up`/`Alt+Down` shifts the caret's line — or the entire selected block of lines — up or down. The whole move is a single undo point, so one `Ctrl+Z` reverts it. (macOS needs Option forwarded as Alt — see [macOS keys](#macos-keys).)
- **Full-file diff**: a diff tab shows the *entire* file with additions/deletions highlighted in place (VSCode-style), not just the changed hunks in isolation. `n`/`p` jump between change blocks; `v` toggles split/unified. Files longer than 5000 lines fall back to a standard 3-line-context view (jumping straight to each hunk) to stay responsive.
- **Find in file** (`Ctrl+F`): a small bar opens at the top-right of the editor with match-case, whole-word, and regex toggles and an `N of M` counter. It highlights every match (the current one distinctly), seeds itself from a non-empty single-line selection, and cycles matches with `Enter`/`Shift+Enter` (or `↑`/`↓`). `Esc` closes it and lands the caret on the current match. (`Shift+Enter` reliably steps backward only where the terminal forwards Shift under the Kitty protocol; `↑` always does — see [macOS keys](#macos-keys). On a diff tab, which has no editable buffer, `Ctrl+F` is a no-op.)
- **Workspace search** (`Ctrl+Shift+F`): a sidebar view with the same match-case/whole-word/regex toggles. Type a query and press `Enter` to search (it runs on Enter, not per keystroke); results are grouped by file (collapsible) with match-line previews, a "X results in Y files" summary, and per-file counts. `↓` (or `Tab`) moves from the input into the results list; `Enter` on a match opens the file at that line/column. Inside a git repo it uses `git grep` (honoring `.gitignore` and including untracked-not-ignored files, matching VSCode); outside git it falls back to a Bun scan over the workspace. Results are capped (20,000 matches, VSCode's default) with a "results truncated" row when the cap clips output.
- **Go to line** from Quick Open: type `:42` (or `:42:10`) to jump the cursor to that line/column and scroll it into view.
- **Open a file by path** from Quick Open (`Ctrl+P`): start the query with `/` (absolute) or `~` (home) to browse the filesystem. The parent directory is listed live and filtered as you type; `Enter` on a directory (shown with a trailing `/`) descends into it, and `Enter` on a file opens it. Files outside the workspace open fine, but they aren't covered by the workspace watcher or Source Control (no live external-reload / SCM integration).
- The status bar's **Ln/Col updates live** on every cursor move — arrows, page, home/end, undo/redo, and go-to-line — and is hidden (not left stale) while a diff tab is active.
- **Overlays are mutually exclusive**: while any overlay (Quick Open, command palette, confirm dialog) is open, command keybindings are gated, so closing a dialog can't double-fire a command.

## Terminal support

Most of the above works in any terminal via legacy xterm escape sequences — Shift/Ctrl+Arrow selection and word-wise movement are universally supported. **`Ctrl+Shift+<letter>` chords** (Command Palette, Show Source Control, Show Search, Show History) need a terminal that implements the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) to disambiguate them from plain `Ctrl+<letter>`. This includes Ghostty, kitty, WezTerm, Alacritty, iTerm2 (recent versions), and VSCode's own integrated terminal.

On a non-Kitty terminal (notably **macOS Terminal.app**), those specific chords won't register — use `F1` (always works) for the command palette, and the equivalent commands are still reachable through the palette itself.

## macOS keys

macOS folds a lot of editing onto `Cmd` and `Option`, and terminals sit between those keys and the app. This section is the practical setup guide.

### Why `Cmd` keys often do nothing

vsx binds two kinds of `Cmd` shortcuts:

- **App commands** — the sidebar/file chords are dual-registered with a `super` (`Cmd`) twin alongside their `Ctrl` form: `Cmd+P`, `Cmd+Shift+P`, `Cmd+Shift+E`/`G`/`F`/`H`, `Cmd+B`, `Cmd+S`, `Cmd+W`, `Cmd+\`, `Cmd+F`, and `Cmd+Enter` (SCM commit).
- **Editor textarea built-ins** (from OpenTUI, not custom code):

  | Chord | Action |
  |---|---|
  | `Cmd+Up` / `Cmd+Down` | Document top / bottom |
  | `Cmd+Shift+Up` / `Cmd+Shift+Down` | Select to document top / bottom |
  | `Cmd+Left` / `Cmd+Right` | Line start / end (visual) |
  | `Cmd+A` | Select all |
  | `Cmd+Z` / `Cmd+Shift+Z` | Undo / Redo |

Both kinds only fire when the terminal actually **delivers the `super` modifier**, which happens only under the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/). Most macOS terminals consume `Cmd` combos themselves by default (they drive the app menu), so out of the box the app never sees them. The exception is `Cmd+Left`/`Cmd+Right`: most macOS terminals translate them into the legacy control bytes `0x01`/`0x05` (identical to `Ctrl+A`/`Ctrl+E`), and vsx binds those to visual-line start/end — so `Cmd+Left`/`Cmd+Right` do the right thing out of the box, no config needed (see the **`Cmd+Left` / `Cmd+Right`** note below).

### Ghostty setup (recommended)

```
# ~/.config/ghostty/config
macos-option-as-alt = true
keybind = cmd+up=unbind
keybind = cmd+down=unbind
```

`macos-option-as-alt` makes `Option` a first-class `Alt` (fixes `opt+z` composing the character "Ω" and enables `Alt+Up`/`Alt+Down` move-line). The `cmd+up`/`cmd+down` unbinds stop Ghostty from binding those arrow combos itself, so they forward to the app as `super` (document top/bottom) — unbind any other `Cmd` chord you want forwarded the same way. `Cmd+Left`/`Cmd+Right` need no unbind: they already translate to the control bytes vsx maps to visual-line start/end.

### tmux is usually the bottleneck

Even with a Kitty-capable terminal, tmux strips the protocol unless extended keys are on. Needs tmux ≥ 3.2:

```
# ~/.tmux.conf
set -s extended-keys on
set -as terminal-features 'xterm-ghostty:extkeys'   # match your $TERM (e.g. xterm-kitty:extkeys)
```

### Verify what your terminal delivers

Run **"Developer: Toggle Key Inspector"** from the command palette (`Ctrl+Shift+P` / `F1`), then press a chord. The inspector logs the modifiers the app actually received — if you see `super: true` for a `Cmd` chord, it's being forwarded and the binding will work.

### `Option` as Alt (other terminals)

The `Alt+Z` (word wrap) and `Alt+Up`/`Alt+Down` (move line) bindings need Option delivered as Alt:

- **Ghostty** — `macos-option-as-alt = true`
- **kitty** — `macos_option_as_alt yes`
- **iTerm2** — Profiles → Keys → **Left Option key: Esc+**
- **Alacritty** — `option_as_alt = "OnlyLeft"` (or `"Both"`)
- **WezTerm** — the left Option key is Alt by default

**`Alt+Z` still works without this** — vsx aliases the composed "Ω" character (what `opt+z` types on a US layout without option-as-alt) straight to the word-wrap toggle. Set option-as-alt anyway so `Alt+Up`/`Alt+Down` move-line works too.

### Per-terminal `Cmd` forwarding

- **kitty** — unmap the combo so it's forwarded as `super`, e.g. `map cmd+up` (an empty action) in `kitty.conf`.
- **Ghostty** — see the config above; forward extra encodings with `keybind = <chord>=unbind`.
- **iTerm2** — speaks the Kitty protocol, but `Cmd` combos need a per-key **Send Escape Sequence** mapping in the profile (Profiles → Keys).
- **WezTerm** — a known issue means `Cmd` combos aren't passed through even with `enable_kitty_keyboard = true` ([wezterm#4589](https://github.com/wez/wezterm/issues/4589)); use `SendKey` remaps as a workaround.
- **Alacritty** — no Kitty-keyboard support at all; only manual per-combo byte bindings in `alacritty.toml`.
- **Terminal.app** — no Kitty protocol (see [Terminal support](#terminal-support) above); `Cmd` combos won't forward. Fall back to `Home`/`End` (document top/bottom) and `Ctrl+A`/`Ctrl+E` (visual-line start/end).

### `Cmd+Left` / `Cmd+Right`

macOS terminals translate `Cmd+Left`/`Cmd+Right` into the control bytes `0x01`/`0x05` — byte-identical to `Ctrl+A`/`Ctrl+E`, which the app can't tell apart without the Kitty protocol. vsx therefore binds `Ctrl+A`/`Ctrl+E` to **visual-line start/end** (the current wrapped row's start/end, staying put on repeat, VSCode's Home/End-under-wrap), so the translated `Cmd+Left`/`Cmd+Right` move correctly out of the box — no config required.

**Select-all is `Cmd+A`, not `Ctrl+A`.** Because `Ctrl+A` is the visual-line-home navigation above, select-all lives only on the built-in `super+a` (`Cmd+A`), which fires once the terminal forwards `super` — i.e. with the Ghostty/tmux Kitty-protocol config in this section (`macos-option-as-alt`, tmux `extended-keys`).

### Paste and copy

`Cmd+V` works everywhere already — the terminal turns it into a bracketed paste and the editor's built-in paste handling inserts it (no keybinding involved). `Cmd+C` is generally swallowed by the terminal; use **`Ctrl+C`** as the reliable copy chord (it copies the current selection in the editor and in the read-only panes). Clipboard writes go through `pbcopy` locally, so copying works regardless of your OSC 52 setup.

## Known limitations

- **No multi-cursor, LSP, or IME/CJK input composition.**
- **Files over 5MB** open in a truncated, read-only plain-text preview rather than the full editor.
- **Syntax-highlight grammars are bundled offline for TypeScript/JavaScript (incl. TSX/JSX), Markdown, JSON, YAML, CSS, HTML, and TOML** (Markdown now styles headings, emphasis, links, and code spans too). Other file types are still detected but render without highlighting unless their grammar is available.
- **Editable-buffer syntax highlighting** re-parses the whole buffer on a 160ms debounce (`TreeSitterClient.highlightOnce`), not an incremental re-parse — fine at normal file sizes, may lag on very large files.
- **Commit log is linear** (no graph/rail rendering) — a deliberate MVP scope cut; VSCode-style branch graphs are a well-known, multi-week yak-shave (see gitui/lazygit's own histories).
- **The diff view highlights whole changed lines, not word-level intra-line differences, and doesn't render shaded filler rows** on the shorter side of a split-view change. OpenTUI's `<diff>` component exposes no hook for either; a word-level/filler renderer would need a custom split view (deliberately deferred).
- **A diff tab opened *before* its file is open in an editor won't reflect that editor's later unsaved edits** — the live-Document subscription only attaches if the Document already exists when the diff opens. Edits to an already-open file, and external `git` changes, are reflected via the shared watcher.
- **The SCM commit message box doesn't regain focus after an overlay closes** — overlay-close focus restore targets the editor, so click/`i`/`Tab` back into the box.
- **A very fast mouse flick can miss the 1-cell divider** on the arming mousedown, so the resize gesture won't start — land on the sash a little more deliberately.
- **Shift+drag** (as opposed to a plain shift+click, which extends the selection exactly) is taken over by the renderer's character-wise drag gesture anchored at the click point, so the original anchor migrates once you start dragging with Shift held.

## Troubleshooting

- **An untracked file isn't showing in Source Control.** Like VSCode, vsx hides git-ignored files, so anything matched by a `.gitignore` rule won't appear under Untracked Changes. Check whether a file is ignored with `git check-ignore -v <file>` — it prints the matching rule (and its source) when the file is ignored, and nothing when it isn't. Nested untracked files inside a new directory *do* show (vsx runs `git status -uall`, not the default `-unormal` that collapses them to the directory).

## Architecture

- `src/model/` — framework-agnostic state: `documents.ts` (one shared `Document` per file path, refcounted, VSCode's core model idea) and `workbench.ts` (editor groups/tabs, including diff and commit-diff tab kinds).
- `src/services/` — `git.ts` (a queued `git` process wrapper matching VSCode's exact command lines), `repos.ts` (repo discovery + worktree-aware watching), `workspace.ts` (file listing/watching), `search.ts` (workspace text search — `git grep` per repo, Bun-scan fallback), `findInFile.ts` (the pure in-buffer match engine), `fuzzy.ts` (VSCode-style fuzzy scorer), `commands.ts` (the command registry over `@opentui/keymap`), `keyInspector.ts`, `clipboard.ts`, `trash.ts`.
- `src/grammars.ts` — registers the vendored tree-sitter grammars (JSON/YAML/CSS/HTML/TOML) bundled under `assets/grammars/`; `src/theme.ts` centralizes the shared Dark+ syntax theme.
- `src/ui/` — the panels: `FileTree`, `ScmPanel`, `CommitLog`, `SearchPanel`, `EditorPane`, `DiffPane`, `EditorGroups`, `FindWidget`, `TabBar`, `SidebarTabs`, `SplitDivider`, `QuickInput`, `ConfirmDialog`, `StatusBar`.
- `src/workbench/App.tsx` — final assembly: sidebar (switchable Explorer/Source Control/Search/History) + editor groups + status bar + the Quick Open and find-in-file overlays.
