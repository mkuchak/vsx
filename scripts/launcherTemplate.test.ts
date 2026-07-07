// Hermetic tests for the launcher template's bun-resolution fallback. Builds a
// minimal fake install (bin/vsx + a stand-in src/main.tsx) and runs the
// launcher directly with a controlled PATH/HOME — no real bun, no tarball
// build required.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LAUNCHER } from "./launcherTemplate"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vsx-launcher-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeFakeInstall(): Promise<{ launcher: string }> {
  const binDir = join(dir, "bin")
  await mkdir(binDir, { recursive: true })
  const launcher = join(binDir, "vsx")
  await writeFile(launcher, LAUNCHER)
  await chmod(launcher, 0o755)
  await mkdir(join(dir, "src"), { recursive: true })
  // Stand-in for the real entry: echoes which "bun" ran it and its args.
  await writeFile(join(dir, "src", "main.tsx"), "#!/bin/sh\necho ran-main:\"$@\"\n")
  return { launcher }
}

async function writeBunShim(binDir: string, label: string): Promise<void> {
  await mkdir(binDir, { recursive: true })
  const bun = join(binDir, "bun")
  await writeFile(bun, `#!/bin/sh\necho ${label} "$@"\n`)
  await chmod(bun, 0o755)
}

test("launcher uses `bun` from PATH when present", async () => {
  const { launcher } = await writeFakeInstall()
  const shimDir = await mkdtemp(join(tmpdir(), "vsx-bin-"))
  await writeBunShim(shimDir, "path-bun")

  const proc = Bun.spawn([launcher, "--version"], {
    env: { PATH: `${shimDir}:/usr/bin:/bin`, HOME: join(dir, "nonexistent-home") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  expect(out).toContain("path-bun")
})

test("launcher falls back to $HOME/.bun/bin/bun when bun is not on PATH", async () => {
  const { launcher } = await writeFakeInstall()
  const home = await mkdtemp(join(tmpdir(), "vsx-home-"))
  await writeBunShim(join(home, ".bun", "bin"), "fallback-bun")

  const proc = Bun.spawn([launcher, "--version"], {
    env: { PATH: "/usr/bin:/bin", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  expect(out).toContain("fallback-bun")
})

test("launcher exits with a clear error when bun is nowhere to be found", async () => {
  const { launcher } = await writeFakeInstall()
  const home = await mkdtemp(join(tmpdir(), "vsx-home-none-"))

  const proc = Bun.spawn([launcher, "--version"], {
    env: { PATH: "/usr/bin:/bin", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  })
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  expect(code).not.toBe(0)
  expect(err).toContain("bun runtime not found")
})
