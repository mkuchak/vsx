import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core"

/**
 * vsx theme — a VSCode "Dark+"-inspired palette shared across the whole workbench.
 * Kept as plain hex strings (OpenTUI color props accept hex/CSS-name strings or RGBA).
 */
export const theme = {
  background: "#1e1e1e",
  sidebarBackground: "#252526",
  statusBarBackground: "#007acc",
  statusBarForeground: "#ffffff",
  activityBarBackground: "#333333",

  foreground: "#cccccc",
  dimForeground: "#858585",
  border: "#3c3c3c",

  accent: "#007acc",
  accentForeground: "#ffffff",

  selectionBackground: "#264f78",
  hoverBackground: "#2a2d2e",

  // Editor scrollbars — VSCode keeps the track near-invisible and the thumb a dim
  // translucent gray; approximated here with flat hex tuned to the dark background.
  scrollbarTrack: "#1e1e1e",
  scrollbarThumb: "#424242",

  // Git / SCM status colors (VSCode gitDecoration.* theme colors)
  gitModified: "#e2c08d",
  gitAdded: "#73c991",
  gitUntracked: "#73c991",
  gitDeleted: "#f14c4c",
  gitRenamed: "#73c991",
  gitConflict: "#c74e39",
  gitIgnored: "#8c8c8c",

  // Diagnostics
  error: "#f14c4c",
  warning: "#cca700",
  info: "#3794ff",
  hint: "#8c8c8c",

  // Diff — line backgrounds plus VSCode-style gutter tints, ± sign colors, and
  // a dim line-number foreground for the diff editor's gutter.
  diffAddedBackground: "#373d29",
  diffRemovedBackground: "#4b1818",
  diffAddedGutterBackground: "#2a3418",
  diffRemovedGutterBackground: "#3a1414",
  diffAddedSign: "#73c991",
  diffRemovedSign: "#f14c4c",
  diffLineNumberForeground: "#858585",
} as const

export type Theme = typeof theme

/** Status-letter -> color, matching VSCode's Resource.getStatusColor() mapping. */
export function gitStatusColor(letter: string): string {
  switch (letter) {
    case "M":
    case "T":
      return theme.gitModified
    case "A":
    case "U":
      return theme.gitAdded
    case "D":
      return theme.gitDeleted
    case "R":
    case "C":
      return theme.gitRenamed
    case "!":
      return theme.gitConflict
    case "I":
      return theme.gitIgnored
    default:
      return theme.foreground
  }
}

/**
 * VSCode "Dark+"-ish tree-sitter token colors, shared by every syntax-aware
 * surface (`<code>` preview, editable `<textarea>`, diff `<diff>`). A SyntaxStyle
 * is required even for the unhighlighted fallback, so one shared instance
 * ({@link getSharedSyntaxStyle}) backs them all.
 *
 * Scope names are tree-sitter capture names. EditorPane's resolveStyleId falls
 * back only to a scope's FIRST dot-segment (`"markup.heading.1"` → `"markup"`),
 * so multi-level families (headings, list/link/raw variants) enumerate every
 * emitted name that needs a distinct style rather than relying on a bare root.
 */
export const SYNTAX_THEME: ThemeTokenStyle[] = [
  { scope: ["keyword", "keyword.control", "conditional", "repeat"], style: { foreground: "#c586c0" } },
  { scope: ["string", "string.special"], style: { foreground: "#ce9178" } },
  { scope: ["comment"], style: { foreground: "#6a9955", italic: true } },
  { scope: ["function", "function.call", "function.method"], style: { foreground: "#dcdcaa" } },
  { scope: ["type", "type.builtin", "constructor"], style: { foreground: "#4ec9b0" } },
  { scope: ["number", "constant", "constant.builtin", "boolean"], style: { foreground: "#b5cea8" } },
  { scope: ["variable", "variable.parameter"], style: { foreground: "#9cdcfe" } },
  { scope: ["property"], style: { foreground: "#9cdcfe" } },
  { scope: ["operator", "punctuation", "punctuation.delimiter", "punctuation.bracket"], style: { foreground: "#d4d4d4" } },
  { scope: ["tag"], style: { foreground: "#569cd6" } },
  { scope: ["attribute"], style: { foreground: "#9cdcfe" } },
  // Markdown / HTML markup family (json/yaml/css/html/md grammars). Heading levels
  // are enumerated because the resolveStyleId fallback would otherwise land on the
  // bare "markup" root, which we deliberately do not register.
  {
    scope: [
      "markup.heading",
      "markup.heading.1",
      "markup.heading.2",
      "markup.heading.3",
      "markup.heading.4",
      "markup.heading.5",
      "markup.heading.6",
    ],
    style: { foreground: "#569cd6", bold: true },
  },
  { scope: ["markup.strong"], style: { bold: true } },
  { scope: ["markup.italic"], style: { italic: true } },
  { scope: ["markup.link", "markup.link.url", "markup.link.label"], style: { foreground: "#3794ff", underline: true } },
  { scope: ["markup.raw", "markup.raw.block"], style: { foreground: "#ce9178" } },
  { scope: ["markup.list", "markup.list.checked", "markup.list.unchecked"], style: { foreground: "#6796e6" } },
  { scope: ["markup.quote"], style: { foreground: "#6a9955" } },
  // html emits these two (s/del → strikethrough, u → underline). No terminal
  // strikethrough attribute exists, so dim it — enough to read as de-emphasized
  // without stealing a color from the markup family.
  { scope: ["markup.strikethrough"], style: { dim: true } },
  { scope: ["markup.underline"], style: { underline: true } },
  // Extra Dark+ scopes: TS object members, module/namespace names, yaml anchors
  // (@label), and JSON-style special keys.
  { scope: ["variable.member"], style: { foreground: "#9cdcfe" } },
  { scope: ["module", "namespace"], style: { foreground: "#4ec9b0" } },
  { scope: ["label"], style: { foreground: "#c8c8c8" } },
  { scope: ["string.special.key"], style: { foreground: "#9cdcfe" } },
]

let sharedSyntaxStyle: SyntaxStyle | undefined

/**
 * Lazily create the single process-wide SyntaxStyle from {@link SYNTAX_THEME}.
 * Lazy so the native render lib is initialized by first render before it's built,
 * and shared so the preview, editor, and diff surfaces resolve identical colors.
 */
export function getSharedSyntaxStyle(): SyntaxStyle {
  if (!sharedSyntaxStyle) sharedSyntaxStyle = SyntaxStyle.fromTheme(SYNTAX_THEME)
  return sharedSyntaxStyle
}

let findStyleIds: { match: number; current: number } | undefined

/**
 * Register (once) the two find-in-file highlight styles on the shared SyntaxStyle
 * and return their cached style ids. `find.match` tints every match; `find.current`
 * marks the active one (VSCode's amber). Both carry EXPLICIT fg because overlapping
 * highlights replace the whole cell style — there is no alpha blend — so an implicit
 * fg would let the underlying syntax color show through against the new background.
 */
export function getFindStyleIds(): { match: number; current: number } {
  if (!findStyleIds) {
    const style = getSharedSyntaxStyle()
    findStyleIds = {
      match: style.registerStyle("find.match", { bg: "#613a1a", fg: "#ffffff" }),
      current: style.registerStyle("find.current", { bg: "#f6b73c", fg: "#1e1e1e" }),
    }
  }
  return findStyleIds
}
