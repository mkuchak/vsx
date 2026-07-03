import { afterAll, beforeAll, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { getTreeSitterClient } from "@opentui/core"
import { registerBundledGrammars } from "./grammars"

// End-to-end proof that syntax highlighting actually works: boot OpenTUI's REAL
// tree-sitter parser worker (via our shim) and assert highlightOnce returns real
// spans. Before the shim, the worker exited ~13ms after boot under Bun 1.2.3 and
// every highlightOnce timed out — every file rendered white (see
// treeSitterWorkerShim.ts for the Bun getBuiltinModule bug this works around).
//
// ORDERING CONSTRAINT: `getTreeSitterClient()` is a package-level singleton whose
// worker path is read (from OTUI_TREE_SITTER_WORKER_PATH) lazily, when the worker
// first spawns on the first highlightOnce. So the env var only has to be set
// before that first call — done in beforeAll here, mirroring how main.tsx sets it
// before the renderer starts. No other suite boots the real worker (EditorPane's
// tests swap the singleton's highlightOnce for a mock), so this test owns the
// singleton's first real spawn and it picks up the shim.

const WORKER_SHIM_PATH = fileURLToPath(new URL("./treeSitterWorkerShim.ts", import.meta.url))

// Worker boot + wasm/grammar load is ~1-2s cold; give each parse generous headroom.
const HIGHLIGHT_TIMEOUT_MS = 15_000

type HighlightSpan = [number, number, string, ...unknown[]]
type HighlightResult = { highlights?: HighlightSpan[]; warning?: string; error?: string }

let client: ReturnType<typeof getTreeSitterClient>

async function scopesFor(content: string, filetype: string): Promise<string[]> {
  const result = (await client.highlightOnce(content, filetype)) as HighlightResult
  expect(result.error).toBeUndefined()
  expect(result.warning).toBeUndefined()
  const spans = result.highlights ?? []
  expect(spans.length).toBeGreaterThan(0)
  return spans.map((span) => span[2])
}

beforeAll(() => {
  process.env.OTUI_TREE_SITTER_WORKER_PATH = WORKER_SHIM_PATH
  // Register the vendored grammars (json/yaml/css/html/toml) before the worker
  // boots, exactly as main.tsx does, so json below resolves a parser.
  registerBundledGrammars()
  client = getTreeSitterClient()
})

afterAll(async () => {
  await client.destroy?.()
})

test(
  "typescript: highlightOnce returns real spans including a keyword",
  async () => {
    const scopes = await scopesFor("const a: number = 1\n", "typescript")
    expect(scopes).toContain("keyword")
  },
  HIGHLIGHT_TIMEOUT_MS,
)

test(
  "json: a vendored grammar highlights object keys as property",
  async () => {
    const scopes = await scopesFor('{"a":1}\n', "json")
    expect(scopes).toContain("property")
  },
  HIGHLIGHT_TIMEOUT_MS,
)

test(
  "markdown: highlightOnce emits a markup.* capture (pins the md theme work)",
  async () => {
    const scopes = await scopesFor("# Title\n\nSome **bold** text.\n", "markdown")
    expect(scopes.some((scope) => scope.startsWith("markup."))).toBe(true)
  },
  HIGHLIGHT_TIMEOUT_MS,
)
