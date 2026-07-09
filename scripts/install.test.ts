// Hermetic tests for the pure helpers in install.sh. Each case sources the
// script (its `[[ BASH_SOURCE == $0 ]]` guard keeps `main` from running) and
// invokes one function, so nothing here hits the network or the real filesystem
// beyond a scratch tmpdir. Network paths in install.sh (download/probe_redirect)
// are deliberately thin wrappers and are only exercised through curl shims.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url))

// Run a bash snippet that has sourced install.sh, returning its result. `env`
// and `pathPrepend` (a dir put at the front of PATH, for uname/vsx shims) let a
// case control what the sourced functions see.
async function sh(
  body: string,
  opts: { env?: Record<string, string>; pathPrepend?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const basePath = opts.pathPrepend ? `${opts.pathPrepend}:${process.env.PATH}` : process.env.PATH
  const proc = Bun.spawn(["bash", "-c", `source "${INSTALL_SH}"\n${body}`], {
    env: { ...process.env, ...opts.env, PATH: basePath },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

// Write an executable script into `dir` (used to shim `uname`/`vsx` onto PATH).
async function shim(dir: string, name: string, script: string): Promise<void> {
  const path = join(dir, name)
  await writeFile(path, `#!/usr/bin/env bash\n${script}\n`)
  await chmod(path, 0o755)
}

let scratch: string
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "vsx-install-test-"))
})
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

// ── detect_platform: uname → "<os>-<arch>" mapping via a fake uname on PATH ──

const platformCases: Array<[string, string, string]> = [
  ["Darwin", "arm64", "darwin-arm64"],
  ["Darwin", "x86_64", "darwin-x64"],
  ["Linux", "x86_64", "linux-x64"],
  ["Linux", "aarch64", "linux-arm64"],
  ["Linux", "amd64", "linux-x64"],
]

for (const [kernel, machine, expected] of platformCases) {
  test(`detect_platform maps ${kernel}/${machine} → ${expected}`, async () => {
    const bin = await mkdtemp(join(scratch, "bin-"))
    await shim(bin, "uname", `case "$1" in -s) echo ${kernel} ;; -m) echo ${machine} ;; esac`)
    const { code, stdout } = await sh("detect_platform", { pathPrepend: bin })
    expect(code).toBe(0)
    expect(stdout).toBe(expected)
  })
}

test("detect_platform rejects Windows with a WSL hint", async () => {
  const bin = await mkdtemp(join(scratch, "bin-"))
  await shim(bin, "uname", `case "$1" in -s) echo MINGW64_NT-10.0 ;; -m) echo x86_64 ;; esac`)
  const { code, stderr } = await sh("detect_platform", { pathPrepend: bin })
  expect(code).not.toBe(0)
  expect(stderr).toContain("WSL")
})

test("detect_platform rejects an unknown architecture", async () => {
  const bin = await mkdtemp(join(scratch, "bin-"))
  await shim(bin, "uname", `case "$1" in -s) echo Linux ;; -m) echo riscv64 ;; esac`)
  const { code, stderr } = await sh("detect_platform", { pathPrepend: bin })
  expect(code).not.toBe(0)
  expect(stderr).toContain("architecture")
})

// ── parse_tag_from_release_url: tag out of the /releases/latest redirect ─────

test("parse_tag_from_release_url extracts the tag from a redirect target", async () => {
  const { code, stdout } = await sh(
    'parse_tag_from_release_url "https://github.com/mkuchak/vsx/releases/tag/v1.2.3"',
  )
  expect(code).toBe(0)
  expect(stdout).toBe("v1.2.3")
})

test("parse_tag_from_release_url echoes nothing for a non-tag URL", async () => {
  // A repo with no published releases serves /releases/latest directly (404,
  // no redirect) — the effective URL is still the /releases/latest one.
  const { code, stdout } = await sh(
    'parse_tag_from_release_url "https://github.com/mkuchak/vsx/releases/latest"',
  )
  expect(code).toBe(0)
  expect(stdout).toBe("")
})

// ── tag_to_version / parse_version_output / idempotence logic ────────────────

test("tag_to_version strips a leading v", async () => {
  const { stdout } = await sh('tag_to_version v0.1.0')
  expect(stdout).toBe("0.1.0")
})

test("parse_version_output pulls the semver out of `vsx --version` output", async () => {
  const { stdout } = await sh(`parse_version_output "vsx 0.1.0"`)
  expect(stdout).toBe("0.1.0")
})

test("idempotence: installed version equal to the release version compares equal", async () => {
  // Mirror main()'s check: normalized installed == tag_to_version(tag).
  const { code, stdout } = await sh(`
    tag="v0.1.0"
    installed="$(parse_version_output "vsx 0.1.0")"
    if [ "$installed" = "$(tag_to_version "$tag")" ]; then echo equal; else echo differ; fi
  `)
  expect(code).toBe(0)
  expect(stdout).toBe("equal")
})

test("idempotence: an older installed version compares as differ", async () => {
  const { stdout } = await sh(`
    tag="v0.2.0"
    installed="$(parse_version_output "vsx 0.1.0")"
    if [ "$installed" = "$(tag_to_version "$tag")" ]; then echo equal; else echo differ; fi
  `)
  expect(stdout).toBe("differ")
})

// ── verify_checksum: against a real fixture (happy + corrupted) ──────────────

async function checksumFixture(good: boolean): Promise<{ dir: string; artifact: string }> {
  const dir = await mkdtemp(join(scratch, "sums-"))
  const artifact = "vsx-9.9.9.tar.gz"
  const payload = "pretend tarball bytes\n"
  await writeFile(join(dir, artifact), payload)
  const hash = createHash("sha256").update(payload).digest("hex")
  const written = good ? hash : hash.replace(/.$/, (c) => (c === "0" ? "1" : "0"))
  // Include a second, unrelated line to prove only the artifact's line is checked.
  await writeFile(join(dir, "SHA256SUMS"), `${written}  ${artifact}\ndeadbeef  other.txt\n`)
  return { dir, artifact }
}

test("verify_checksum succeeds on a matching checksum", async () => {
  const { dir, artifact } = await checksumFixture(true)
  const { code } = await sh(`verify_checksum "${dir}" "${artifact}" "${dir}/SHA256SUMS"`)
  expect(code).toBe(0)
})

test("verify_checksum fails on a corrupted checksum", async () => {
  const { dir, artifact } = await checksumFixture(false)
  const { code } = await sh(`verify_checksum "${dir}" "${artifact}" "${dir}/SHA256SUMS"`)
  expect(code).not.toBe(0)
})

test("verify_checksum fails when the artifact has no line in SHA256SUMS", async () => {
  const dir = await mkdtemp(join(scratch, "sums-missing-"))
  await writeFile(join(dir, "vsx-9.9.9.tar.gz"), "bytes\n")
  await writeFile(join(dir, "SHA256SUMS"), "deadbeef  some-other-file.tar.gz\n")
  const { code } = await sh(`verify_checksum "${dir}" "vsx-9.9.9.tar.gz" "${dir}/SHA256SUMS"`)
  expect(code).not.toBe(0)
})

// GNU `sha256sum -c` tolerates a malformed line (prints only a WARNING, exits
// 0); macOS `shasum -a 256 -c` rejects it (exits 1) — a truncated SHA256SUMS
// download would install unverified on a GNU host without the fix. Shim
// `sha256sum` to behave exactly as leniently as GNU coreutils would, so these
// prove the NEW shape check catches it before the underlying tool is even
// consulted (not incidentally, via whichever tool happens to be strict).
test("verify_checksum fails closed on a truncated hash even if the underlying tool would tolerate it", async () => {
  const dir = await mkdtemp(join(scratch, "sums-truncated-"))
  const artifact = "vsx-9.9.9.tar.gz"
  await writeFile(join(dir, artifact), "pretend tarball bytes\n")
  const truncated = "a".repeat(63) // one hex char short of 64
  await writeFile(join(dir, "SHA256SUMS"), `${truncated}  ${artifact}\n`)

  const lenientBin = await mkdtemp(join(scratch, "bin-lenient-"))
  await shim(lenientBin, "sha256sum", "exit 0") // simulates GNU's lenient pass

  const { code } = await sh(`verify_checksum "${dir}" "${artifact}" "${dir}/SHA256SUMS"`, {
    pathPrepend: lenientBin,
  })
  expect(code).not.toBe(0)
})

test("verify_checksum fails closed on a non-hex hash", async () => {
  const dir = await mkdtemp(join(scratch, "sums-nonhex-"))
  const artifact = "vsx-9.9.9.tar.gz"
  await writeFile(join(dir, artifact), "pretend tarball bytes\n")
  await writeFile(join(dir, "SHA256SUMS"), `${"g".repeat(64)}  ${artifact}\n`)
  const { code } = await sh(`verify_checksum "${dir}" "${artifact}" "${dir}/SHA256SUMS"`)
  expect(code).not.toBe(0)
})

test("verify_checksum fails closed on an empty SHA256SUMS file", async () => {
  const dir = await mkdtemp(join(scratch, "sums-empty-"))
  const artifact = "vsx-9.9.9.tar.gz"
  await writeFile(join(dir, artifact), "pretend tarball bytes\n")
  await writeFile(join(dir, "SHA256SUMS"), "")
  const { code } = await sh(`verify_checksum "${dir}" "${artifact}" "${dir}/SHA256SUMS"`)
  expect(code).not.toBe(0)
})

// ── path_hint: correct syntax per shell ──────────────────────────────────────

test("path_hint emits fish syntax when SHELL is fish", async () => {
  const { stdout } = await sh('path_hint /home/u/.local/bin', {
    env: { SHELL: "/opt/homebrew/bin/fish" },
  })
  expect(stdout).toBe("fish_add_path /home/u/.local/bin")
})

test("path_hint emits POSIX export syntax for bash/zsh", async () => {
  const { stdout } = await sh('path_hint /home/u/.local/bin', { env: { SHELL: "/bin/zsh" } })
  expect(stdout).toBe('export PATH="/home/u/.local/bin:$PATH"')
})

// ── VSX_VERSION override short-circuits resolve_tag (no network) ─────────────

test("resolve_tag honors the VSX_VERSION override without touching the network", async () => {
  const { code, stdout } = await sh("resolve_tag", { env: { VSX_VERSION: "v3.4.5" } })
  expect(code).toBe(0)
  expect(stdout).toBe("v3.4.5")
})

test("resolve_tag parses the tag from the releases/latest redirect", async () => {
  const bin = await mkdtemp(join(scratch, "bin-redirect-"))
  await shim(bin, "curl", 'printf "200 https://github.com/mkuchak/vsx/releases/tag/v9.9.9"')
  const { code, stdout } = await sh("resolve_tag", { pathPrepend: bin })
  expect(code).toBe(0)
  expect(stdout).toBe("v9.9.9")
})

test("resolve_tag reports missing releases on a 404 (none published / repo moved)", async () => {
  const bin = await mkdtemp(join(scratch, "bin-404-"))
  await shim(bin, "curl", 'printf "404 https://github.com/mkuchak/vsx/releases/latest"')
  const { code, stderr } = await sh("resolve_tag", { pathPrepend: bin })
  expect(code).not.toBe(0)
  expect(stderr).toContain("no release found")
})

test("resolve_tag surfaces an unexpected HTTP status distinctly (the rate-limit regression)", async () => {
  // The API-based resolver died on api.github.com's 403 once the caller IP's
  // unauthenticated quota was drained; the website endpoint shouldn't ever 403,
  // but if GitHub answers anything unexpected the message must name the status
  // instead of blaming the network or the repo's visibility.
  const bin = await mkdtemp(join(scratch, "bin-403-"))
  await shim(bin, "curl", 'printf "403 https://github.com/mkuchak/vsx/releases/latest"')
  const { code, stderr } = await sh("resolve_tag", { pathPrepend: bin })
  expect(code).not.toBe(0)
  expect(stderr).toContain("HTTP 403")
})

test("resolve_tag reports a generic network error when curl itself fails", async () => {
  const bin = await mkdtemp(join(scratch, "bin-net-"))
  await shim(bin, "curl", "exit 6") // couldn't resolve host
  const { code, stderr } = await sh("resolve_tag", { pathPrepend: bin })
  expect(code).not.toBe(0)
  expect(stderr).toContain("could not reach github.com")
})

// ── prune_versions: keeps the just-installed version + two newest others ────

test("prune_versions keeps the just-installed version plus the two newest others", async () => {
  const home = await mkdtemp(join(scratch, "home-"))
  const vsxHome = join(home, ".vsx")
  for (const v of ["0.1.0", "0.2.0", "0.3.0", "0.10.0", "support"]) {
    await mkdir(join(vsxHome, v), { recursive: true })
  }
  // 0.10.0 is both the just-installed version and already the newest by
  // version-sort — the common case: keep = {0.10.0} ∪ {0.3.0, 0.2.0}.
  const { code } = await sh(`prune_versions "0.10.0"`, { env: { HOME: home } })
  expect(code).toBe(0)
  const survivors = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: vsxHome, onlyFiles: false }))).sort()
  expect(survivors).toEqual(["0.10.0", "0.2.0", "0.3.0", "support"])
})

test("prune_versions never prunes a pinned downgrade, even though it is the oldest dir on disk", async () => {
  const home = await mkdtemp(join(scratch, "home-pin-"))
  const vsxHome = join(home, ".vsx")
  for (const v of ["0.1.0", "0.3.0", "0.4.0"]) {
    await mkdir(join(vsxHome, v), { recursive: true })
  }
  // VSX_VERSION=v0.1.0 pinned a downgrade while 0.3.0/0.4.0 already exist. The
  // regression: sort -Vr | tail -n +3 alone would prune 0.1.0 right after it
  // was just symlinked, leaving a dangling install.
  const { code } = await sh(`prune_versions "0.1.0"`, { env: { HOME: home } })
  expect(code).toBe(0)
  const survivors = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: vsxHome, onlyFiles: false }))).sort()
  expect(survivors).toContain("0.1.0")
})

// ── piped-entry regression: `cat install.sh | bash` must run main() ─────────

test("piped execution (curl | bash) runs main(), the exact BASH_SOURCE-guard regression", async () => {
  const bin = await mkdtemp(join(scratch, "bin-piped-"))
  await shim(bin, "uname", `case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac`)
  // No VSX_VERSION override, so main() reaches resolve_tag's network probe;
  // the shimmed curl answers a canned 404 so nothing hits the real network,
  // but main() must run far enough to get there.
  await shim(bin, "curl", 'printf "404 https://github.com/mkuchak/vsx/releases/latest"')
  const basePath = `${bin}:${process.env.PATH}`
  const proc = Bun.spawn(["bash", "-c", `cat "${INSTALL_SH}" | bash`], {
    env: { ...process.env, PATH: basePath },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  // Before the BASH_SOURCE guard, `$0` is "bash" and `BASH_SOURCE[0]` is unset
  // under a pipe, so main() would never fire and stdout would be silent.
  expect(stdout).toContain("vsx installer")
  expect(stdout).toContain("platform: darwin-arm64")
  expect(stderr).toContain("no release found")
})
