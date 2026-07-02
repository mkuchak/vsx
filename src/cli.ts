import { statSync } from "node:fs"
import { resolve } from "node:path"

export type WorkspaceArgResult = { root: string } | { error: string }

/**
 * Resolve the optional workspace directory positional (VSCode's `code <dir>`).
 * `argv` is `process.argv`, so the first non-flag entry after the binary and
 * script path (index >= 2) is the workspace. Flags (leading `-`) are ignored.
 */
export function resolveWorkspaceArg(argv: string[], cwd: string): WorkspaceArgResult {
  const arg = argv.slice(2).find((entry) => !entry.startsWith("-"))
  if (arg === undefined) return { root: cwd }

  const root = resolve(cwd, arg)
  try {
    // stat (not lstat) so a symlink pointing at a directory is accepted.
    if (!statSync(root).isDirectory()) return { error: `vsx: not a directory: ${root}` }
  } catch {
    return { error: `vsx: not a directory: ${root}` }
  }
  return { root }
}
