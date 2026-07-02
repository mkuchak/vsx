#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { resolveWorkspaceArg } from "./cli"
import { App } from "./workbench/App"

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

createRoot(renderer).render(<App workspaceRoot={workspace.root} />)
