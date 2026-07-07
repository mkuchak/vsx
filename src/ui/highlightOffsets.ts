/**
 * OpenTUI's `EditBuffer.addHighlightByCharRange` interprets `start`/`end` as
 * display-width columns that EXCLUDE newlines, flat across the whole document —
 * a different space from the JS string (UTF-16) offsets that
 * `TreeSitterClient.highlightOnce` and the in-document find engine
 * (`findInFile.ts`) both return. Pushing those offsets straight into the
 * highlight API drifts every span right by one column per preceding line.
 *
 * This converts JS offsets into that native space in a single linear scan of
 * the buffer text, so every `addHighlightByCharRange` call site can share one
 * conversion instead of re-deriving it.
 */

/**
 * Builds a converter from JS string (UTF-16) offsets to OpenTUI's native
 * highlight offset space, for one snapshot of `text`. Iterates by code point
 * (not UTF-16 unit) so astral characters (surrogate pairs) map correctly;
 * newlines contribute zero width and don't advance the native offset. Out-of-
 * range offsets (e.g. a stale span after an edit) clamp to the buffer bounds.
 */
export function createNativeOffsetConverter(text: string): (jsOffset: number) => number {
  const nativeAt = new Array<number>(text.length + 1)
  let native = 0
  let i = 0
  while (i < text.length) {
    nativeAt[i] = native
    const codePoint = text.codePointAt(i)
    const charLen = codePoint !== undefined && codePoint > 0xffff ? 2 : 1
    if (charLen === 2) nativeAt[i + 1] = native
    const ch = text.slice(i, i + charLen)
    if (ch !== "\n") native += Bun.stringWidth(ch)
    i += charLen
  }
  nativeAt[text.length] = native

  return (jsOffset: number) => {
    const clamped = Math.max(0, Math.min(jsOffset, text.length))
    return nativeAt[clamped]
  }
}
