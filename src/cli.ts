import { statSync } from "node:fs"
import { dirname, resolve } from "node:path"

export type WorkspaceArgResult = { root: string; file?: string } | { error: string }

/**
 * Whether `--version`/`-v` appears anywhere in `argv` (VSCode's `code --version`).
 * `argv` is `process.argv`, so the binary and script path (index < 2) are skipped.
 * The flag wins over any positional so `vsx -v somedir` still prints the version.
 */
export function isVersionRequested(argv: string[]): boolean {
  return argv.slice(2).some((entry) => entry === "--version" || entry === "-v")
}

/**
 * Resolve the optional workspace positional (VSCode's `code <dir|file>`).
 * `argv` is `process.argv`, so the first non-flag entry after the binary and
 * script path (index >= 2) is the workspace. Flags (leading `-`) are ignored.
 * A directory becomes the workspace root; a file opens on boot with its parent
 * directory as the root; a nonexistent path errors.
 */
export function resolveWorkspaceArg(argv: string[], cwd: string): WorkspaceArgResult {
  const arg = argv.slice(2).find((entry) => !entry.startsWith("-"))
  if (arg === undefined) return { root: cwd }

  const resolved = resolve(cwd, arg)
  let stat
  try {
    // stat (not lstat) so a symlink is followed to its real target.
    stat = statSync(resolved)
  } catch {
    return { error: `vsx: no such file or directory: ${resolved}` }
  }
  if (stat.isDirectory()) return { root: resolved }
  return { root: dirname(resolved), file: resolved }
}
