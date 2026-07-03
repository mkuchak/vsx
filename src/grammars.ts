/**
 * Extra tree-sitter grammars vendored into assets/grammars/ and registered on top
 * of the five OpenTUI ships (javascript, typescript, markdown, markdown_inline,
 * zig). Each entry pairs a prebuilt .wasm with an nvim-treesitter highlights.scm;
 * both are read from disk by the parser worker, so highlighting stays fully
 * offline at runtime. See each grammar's highlights.scm header for source/commit.
 *
 * `addDefaultParsers` MUST run before the first `highlightOnce` (the call that
 * lazily boots the worker) — hence it is wired at the top of main.tsx. Each
 * `filetype` MUST match what {@link detectLanguage} returns; yaml also answers to
 * the "yml" extension via `aliases`.
 */
import { fileURLToPath } from "node:url"
import { addDefaultParsers, type FiletypeParserOptions } from "@opentui/core"

/**
 * Resolve a vendored grammar asset to an absolute path (offline-read by the
 * worker). `fileURLToPath` — NOT `URL.pathname` — because pathname leaves the
 * path percent-encoded, so any install dir with a space or non-ASCII char
 * (`/Users/John Doe/…` → `…/John%20Doe/…`) would ENOENT and silently disable
 * every grammar. `base` is injectable so tests can exercise an encoded path.
 */
export function grammarAsset(relative: string, base: string | URL = import.meta.url): string {
  return fileURLToPath(new URL(`../assets/grammars/${relative}`, base))
}

function grammar(filetype: string, aliases?: string[]): FiletypeParserOptions {
  return {
    filetype,
    ...(aliases ? { aliases } : {}),
    queries: { highlights: [grammarAsset(`${filetype}/highlights.scm`)] },
    wasm: grammarAsset(`${filetype}/tree-sitter-${filetype}.wasm`),
  }
}

/** The grammars vsx vendors beyond OpenTUI's bundled set. */
export const BUNDLED_GRAMMARS: FiletypeParserOptions[] = [
  grammar("json"),
  grammar("yaml", ["yml"]),
  grammar("css"),
  grammar("html"),
  grammar("toml"),
]

/** Register the vendored grammars. Idempotent (addDefaultParsers keys by filetype). */
export function registerBundledGrammars(): void {
  addDefaultParsers(BUNDLED_GRAMMARS)
}
