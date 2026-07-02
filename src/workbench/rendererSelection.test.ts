import { afterEach, expect, spyOn, test } from "bun:test"
import * as clipboard from "../services/clipboard"
import {
  COPY_ON_SELECT,
  getLastRendererSelection,
  handleRendererSelection,
} from "./rendererSelection"

/** A stub of the renderer's Selection payload returning fixed text. */
function selectionOf(text: string) {
  return { getSelectedText: () => text }
}

afterEach(() => {
  // Reset the module-level cache between tests (an empty selection clears it).
  handleRendererSelection(selectionOf(""))
})

test("copy-on-select is enabled by default", () => {
  expect(COPY_ON_SELECT).toBe(true)
})

test("a non-empty selection is copied to the clipboard and cached", () => {
  const writeSpy = spyOn(clipboard, "write").mockResolvedValue(undefined)
  try {
    handleRendererSelection(selectionOf("diff line text"))

    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy.mock.calls[0][0]).toBe("diff line text")
    expect(getLastRendererSelection()).toBe("diff line text")
  } finally {
    writeSpy.mockRestore()
  }
})

test("the renderer is forwarded to clipboard.write for the OSC 52 path", () => {
  const writeSpy = spyOn(clipboard, "write").mockResolvedValue(undefined)
  const renderer = { copyToClipboardOSC52: () => true, isOsc52Supported: () => true }
  try {
    handleRendererSelection(selectionOf("x"), renderer)
    expect(writeSpy.mock.calls[0][1]).toBe(renderer)
  } finally {
    writeSpy.mockRestore()
  }
})

test("an empty selection clears the cache and does not write", () => {
  const writeSpy = spyOn(clipboard, "write").mockResolvedValue(undefined)
  try {
    handleRendererSelection(selectionOf("cached"))
    expect(getLastRendererSelection()).toBe("cached")

    writeSpy.mockClear()
    handleRendererSelection(selectionOf(""))

    expect(getLastRendererSelection()).toBe("")
    expect(writeSpy).not.toHaveBeenCalled()
  } finally {
    writeSpy.mockRestore()
  }
})
