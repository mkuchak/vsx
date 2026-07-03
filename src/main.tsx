#!/usr/bin/env bun
import { fileURLToPath } from "node:url"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import pkg from "../package.json"
import { isVersionRequested, resolveWorkspaceArg } from "./cli"
import { registerBundledGrammars } from "./grammars"
import { App } from "./workbench/App"

// `--version`/`-v` prints and exits before any renderer or shim work, so the
// installer can probe the running version instantly. Runs first to stay fast.
if (isVersionRequested(process.argv)) {
  console.log(`vsx ${pkg.version}`)
  process.exit(0)
}

// Point OpenTUI's tree-sitter client at our worker shim, which works around a
// Bun 1.2.3 bug that otherwise stops the parser worker from ever booting (see
// treeSitterWorkerShim.ts). fileURLToPath (NOT URL.pathname) decodes any
// percent-encoding in the path so a directory with spaces still resolves. The
// client reads this env var lazily when the worker first spawns, so setting it
// before the renderer starts is early enough.
process.env.OTUI_TREE_SITTER_WORKER_PATH = fileURLToPath(
  new URL("./treeSitterWorkerShim.ts", import.meta.url),
)

// Register the vendored json/yaml/css/html/toml grammars BEFORE the first
// highlightOnce (which boots the tree-sitter worker), so a file opened on the
// initial render already has its parser available.
registerBundledGrammars()

const workspace = resolveWorkspaceArg(process.argv, process.cwd())
if ("error" in workspace) {
  // Safe to bail hard here: this runs before the renderer opens the alternate
  // screen, so there is no terminal state to restore.
  console.error(workspace.error)
  process.exit(1)
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
})

createRoot(renderer).render(<App workspaceRoot={workspace.root} initialFile={workspace.file} />)
