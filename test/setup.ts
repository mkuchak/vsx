// Bun test preload (wired via bunfig.toml) — runs before any test file's
// imports. Redirects XDG_STATE_HOME to a per-run scratch directory so
// src/services/fileHistory.ts's defaultBaseDir() (which reads the env var
// LAZILY at createFileHistory() call time, not at module load) resolves away
// from the developer's REAL `~/.local/state/vsx/file-history.json` for the
// whole test run — no test file, stubbed or not, can write there anymore.
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "vsx-test-xdg-"))
process.env.XDG_STATE_HOME = dir

// Regression guard: fail loudly (rather than silently writing into the real
// state dir) if this redirect is ever unset or missing at test time.
const realStateDir = join(homedir(), ".local", "state")
if (!process.env.XDG_STATE_HOME || process.env.XDG_STATE_HOME.startsWith(realStateDir)) {
  throw new Error(
    `test isolation failed: XDG_STATE_HOME must be redirected away from the real state dir, got "${process.env.XDG_STATE_HOME}"`,
  )
}

process.on("exit", () => {
  rmSync(dir, { recursive: true, force: true })
})
