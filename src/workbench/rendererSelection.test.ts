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

test("copy-on-select is disabled — copying is Ctrl+C only", () => {
  expect(COPY_ON_SELECT).toBe(false)
})

test("a non-empty selection is cached but NOT auto-copied to the clipboard", () => {
  const writeSpy = spyOn(clipboard, "write").mockResolvedValue(undefined)
  try {
    handleRendererSelection(selectionOf("diff line text"))

    expect(writeSpy).not.toHaveBeenCalled()
    expect(getLastRendererSelection()).toBe("diff line text")
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
