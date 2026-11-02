import { describe, expect, spyOn, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import * as browser from "open"
import { openUrl } from "@opencode-ai/core/open"

describe("openUrl", () => {
  test("opens normalized http(s) URLs and preserves the subprocess promise", async () => {
    const subprocess = new EventEmitter() as ChildProcess
    const promise = Promise.resolve(subprocess)
    const opener = spyOn(browser, "default").mockReturnValue(promise)
    try {
      for (const input of ["HTTP://Example.COM:80/path", "https://example.com/a b"]) {
        const result = openUrl(input)
        expect(result).toBe(promise)
        expect(await result).toBe(subprocess)
        expect(opener).toHaveBeenLastCalledWith(new URL(input).href)
      }
    } finally {
      opener.mockRestore()
    }
  })

  test("rejects values that are not URLs", async () => {
    const opener = spyOn(browser, "default").mockResolvedValue(new EventEmitter() as ChildProcess)
    try {
      await expect(openUrl("not a url")).rejects.toThrow("Only http and https links")
      await expect(openUrl("")).rejects.toThrow("Only http and https links")
      expect(opener).not.toHaveBeenCalled()
    } finally {
      opener.mockRestore()
    }
  })

  test("rejects non-http schemes", async () => {
    const opener = spyOn(browser, "default").mockResolvedValue(new EventEmitter() as ChildProcess)
    try {
      await expect(openUrl("file:///etc/hosts")).rejects.toThrow("Only http and https links")
      await expect(openUrl("javascript:alert(1)")).rejects.toThrow("Only http and https links")
      await expect(openUrl("ms-msdt:/id PCWDiagnostic")).rejects.toThrow("Only http and https links")
      await expect(openUrl("\\\\server\\share\\file.html")).rejects.toThrow("Only http and https links")
      expect(opener).not.toHaveBeenCalled()
    } finally {
      opener.mockRestore()
    }
  })
})
