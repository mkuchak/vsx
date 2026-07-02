import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { moveToTrash, TrashError } from "./trash"

type SpawnResult = {
  exited: Promise<number>
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
}

type Handler = (argv: string[]) => { code: number; stderr?: string }

let calls: string[][] = []

function installSpawn(handler: Handler) {
  return spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
    calls.push(cmd)
    const { code, stderr = "" } = handler(cmd)
    return {
      exited: Promise.resolve(code),
      stdout: new Response("").body,
      stderr: new Response(stderr).body,
    } as SpawnResult
  }) as unknown as typeof Bun.spawn)
}

afterEach(() => {
  calls = []
  mock.restore()
})

test("no-ops (no spawn) when given an empty path list", async () => {
  const spy = installSpawn(() => ({ code: 0 }))
  await moveToTrash([])
  expect(spy).not.toHaveBeenCalled()
})

test("uses the `trash` CLI when present and succeeds", async () => {
  installSpawn((argv) => {
    if (argv[0] === "which") return { code: 0 }
    if (argv[0] === "trash") return { code: 0 }
    return { code: 1 }
  })

  await moveToTrash(["/repo/a.txt", "/repo/b.txt"])

  expect(calls).toEqual([
    ["which", "trash"],
    ["trash", "/repo/a.txt", "/repo/b.txt"],
  ])
})

test("falls back to osascript when the `trash` CLI is absent", async () => {
  installSpawn((argv) => {
    if (argv[0] === "which") return { code: 1 } // trash not on PATH
    if (argv[0] === "osascript") return { code: 0 }
    return { code: 1 }
  })

  await moveToTrash(["/repo/a.txt", "/repo/b.txt"])

  expect(calls[0]).toEqual(["which", "trash"])
  expect(calls[1]).toEqual([
    "osascript",
    "-e",
    'tell application "Finder" to delete POSIX file "/repo/a.txt"',
  ])
  expect(calls[2]).toEqual([
    "osascript",
    "-e",
    'tell application "Finder" to delete POSIX file "/repo/b.txt"',
  ])
})

test("falls back to osascript when the `trash` CLI is present but fails", async () => {
  installSpawn((argv) => {
    if (argv[0] === "which") return { code: 0 }
    if (argv[0] === "trash") return { code: 1 } // CLI failed
    if (argv[0] === "osascript") return { code: 0 }
    return { code: 1 }
  })

  await moveToTrash(["/repo/a.txt"])

  expect(calls.map((c) => c[0])).toEqual(["which", "trash", "osascript"])
})

test("escapes quotes and backslashes in the AppleScript string literal", async () => {
  installSpawn((argv) => {
    if (argv[0] === "which") return { code: 1 }
    return { code: 0 }
  })

  await moveToTrash(['/repo/we"ird\\name.txt'])

  expect(calls[1]).toEqual([
    "osascript",
    "-e",
    'tell application "Finder" to delete POSIX file "/repo/we\\"ird\\\\name.txt"',
  ])
})

test("throws TrashError when both the CLI and osascript fail", async () => {
  installSpawn((argv) => {
    if (argv[0] === "which") return { code: 1 }
    if (argv[0] === "osascript") return { code: 1, stderr: "not allowed" }
    return { code: 1 }
  })

  await expect(moveToTrash(["/repo/a.txt"])).rejects.toBeInstanceOf(TrashError)
})
