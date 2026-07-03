// Tree-sitter parser-worker entry point that works around a Bun 1.2.3 bug so
// syntax highlighting can boot at all.
//
// THE BUG: inside a Worker thread, Bun 1.2.3's
// `process.getBuiltinModule("node:worker_threads")` returns a STUB whose
// `parentPort` is null. OpenTUI's parser worker detects its runtime with that
// call (loadWorkerRuntime); the parentPort branch fails on the stub and the
// global-worker fallback fails too (`globalThis.close` isn't a function in Bun
// workers), so `isWorkerRuntime` is false, the worker registers no message
// handler, nothing refs the event loop, and it exits ~13ms after boot. The
// client's init then times out after 10s and every highlightOnce returns an
// initialization error — which is why every file rendered white.
//
// THE FIX: a real static `import` of node:worker_threads DOES return the live
// module (with a working parentPort) in Bun workers — only getBuiltinModule is
// stubbed. So patch getBuiltinModule to hand back the real module for that id,
// THEN load OpenTUI's real parser worker. It takes the parentPort branch, which
// both keeps the worker alive and (verified) survives this file's top-level
// await. Do NOT switch to the globalThis.onmessage path: it does not survive a
// top-level await and the worker would still exit early.
//
// REMOVABLE once OpenTUI fixes loadWorkerRuntime upstream or a Bun upgrade makes
// getBuiltinModule return the real module inside workers (neither true as of
// Bun 1.2.3 / @opentui/core 0.4.2, the latest stable).
import * as realWorkerThreads from "node:worker_threads"

const originalGetBuiltinModule = process.getBuiltinModule?.bind(process)
process.getBuiltinModule = ((id: string) =>
  id === "node:worker_threads" || id === "worker_threads"
    ? realWorkerThreads
    : originalGetBuiltinModule?.(id)) as typeof process.getBuiltinModule

await import("@opentui/core/parser.worker")
