/**
 * macOS clipboard bridge for the editor. Copy is belt-and-braces: a best-effort
 * OSC 52 write (so a copy can reach the host clipboard over SSH when the
 * terminal supports it) plus an always-attempted `pbcopy` (the reliable local
 * path). Read goes solely through `pbpaste` — OSC 52 read-back is disabled by
 * most terminals for security, so it is never attempted. Every failure is soft:
 * a clipboard hiccup must never throw into the render loop and crash the editor.
 */

/**
 * The slice of the renderer that `write` needs for OSC 52. Kept structural so
 * this module stays free of any OpenTUI import; callers pass the CliRenderer.
 */
export interface Osc52Writer {
  copyToClipboardOSC52: (text: string) => boolean
  isOsc52Supported: () => boolean
}

export async function write(text: string, renderer?: Osc52Writer): Promise<void> {
  if (renderer?.isOsc52Supported()) {
    try {
      renderer.copyToClipboardOSC52(text)
    } catch {
      // Best-effort: an OSC 52 failure still leaves the pbcopy path below.
    }
  }

  try {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
    proc.stdin.write(text)
    await proc.stdin.end()
    await proc.exited
  } catch {
    // Soft failure: a broken pbcopy must not crash the editor.
  }
}

export async function read(): Promise<string> {
  try {
    const proc = Bun.spawn(["pbpaste"], { stdout: "pipe", stderr: "ignore" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return text
  } catch {
    // Soft failure: treat an unreadable clipboard as empty.
    return ""
  }
}
