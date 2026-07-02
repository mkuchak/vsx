/**
 * Move files to the OS trash (recoverable), matching VSCode's default
 * `git.discardUntrackedChangesToTrash: true`. Prefers the `trash` CLI, falling
 * back to Finder via AppleScript. Never permanently deletes as a "last resort":
 * escalating to an irreversible delete without an explicit second confirmation
 * would be a foot-gun, so both failing means we throw.
 */

export class TrashError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TrashError"
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", cmd], { stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

// AppleScript string literal: escape backslashes first, then double quotes.
function escapeAppleScript(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export async function moveToTrash(paths: string[]): Promise<void> {
  if (paths.length === 0) return

  if (await commandExists("trash")) {
    const proc = Bun.spawn(["trash", ...paths], { stdout: "ignore", stderr: "ignore" })
    if ((await proc.exited) === 0) return
  }

  const failures: string[] = []
  for (const path of paths) {
    const script = `tell application "Finder" to delete POSIX file "${escapeAppleScript(path)}"`
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await Bun.readableStreamToText(proc.stderr)
      failures.push(`${path}: ${stderr.trim() || `osascript exited with ${code}`}`)
    }
  }

  if (failures.length > 0) {
    throw new TrashError(
      `Could not move ${failures.length} file(s) to the Trash:\n${failures.join("\n")}`,
    )
  }
}
