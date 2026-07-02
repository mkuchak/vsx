import { afterEach, expect, mock, spyOn, test } from "bun:test"
import * as clipboard from "./clipboard"

type SpawnCall = { cmd: string[]; stdinWrites: string[] }

let calls: SpawnCall[] = []

/**
 * Replace `Bun.spawn` so no test ever touches the developer's real clipboard.
 * Records the argv and everything written to a process's stdin per call.
 */
function installSpawn(opts?: {
  pbpasteOut?: string
  pbcopyCode?: number
  throwOn?: string
}) {
  return spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
    const call: SpawnCall = { cmd, stdinWrites: [] }
    calls.push(call)
    if (opts?.throwOn && cmd[0] === opts.throwOn) throw new Error("spawn failed")
    const code = cmd[0] === "pbcopy" ? (opts?.pbcopyCode ?? 0) : 0
    return {
      stdin: {
        write: (data: string) => {
          call.stdinWrites.push(data)
          return data.length
        },
        end: () => 0,
      },
      stdout: new Response(cmd[0] === "pbpaste" ? (opts?.pbpasteOut ?? "") : "").body,
      exited: Promise.resolve(code),
    }
  }) as unknown as typeof Bun.spawn)
}

function pbcopyCall() {
  return calls.find((c) => c.cmd[0] === "pbcopy")
}

afterEach(() => {
  calls = []
  mock.restore()
})

test("write always spawns pbcopy with the text on stdin (no renderer)", async () => {
  installSpawn()

  await clipboard.write("hello world")

  const call = pbcopyCall()
  expect(call).toBeDefined()
  expect(call!.cmd).toEqual(["pbcopy"])
  expect(call!.stdinWrites.join("")).toBe("hello world")
})

test("write uses the OSC 52 path when supported AND still spawns pbcopy", async () => {
  installSpawn()
  const osc52 = mock((_t: string) => true)
  const renderer = { copyToClipboardOSC52: osc52, isOsc52Supported: () => true }

  await clipboard.write("copy me", renderer)

  expect(osc52).toHaveBeenCalledWith("copy me")
  expect(pbcopyCall()?.stdinWrites.join("")).toBe("copy me")
})

test("write skips OSC 52 when unsupported but still spawns pbcopy", async () => {
  installSpawn()
  const osc52 = mock((_t: string) => true)
  const renderer = { copyToClipboardOSC52: osc52, isOsc52Supported: () => false }

  await clipboard.write("copy me", renderer)

  expect(osc52).not.toHaveBeenCalled()
  expect(pbcopyCall()?.stdinWrites.join("")).toBe("copy me")
})

test("write does not throw when pbcopy exits non-zero", async () => {
  installSpawn({ pbcopyCode: 1 })
  await expect(clipboard.write("x")).resolves.toBeUndefined()
})

test("write does not throw when spawning pbcopy fails outright", async () => {
  installSpawn({ throwOn: "pbcopy" })
  await expect(clipboard.write("x")).resolves.toBeUndefined()
})

test("read returns the pbpaste stdout", async () => {
  installSpawn({ pbpasteOut: "pasted text" })

  const text = await clipboard.read()

  expect(text).toBe("pasted text")
  expect(calls.at(-1)?.cmd).toEqual(["pbpaste"])
})

test("read returns empty string when spawning pbpaste fails", async () => {
  installSpawn({ throwOn: "pbpaste" })
  expect(await clipboard.read()).toBe("")
})
