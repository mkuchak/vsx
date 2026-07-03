import { join } from "node:path"
import { stat } from "node:fs/promises"
import { searchPatternSource } from "./findInFile"
import { type GrepOptions } from "./git"
import { discoverRepositories, type RepoInfo } from "./repos"
import { enumerateFiles } from "./workspace"

export type SearchMatch = {
  line: number
  /** 1-based UTF-16 char column of the first match on the line. */
  col: number
  /** Length of the matched text in UTF-16 code units, for highlighting the span. */
  length: number
  preview: string
}

export type SearchFileResult = {
  /** Absolute path, so callers can open it via the document registry. */
  path: string
  matches: SearchMatch[]
}

export type SearchResult = {
  files: SearchFileResult[]
  /** True when maxResults or the file-enumeration cap clipped the results. */
  truncated: boolean
}

export type SearchOptions = GrepOptions & {
  /** Total match cap across the whole workspace (default 20_000, VSCode's). */
  maxResults?: number
  /** Cooperative cancellation: checked between files/repos, never rejects. */
  signal?: { cancelled: boolean }
}

const DEFAULT_MAX_RESULTS = 20_000
/** Files larger than this are skipped by the Bun scan (VSCode-ish budget). */
const MAX_FILE_BYTES = 1024 * 1024
/** Bytes sniffed for a NUL to classify a file as binary. */
const SNIFF_BYTES = 8192

/**
 * VSCode-style workspace text search, backend only. Inside git repo(s) it runs
 * `git grep` per repo (respecting .gitignore, including untracked files); for a
 * non-git root it falls back to a pure-Bun scan over ignore-filtered files.
 * Case-INSENSITIVE by default (matchCase is the toggle). Results carry ABSOLUTE
 * paths. `truncated` reports whether the match cap (or file cap) clipped output.
 */
export async function searchWorkspace(
  root: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  if (query === "") return { files: [], truncated: false }
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS

  const repos = await discoverRepositories(root)
  if (repos.length > 0) return searchWithGit(repos, query, opts, maxResults)
  return searchWithBun(root, query, opts, maxResults)
}

async function searchWithGit(
  repos: RepoInfo[],
  query: string,
  opts: SearchOptions,
  maxResults: number,
): Promise<SearchResult> {
  const files: SearchFileResult[] = []
  const byPath = new Map<string, SearchFileResult>()
  let total = 0
  let truncated = false

  for (const repo of repos) {
    if (opts.signal?.cancelled) return { files, truncated }
    let matches
    try {
      matches = await repo.service.grep(query, opts)
    } catch {
      // A single failing repo shouldn't sink the whole search.
      continue
    }
    for (const m of matches) {
      if (total >= maxResults) {
        truncated = true
        return { files, truncated }
      }
      const abs = join(repo.root, m.path)
      let entry = byPath.get(abs)
      if (!entry) {
        entry = { path: abs, matches: [] }
        byPath.set(abs, entry)
        files.push(entry)
      }
      // git's --column is a BYTE offset; normalize to a UTF-16 char column so it
      // lines up with the editor's gotoLine and the preview slicing (both char-
      // based). The Bun engine is already char-based, so this is git-only.
      const col = byteColToCharCol(m.preview, m.col)
      const length = gitMatchLength(m.preview, col - 1, query, opts)
      entry.matches.push({ line: m.line, col, length, preview: m.preview })
      total += 1
    }
  }

  return { files, truncated }
}

async function searchWithBun(
  root: string,
  query: string,
  opts: SearchOptions,
  maxResults: number,
): Promise<SearchResult> {
  const re = buildRegExp(query, opts)
  if (!re) return { files: [], truncated: false }

  const { files: rels, truncated: enumTruncated } = await enumerateFiles(root)
  const files: SearchFileResult[] = []
  let total = 0
  let truncated = enumTruncated

  for (const rel of rels) {
    if (opts.signal?.cancelled) return { files, truncated }
    const abs = join(root, rel)

    let size: number
    try {
      size = (await stat(abs)).size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) continue

    let bytes: Uint8Array
    try {
      bytes = await Bun.file(abs).bytes()
    } catch {
      continue
    }
    if (isBinary(bytes)) continue

    const text = new TextDecoder().decode(bytes)
    const lines = text.split("\n")
    const fileMatches: SearchMatch[] = []
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0
      const m = re.exec(lines[i])
      if (!m) continue
      // Check BEFORE adding (like the git engine): reaching the cap on the final
      // match is not truncation — only an additional, dropped match is.
      if (total >= maxResults) {
        truncated = true
        break
      }
      fileMatches.push({ line: i + 1, col: m.index + 1, length: m[0].length, preview: lines[i].replace(/\r$/, "") })
      total += 1
    }
    if (fileMatches.length > 0) files.push({ path: abs, matches: fileMatches })
    if (truncated) break
  }

  return { files, truncated }
}

/** True if any of the first {@link SNIFF_BYTES} bytes is NUL (binary heuristic). */
function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, SNIFF_BYTES)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/**
 * Convert git's 1-based BYTE `--column` into a 1-based UTF-16 char column by
 * walking the decoded preview line, tallying UTF-8 bytes until the match's byte
 * offset is reached. On an ASCII line byte == char, so this is a no-op there; it
 * only matters on lines with multi-byte characters ("café résumé …"), where the
 * raw byte column would otherwise land the caret past the match. Lines are short,
 * so the per-line O(n) walk is negligible.
 */
function byteColToCharCol(line: string, byteCol: number): number {
  const targetByte = byteCol - 1
  if (targetByte <= 0) return byteCol
  let bytes = 0
  let charIdx = 0
  for (const ch of line) {
    if (bytes >= targetByte) break
    bytes += Buffer.byteLength(ch)
    charIdx += ch.length
  }
  return charIdx + 1
}

/**
 * Length (UTF-16 code units) of the git match starting at `charStart` in
 * `preview`. Literal/case-insensitive/whole-word queries match exactly the query
 * text (case never changes length, and whole-word's edges are zero-width), so the
 * length is the query's. Regex queries are re-derived by anchoring a sticky JS
 * regex at the engine-reported start: git's POSIX ERE and JS's dialect can
 * diverge (`\d`, `[[:digit:]]`, …), so if JS fails to match here we keep the
 * (always-correct) start and fall back to a minimal 1-char span — only the extent
 * is ever best-effort, never the start, so the highlight can't land on the wrong
 * token the way a full re-search could.
 */
function gitMatchLength(
  preview: string,
  charStart: number,
  query: string,
  opts: Pick<SearchOptions, "matchCase" | "wholeWord" | "regex">,
): number {
  if (!opts.regex) return query.length
  const re = buildRegExp(query, opts, "y")
  if (re) {
    re.lastIndex = charStart
    const m = re.exec(preview)
    if (m && m.index === charStart && m[0].length > 0) return m[0].length
  }
  return 1
}

function buildRegExp(
  query: string,
  opts: Pick<SearchOptions, "matchCase" | "wholeWord" | "regex">,
  extraFlags = "",
): RegExp | null {
  const source = searchPatternSource(query, opts)
  try {
    return new RegExp(source, (opts.matchCase ? "" : "i") + extraFlags)
  } catch {
    // An invalid user regex yields no matches rather than throwing.
    return null
  }
}
