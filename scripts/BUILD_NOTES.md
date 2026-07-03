# Release build notes

`bun run build:release` (`scripts/build-release.ts`) produces the vsx release
artifact. This file records why the artifact is a **runtime package** and not a
true single binary, with the evidence from the `bun build --compile` spike.

## Chosen artifact shape: runtime package

One platform-independent tarball serves all four targets
(linux-x64, linux-arm64, darwin-x64, darwin-arm64):

- `dist/vsx-<version>.tar.gz` — contains `src/`, `assets/`, `package.json`,
  `bun.lock`, `README.md`, and a `bin/vsx` POSIX-sh launcher that
  `exec bun <unpacked>/src/main.tsx "$@"`.
- `dist/SHA256SUMS` — `shasum -a 256 -c`-verifiable checksum of the tarball.

`node_modules` is deliberately **not** shipped: `@opentui/core` pulls a
platform-specific native package (e.g. `@opentui/core-darwin-arm64` carrying
`libopentui.dylib`). The installer unpacks to `~/.vsx/<version>/`, runs
`bun install --production --frozen-lockfile` there (which pulls the correct
native dep for the target), and symlinks `bin/vsx` onto `PATH`. Because the
native code is installed on the target, a single tarball is platform-independent.

The launcher resolves its own real path through the PATH symlink (a `readlink`
loop) so `../src/main.tsx` always points inside `~/.vsx/<version>/`.

## Phase 1 spike: `bun build --compile` (attempted, rejected)

Command: `bun build --compile --target=bun-darwin-arm64 src/main.tsx --outfile
dist/vsx-darwin-arm64` (Bun 1.2.3, @opentui/core 0.4.2).

The compile itself **succeeds** and produces a 64 MB binary. `--version` works
(it exits before the renderer). Two of the three known blockers were probed
directly with a headless harness that boots the real tree-sitter worker and calls
`highlightOnce` on TypeScript (OpenTUI's bundled grammar) and JSON (a vendored
`assets/grammars/*` wasm + `highlights.scm`).

### Blocker 1 — native Zig FFI library: NOT a blocker ✓

OpenTUI already handles the compiled case. `@opentui/core-<platform>` exposes a
`"bun"` export condition (`index.bun.js`) that does
`import("./libopentui.dylib", { with: { type: "file" } })`, so `bun --compile`
embeds the dylib and Bun extracts it to a `/$bunfs/…` path at runtime. Core's
loader explicitly special-cases `isBunfsPath(targetLibPath)` before `dlopen`.
Evidence: the compiled binary boots the renderer (a real-PTY run drew ~16 KB of
screen output with no FFI error), and the headless harness constructs the FFI
client without error.

### Blocker 2 — tree-sitter worker: FATAL ✗ (this is why Phase 1 was rejected)

`src/main.tsx` points OpenTUI at the worker via a runtime env-var **path string**
(`OTUI_TREE_SITTER_WORKER_PATH = fileURLToPath(new URL("./treeSitterWorkerShim.ts",
import.meta.url))`), and OpenTUI's `TreeSitterClient` does `new Worker(workerPath)`
with that string. Bun's compiler can only embed a worker via a statically
analyzable `new Worker(new URL("./x.ts", import.meta.url))` — it cannot embed a
module named by a runtime string, so the shim is never bundled. Running the
compiled headless harness:

```
TypeError: BuildMessage: ModuleNotFound resolving "/$bunfs/src/treeSitterWorkerShim.ts" (entry point)
    at startWorker (/$bunfs/root/_probe:4773:20)
    at new TreeSitterClient (/$bunfs/root/_probe:4749:23)
```

Under normal `bun run` the same harness prints `OK typescript: 9 spans` /
`OK json: 7 spans`, so the failure is specific to `--compile`. This matches the
known upstream issue (anomalyco/opentui #807, tree-sitter broken under bun
compile). Without the worker, every file renders unhighlighted — a core feature
is dead.

### Blocker 3 — wasm + highlights.scm assets: also unresolved (masked by #2)

Grammar assets are read via `readFile` at absolute paths computed at runtime
(`grammarAsset` → `fileURLToPath(new URL("../assets/grammars/…", import.meta.url))`,
and OpenTUI's own `assets/*` similarly). `bun --compile` only embeds files that
are statically imported or imported with `{ type: "file" }`; a `readFile` of a
computed path is not embedded, so these would `ENOENT` at runtime. This is moot
in practice because the assets are read *inside* the worker, which never boots
(blocker 2) — but it is a second independent reason the binary can't highlight.

## Upgrade path to a true binary later

A compiled binary becomes viable if the worker and assets are made loadable:

1. **Worker**: either (a) OpenTUI fixes `loadWorkerRuntime`/exposes a statically
   embeddable worker entry (tracking #807), or (b) we self-extract a pre-bundled
   worker (shim + `@opentui/core/parser.worker` + web-tree-sitter wasm) to
   `~/.vsx/support/<version>/` on first run and point `OTUI_TREE_SITTER_WORKER_PATH`
   there. (b) is real work and still rides on #807 behaving, so it was left out of
   this timeboxed spike.
2. **Assets**: ship `assets/grammars/*` and OpenTUI's `assets/*` next to the
   binary (or self-extract them alongside the worker) and repoint the path
   resolvers at the extracted location.

Once both hold, `scripts/build-release.ts` can grow a `--compile` mode emitting
four `vsx-<os>-<arch>` binaries instead of the tarball, keeping the same
`SHA256SUMS` + smoke-check scaffolding.
