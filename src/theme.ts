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
