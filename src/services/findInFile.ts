/**
 * Pure in-document find engine: given a buffer's full text and a query, return
 * every match's [start, end) character offset range. Framework-free and
 * synchronous so the widget can recompute on every keystroke and the logic is
 * exhaustively unit-testable. Offsets are into the SAME string the editor buffer
 * exposes (ta.plainText), so they map straight to addHighlightByCharRange.
 */

export type FindOptions = {
  matchCase: boolean
  wholeWord: boolean
  /** Treat the query as a JS regular expression rather than a literal. */
  regex: boolean
}

export type FindMatch = { start: number; end: number }

export type FindResult = {
  matches: FindMatch[]
  /** True when regex mode got an invalid pattern; the widget shows this state. */
  error: boolean
}

/** Escape a literal query so every character matches itself inside a RegExp. */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The regex SOURCE for `query` under the given match options, shared by the
 * in-document find and the workspace search so both agree on every toggle.
 *
 * Whole-word requires a non-word character (or a string edge) on BOTH sides of
 * the match via lookarounds — precisely `git grep -w` / VSCode "Match Whole
 * Word" semantics. This deliberately replaces the old `\b…\b` wrapping, which
 * word-boundary logic breaks whenever the query begins or ends with a non-word
 * character: `\ba\.b\(\b` can never match `a.b(` (there is no boundary between
 * `(` and the following space), yet `git grep -w` finds it. The lookaround form
 * also correctly rejects `foo(` inside `foo(bar)` (a word char follows the
 * match) while accepting `bar)` inside `foo(bar)` — matching git exactly.
 */
export function searchPatternSource(
  query: string,
  opts: { regex?: boolean; wholeWord?: boolean },
): string {
  const body = opts.regex ? query : escapeRegExp(query)
  if (!opts.wholeWord) return body
  return `(?<![A-Za-z0-9_])(?:${body})(?![A-Za-z0-9_])`
}

/**
 * Find all non-overlapping matches of `query` in `text`.
 *
 * - Empty query → no matches (never an error).
 * - Literal mode escapes the query; regex mode uses it verbatim (invalid pattern
 *   → zero matches + `error: true`, never a throw).
 * - `wholeWord` restricts to matches flanked by non-word characters — see
 *   {@link searchPatternSource} for the git/VSCode-parity semantics.
 * - `matchCase: false` (the widget default) adds the `i` flag.
 * - Zero-length matches (e.g. the regex `a*`) are skipped but still advance the
 *   scan so the loop always terminates.
 */
export function findMatches(text: string, query: string, opts: FindOptions): FindResult {
  if (query === "") return { matches: [], error: false }

  const pattern = searchPatternSource(query, opts)
  const flags = opts.matchCase ? "g" : "gi"

  let re: RegExp
  try {
    re = new RegExp(pattern, flags)
  } catch {
    return { matches: [], error: true }
  }

  const matches: FindMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    if (end > start) matches.push({ start, end })
    // A zero-length match leaves lastIndex parked; bump it so exec advances.
    if (re.lastIndex === start) re.lastIndex = start + 1
  }
  return { matches, error: false }
}
