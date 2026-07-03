import { describe, expect, test } from "bun:test"
import { findMatches, type FindOptions } from "./findInFile"

const OPTS = (o: Partial<FindOptions> = {}): FindOptions => ({
  matchCase: false,
  wholeWord: false,
  regex: false,
  ...o,
})

/** Convenience: the substrings the returned ranges cover, for readable assertions. */
function slices(text: string, query: string, o: Partial<FindOptions> = {}): string[] {
  return findMatches(text, query, OPTS(o)).matches.map((m) => text.slice(m.start, m.end))
}

describe("findMatches", () => {
  test("empty query yields no matches and no error", () => {
    const res = findMatches("anything at all", "", OPTS())
    expect(res.matches).toEqual([])
    expect(res.error).toBe(false)
  })

  test("literal matches return exact [start,end) offsets", () => {
    const text = "foo bar foo"
    const res = findMatches(text, "foo", OPTS())
    expect(res.matches).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ])
    expect(res.error).toBe(false)
  })

  test("literal mode escapes regex metacharacters", () => {
    // The dot is a literal dot, not "any char": "a.b" must not match "axb".
    expect(slices("a.b axb a.b", "a.b")).toEqual(["a.b", "a.b"])
    expect(slices("cost is $5 and $5", "$5")).toEqual(["$5", "$5"])
    expect(slices("(x) (y)", "(x)")).toEqual(["(x)"])
  })

  test("case-insensitive by default; matchCase restricts", () => {
    expect(slices("Foo foo FOO", "foo")).toEqual(["Foo", "foo", "FOO"])
    expect(slices("Foo foo FOO", "foo", { matchCase: true })).toEqual(["foo"])
  })

  test("whole word only matches at word boundaries", () => {
    const text = "cat category scattered cat"
    expect(slices(text, "cat", { wholeWord: true })).toEqual(["cat", "cat"])
    // Without whole-word, the substrings inside category/scattered match too.
    expect(slices(text, "cat").length).toBe(4)
  })

  test("whole word requires non-word flanks, so punctuation-edged queries still match", () => {
    // A query ending in punctuation (git grep -w / VSCode find both match these);
    // the old `\b…\b` wrapping wrongly dropped them (no boundary after `(`).
    expect(slices("call a.b( literal", "a.b(", { wholeWord: true })).toEqual(["a.b("])
    // Fully-punctuation queries behave like a plain substring under whole-word.
    expect(slices("x -> y", "->", { wholeWord: true })).toEqual(["->"])
    expect(slices("if a == b", "==", { wholeWord: true })).toEqual(["=="])
  })

  test("whole word rejects a match immediately followed by a word char", () => {
    // `foo(` is NOT a whole word in `foo(bar)` — a word char (`b`) follows the
    // match — but `bar)` IS (flanked by `(` and space). Mirrors git grep -w.
    expect(slices("foo(bar) call", "foo(", { wholeWord: true })).toEqual([])
    expect(slices("foo(bar) call", "bar)", { wholeWord: true })).toEqual(["bar)"])
  })

  test("regex mode honors the pattern", () => {
    const text = "a1 b22 c333"
    expect(slices(text, "\\d+", { regex: true })).toEqual(["1", "22", "333"])
    expect(slices(text, "[a-c]\\d+", { regex: true })).toEqual(["a1", "b22", "c333"])
  })

  test("regex mode combines with whole word and case flags", () => {
    expect(slices("Err error ERR", "err", { regex: true, matchCase: false })).toEqual([
      "Err",
      "err",
      "ERR",
    ])
    // \bfoo?\b matches "fo" and "foo" as whole words only.
    expect(slices("fo foo food", "fo(o)?", { regex: true, wholeWord: true })).toEqual(["fo", "foo"])
  })

  test("invalid regex reports an error and zero matches, never throws", () => {
    const res = findMatches("some text", "(", OPTS({ regex: true }))
    expect(res.matches).toEqual([])
    expect(res.error).toBe(true)
  })

  test("an invalid pattern in LITERAL mode is just literal text (no error)", () => {
    // "(" as a literal must find the paren, not be treated as a broken group.
    const res = findMatches("a ( b", "(", OPTS())
    expect(res.error).toBe(false)
    expect(res.matches).toEqual([{ start: 2, end: 3 }])
  })

  test("zero-length regex matches are skipped but the scan still terminates", () => {
    // `a*` matches empty strings everywhere; only the non-empty runs are kept.
    const res = findMatches("baaab", "a*", OPTS({ regex: true }))
    expect(res.matches).toEqual([{ start: 1, end: 4 }])
    expect(res.error).toBe(false)
  })

  test("adjacent (touching) matches are all found without overlap", () => {
    // Non-overlapping semantics: "aa" in "aaaa" → two matches, not three.
    expect(findMatches("aaaa", "aa", OPTS()).matches).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })

  test("offsets are correct across newlines (multiline text)", () => {
    const text = "line one\nline two\nline three"
    const res = findMatches(text, "line", OPTS())
    expect(res.matches).toEqual([
      { start: 0, end: 4 },
      { start: 9, end: 13 },
      { start: 18, end: 22 },
    ])
    // The reported ranges slice back to the literal query.
    expect(res.matches.map((m) => text.slice(m.start, m.end))).toEqual(["line", "line", "line"])
  })

  test("a regex anchored to line ends works under the default (non-multiline) flags", () => {
    // Without the `m` flag, `$` matches only the very end — documents current behavior.
    expect(slices("ab\nab", "ab$", { regex: true })).toEqual(["ab"])
  })

  test("no matches for an absent query is empty, not an error", () => {
    const res = findMatches("hello world", "xyz", OPTS())
    expect(res.matches).toEqual([])
    expect(res.error).toBe(false)
  })
})
