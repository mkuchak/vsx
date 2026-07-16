#!/usr/bin/env bun
// Rehearses `bun test` under conditions that approximate GitHub Actions'
// ubuntu-latest runner (private repos: 2 vCPU) before pushing to main, where
// every feat/fix/perf commit triggers an auto-versioning release gated on CI.
//
// Why this exists: a real bug (a movement-guard latch in EditorPane's blame
// positioning) failed CI 5/5 times while passing on every local run — dev
// machines here have far more CPU headroom than the runner, so a mount-time
// layout-settling race that's near-certain on 2 vCPU is near-impossible on 12.
// `CI=true` also matters: Bun's GitHub Actions annotation reporter changes
// output cadence, which (combined with the CPU cap) was REQUIRED to reproduce
// the failure locally — neither factor alone did. See the investigation this
// script follows from for the full root-cause writeup.
//
// This is a rehearsal, not a replacement for real CI — it narrows the gap
// between "passes on my machine" and "passes on the runner," it doesn't close
// it. `taskset` is Linux-only; on other platforms this degrades to CI=true
// alone (still worth running, just less representative) with a warning.
import { $ } from "bun"

const requestedRuns = Number(process.argv[2] ?? process.env.CI_PARITY_RUNS ?? 3)
if (!Number.isInteger(requestedRuns) || requestedRuns < 1) {
  console.error(`Invalid run count: ${process.argv[2]} (must be a positive integer)`)
  process.exit(1)
}
const RUNS = requestedRuns

async function hasTaskset(): Promise<boolean> {
  try {
    await $`which taskset`.quiet()
    return true
  } catch {
    return false
  }
}

async function main() {
  const canPinCpu = process.platform === "linux" && (await hasTaskset())
  if (!canPinCpu) {
    console.warn(
      "⚠ taskset unavailable (not Linux, or not installed) — running with CI=true only.\n" +
        "  This is NOT full parity with GitHub Actions' 2-vCPU runner; a pass here is weaker\n" +
        "  evidence than a pass on Linux with taskset. See the script header for why both matter.",
    )
  }

  console.log(`Rehearsing CI parity: ${RUNS} run(s)${canPinCpu ? " under CI=true + 2 vCPU" : " under CI=true"}\n`)

  const failures: number[] = []
  for (let i = 1; i <= RUNS; i++) {
    console.log(`── run ${i}/${RUNS} ──`)
    const env = { ...process.env, CI: "true" }
    const cmd = canPinCpu ? $`taskset -c 0,1 bun test`.env(env) : $`bun test`.env(env)
    const result = await cmd.nothrow()
    if (result.exitCode !== 0) {
      failures.push(i)
      console.log(`  ✗ run ${i} FAILED (exit ${result.exitCode})`)
    } else {
      console.log(`  ✓ run ${i} passed`)
    }
  }

  console.log("")
  if (failures.length > 0) {
    console.error(`✗ ${failures.length}/${RUNS} run(s) failed: ${failures.join(", ")}`)
    console.error("  Re-run the specific failing test in isolation, then under this same")
    console.error("  taskset/CI=true combination, to characterize whether it's a real bug")
    console.error("  or a timing-fragile test before pushing.")
    process.exit(1)
  }
  console.log(`✓ ${RUNS}/${RUNS} runs passed — safe to push.`)
}

await main()
