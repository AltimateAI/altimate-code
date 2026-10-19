// Requested aborts (Stop/Esc, dispose, harness challenge abort) surface from the
// streaming catch as MessageAbortedError after the session's abort signal fired.
// They are recorded as the session's "aborted" outcome and must not be reported
// as `error` / context "streaming" telemetry. Aborts the session did not request
// and real streaming failures still must be.
import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { ProviderID } from "../../src/provider/schema"

const providerID = ProviderID.make("test")

function abortError() {
  const controller = new AbortController()
  controller.abort()
  return controller.signal.reason
}

describe("SessionProcessor.shouldTrackStreamingError", () => {
  test("a stream aborted by the session's own signal is not tracked", () => {
    const error = MessageV2.fromError(abortError(), { providerID })
    expect(error.name).toBe("MessageAbortedError")
    expect(SessionProcessor.shouldTrackStreamingError(error, true)).toBe(false)
  })

  test("a decompression failure after a requested abort is not tracked either", () => {
    const e = Object.assign(new Error("zlib"), { code: "ZlibError" })
    const error = MessageV2.fromError(e, { providerID, aborted: true })
    expect(error.name).toBe("MessageAbortedError")
    expect(SessionProcessor.shouldTrackStreamingError(error, true)).toBe(false)
  })

  test("an abort the session did not request is still tracked", () => {
    const error = MessageV2.fromError(abortError(), { providerID })
    expect(error.name).toBe("MessageAbortedError")
    expect(SessionProcessor.shouldTrackStreamingError(error, false)).toBe(true)
  })

  test("genuine streaming failures are still tracked", () => {
    for (const e of [new Error("boom"), Object.assign(new Error("reset"), { code: "ECONNRESET" })]) {
      const error = MessageV2.fromError(e, { providerID })
      expect(error.name).not.toBe("MessageAbortedError")
      expect(SessionProcessor.shouldTrackStreamingError(error, false)).toBe(true)
      expect(SessionProcessor.shouldTrackStreamingError(error, true)).toBe(true)
    }
  })
})
