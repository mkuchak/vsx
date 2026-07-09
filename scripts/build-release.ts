#!/usr/bin/env bun
// Builds the vsx release artifact: a single platform-independent runtime package
// `dist/vsx-<version>.tar.gz` plus `dist/SHA256SUMS`. See scripts/BUILD_NOTES.md
// for why this is a runtime package and not a `bun build --compile` binary (the
// tree-sitter worker cannot be embedded by the compiler — OpenTUI spawns it from
// a runtime path string, which Bun's compiler cannot statically analyze).
//
// The tarball carries the app source, assets, package.json + bun.lock, README,
// and a `bin/vsx` launcher. node_modules is NOT shipped: @opentui's native deps
// are platform-specific, so the installer runs `bun install --production
// --frozen-lockfile` on the target. One artifact therefore serves all platforms.
import { $ } from "bun"
import { chmod, cp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import pkg from "../package.json"
import { LAUNCHER } from "./launcherTemplate"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const DIST = join(ROOT, "dist")

// Files/dirs copied verbatim into the package root. install.sh ships so `vsx
// update` can run its own local installer copy instead of fetching the script
// from the repo's main branch (see the update block in src/main.tsx).
const PAYLOAD = ["src", "assets", "package.json", "bun.lock", "README.md", "install.sh"]

async function mktemp(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function main(): Promise<void> {
  const version = pkg.version
  const artifact = `vsx-${version}.tar.gz`
  console.log(`Building vsx ${version} runtime package…`)

  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })

  const staging = await mktemp("vsx-stage")
  try {
    for (const entry of PAYLOAD) {
      await cp(join(ROOT, entry), join(staging, entry), { recursive: true })
    }
    await mkdir(join(staging, "bin"), { recursive: true })
    await writeFile(join(staging, "bin", "vsx"), LAUNCHER)
    await chmod(join(staging, "bin", "vsx"), 0o755)

    // COPYFILE_DISABLE keeps macOS from injecting `._*` AppleDouble entries.
    await $`tar -czf ${join(DIST, artifact)} -C ${staging} .`.env({
      ...process.env,
      COPYFILE_DISABLE: "1",
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  // `shasum -a 256 -c SHA256SUMS`-verifiable: relative names, hash + double space.
  const sums = await $`shasum -a 256 ${artifact}`.cwd(DIST).text()
  await writeFile(join(DIST, "SHA256SUMS"), sums)

  await smokeTest(join(DIST, artifact), version)

  console.log(`\n✓ dist/${artifact}`)
  console.log(`✓ dist/SHA256SUMS`)
  console.log(sums.trimEnd())
}

// Unpacks the tarball into a temp dir and runs the launcher's `--version`,
// asserting it prints `vsx <version>`. node_modules is symlinked from the repo
// to stand in for the `bun install` the real installer runs on the target — this
// proves the packaged source + launcher wiring, not the native-dep install.
async function smokeTest(tarball: string, version: string): Promise<void> {
  console.log("Smoke test: unpack + launcher --version…")
  const unpack = await mktemp("vsx-smoke")
  try {
    await $`tar -xzf ${tarball} -C ${unpack}`
    await symlink(join(ROOT, "node_modules"), join(unpack, "node_modules"))

    const out = (await $`${join(unpack, "bin", "vsx")} --version`.text()).trim()
    const expected = `vsx ${version}`
    if (out !== expected) {
      throw new Error(`smoke test failed: expected "${expected}", got "${out}"`)
    }
    console.log(`  ✓ launcher printed "${out}"`)

    // `vsx update` resolves ../install.sh relative to src/main.tsx — a missing
    // copy silently degrades every install to the hosted-fallback fetch.
    if (!(await Bun.file(join(unpack, "install.sh")).exists())) {
      throw new Error("smoke test failed: install.sh missing from the package root")
    }
    console.log("  ✓ install.sh shipped in the package root")
  } finally {
    await rm(unpack, { recursive: true, force: true })
  }
}

await main()
