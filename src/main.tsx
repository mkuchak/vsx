#!/usr/bin/env bun
import { fileURLToPath } from "node:url"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import pkg from "../package.json"
import { isUpdateRequested, isVersionRequested, resolveWorkspaceArg } from "./cli"
import { registerBundledGrammars } from "./grammars"
import { App } from "./workbench/App"

// `--version`/`-v` prints and exits before any renderer or shim work, so the
// installer can probe the running version instantly. Runs first to stay fast.
if (isVersionRequested(process.argv)) {
  console.log(`vsx ${pkg.version}`)
  process.exit(0)
}

// `vsx update` re-runs the hosted installer (install.sh is not shipped inside
// the release tarball, so we fetch the canonical copy). It is idempotent: it
// no-ops when already on the latest release and otherwise installs the new
// version and repoints the symlink. Runs after --version but BEFORE
// resolveWorkspaceArg so `update` is not mistaken for a filesystem path, and
// before any renderer/tree-sitter/worker setup to stay lightweight.
if (isUpdateRequested(process.argv)) {
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      "curl -fsSL https://raw.githubusercontent.com/mkuchak/vsx/main/install.sh | bash",
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  )
  const code = await proc.exited
  if (code === 0) {
    console.log("vsx: update complete — restart vsx for the new version to take effect.")
  } else {
    console.error(
      "vsx: update failed — check your network, and note the vsx repo must be public (or a GH token configured) for self-update.",
    )
  }
  process.exit(code)
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
