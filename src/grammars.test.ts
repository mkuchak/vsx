import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { Language, Parser, Query } from "web-tree-sitter"
import { detectLanguage } from "./model/documents"
import { BUNDLED_GRAMMARS, grammarAsset } from "./grammars"

// These tests validate the vendored grammar+query pairs against web-tree-sitter
// directly — the SAME engine (and version) OpenTUI's parser worker loads. The
// worker itself can't boot headless (its INIT needs the full renderer), so this
// is the closest faithful proof that each grammar parses and its highlights.scm
// compiles and yields captures. A query that throws here would also throw inside
// the worker's `new Query(...)`, silently disabling that language.

const SAMPLES: Record<string, string> = {
  json: '{"name": "vsx", "count": 1, "ok": true, "empty": null}',
  yaml: "name: vsx\ncount: 42\nflag: true\nlist:\n  - a\n  - b\nanchor: &a x\nref: *a\n# comment\n",
  css: "body { color: red; margin: 0 auto; }\n/* c */\n.cls { font-size: 12px; }",
  html: '<!DOCTYPE html>\n<html><body><h1 class="t">Hi</h1><a href="x">l</a><!-- c --></body></html>',
  toml: '# comment\n[table]\nkey = "val"\nnum = 3\nflag = true\n',
}

// At least one "meaningful" (non-punctuation) capture we expect per grammar, so a
// grammar that loads but produces only bracket/comma noise still fails loudly.
const EXPECTED_SCOPE: Record<string, string> = {
  json: "property", // object keys
  yaml: "property", // mapping keys
  css: "property", // declaration names
  html: "tag", // element tag names
  toml: "property", // bare keys
}

describe("BUNDLED_GRAMMARS registration config", () => {
  test("registers exactly json/yaml/css/html/toml with matching detectLanguage filetypes", () => {
    expect(BUNDLED_GRAMMARS.map((g) => g.filetype).sort()).toEqual(["css", "html", "json", "toml", "yaml"])
    // Every registered filetype must be a value detectLanguage actually returns,
    // or the parser would never be selected for an opened file.
    expect(detectLanguage("x.json")).toBe("json")
    expect(detectLanguage("x.yaml")).toBe("yaml")
    expect(detectLanguage("x.css")).toBe("css")
    expect(detectLanguage("x.html")).toBe("html")
    expect(detectLanguage("x.toml")).toBe("toml")
  })

  test("yaml also answers to the .yml extension via an alias", () => {
    const yaml = BUNDLED_GRAMMARS.find((g) => g.filetype === "yaml")
    expect(yaml?.aliases).toEqual(["yml"])
    expect(detectLanguage("x.yml")).toBe("yaml")
  })

  test("every grammar points at existing wasm + highlights.scm asset files", () => {
    for (const g of BUNDLED_GRAMMARS) {
      expect(existsSync(g.wasm)).toBe(true)
      for (const scm of g.queries.highlights) expect(existsSync(scm)).toBe(true)
    }
  })

  test("grammarAsset percent-decodes install paths with spaces/non-ASCII", () => {
    // A base URL under a dir the browser would encode (space → %20). Using
    // URL.pathname here would hand the worker "/tmp/with%20space/…" → ENOENT and
    // silently kill the grammar; fileURLToPath must decode it back.
    const base = "file:///tmp/with%20space/n%C3%A3o/src/main.tsx"
    expect(grammarAsset("json/highlights.scm", base)).toBe(
      "/tmp/with space/não/assets/grammars/json/highlights.scm",
    )
  })
})

describe("vendored grammars parse and highlight via web-tree-sitter", () => {
  for (const g of BUNDLED_GRAMMARS) {
    test(`${g.filetype}: wasm loads, query compiles, and captures are non-empty`, async () => {
      await Parser.init()
      const language = await Language.load(readFileSync(g.wasm))
      const parser = new Parser()
      parser.setLanguage(language)
      const tree = parser.parse(SAMPLES[g.filetype])
      expect(tree).not.toBeNull()

      const scmSource = readFileSync(g.queries.highlights[0], "utf8")
      const query = new Query(language, scmSource)
      const captures = query.captures(tree!.rootNode)

      expect(captures.length).toBeGreaterThan(0)
      const scopes = new Set(captures.map((c) => c.name))
      expect(scopes.has(EXPECTED_SCOPE[g.filetype])).toBe(true)
    })
  }

  test("html colors tag names and attributes (inlined html_tags query)", async () => {
    await Parser.init()
    const html = BUNDLED_GRAMMARS.find((g) => g.filetype === "html")!
    const language = await Language.load(readFileSync(html.wasm))
    const parser = new Parser()
    parser.setLanguage(language)
    const tree = parser.parse(SAMPLES.html)!
    const query = new Query(language, readFileSync(html.queries.highlights[0], "utf8"))
    const scopes = new Set(query.captures(tree.rootNode).map((c) => c.name))
    // Both live in the inherited html_tags query we inlined; without it html
    // would render almost unstyled.
    expect(scopes.has("tag")).toBe(true)
    expect(scopes.has("tag.attribute")).toBe(true)
  })
})
