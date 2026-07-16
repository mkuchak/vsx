import type { CliRenderer } from "@opentui/core"

/**
 * Destroys a test renderer and waits for teardown to actually finish before
 * returning, instead of the fire-and-forget `renderer.destroy()` every test
 * file used to call directly.
 *
 * `destroy()` is NOT synchronous when the renderer is mid-render at the exact
 * moment it's called: it only stages teardown (an internal `_destroyPending`
 * flag) and defers the real work — unmounting the React tree, removing frame
 * callbacks, clearing timers — to whenever the in-flight render's own loop
 * notices the pending flag and finalizes, emitting a `"destroy"` event. On a
 * fast, idle machine this finalizes near-instantly, masking the gap. Under a
 * slower or more loaded environment, the NEXT test's `beforeEach`/render can
 * start while the previous test's textarea/frame-callback/timers are still
 * alive — a stale callback then fires against an already-torn-down view, or
 * silently intercepts a frame meant for the new test.
 *
 * This function is also safe to call on an already-finalized renderer (e.g. a
 * test that pressed Ctrl+C with `exitOnCtrlC` enabled, which self-destroys):
 * `destroy()` no-ops without re-emitting `"destroy"` once `_isDestroyed` is
 * set, so a naive `renderer.once("destroy", resolve); renderer.destroy()`
 * would hang forever waiting for an event that already fired. Checking
 * `_destroyFinalized` first (a private field OpenTUI doesn't expose publicly)
 * closes that gap.
 */
export async function destroyRendererAndWait(renderer: CliRenderer): Promise<void> {
  const internal = renderer as unknown as { _destroyFinalized: boolean }
  if (internal._destroyFinalized) return
  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve())
    renderer.destroy()
  })
}
