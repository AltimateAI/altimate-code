// altimate_change — checkpoint 8h bug fix. Found via a live repro: with the backend
// unreachable, WorkspaceLinkApi/WorkspaceBackendApi surfaced the raw runtime connect-error
// message verbatim, with no URL and no indication of what to check. Covers the shared
// formatter directly, plus the two real call sites against a genuinely unreachable port.
import { expect, test } from "bun:test"
import { describeFetchError } from "../../../src/altimate/workspace-link/fetch-error"
import { WorkspaceLinkApi, WorkspaceLinkRequestError } from "../../../src/altimate/workspace-link/api-client"
import { WorkspaceBackendApi } from "../../../src/altimate/workspace-link/workspace-backend-client"

const UNREACHABLE = "http://127.0.0.1:1" // port 1 — nothing listens there, connection refused fast

test("describeFetchError includes the URL and asks whether the backend is running, for a generic connection failure", () => {
  const message = describeFetchError(UNREACHABLE, new Error("Unable to connect. Is the computer able to access the url?"))
  expect(message).toContain(UNREACHABLE)
  expect(message).toContain("Is it running?")
})

test("describeFetchError produces a distinct message for a genuine timeout, given a timeoutMs", () => {
  const abortErr = Object.assign(new Error("The operation was aborted."), { name: "AbortError" })
  const message = describeFetchError(UNREACHABLE, abortErr, 15_000)
  expect(message).toContain(UNREACHABLE)
  expect(message).toContain("timed out after 15s")
})

test("WorkspaceLinkApi.poll against an unreachable backend throws a URL-inclusive, actionable error — not the raw runtime message alone", async () => {
  process.env["ALTIMATE_WORKSPACE_LINK_API_URL"] = UNREACHABLE
  try {
    await expect(WorkspaceLinkApi.poll("link_x", "token_x")).rejects.toThrow(WorkspaceLinkRequestError)
    try {
      await WorkspaceLinkApi.poll("link_x", "token_x")
      throw new Error("unreachable")
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceLinkRequestError)
      const message = (err as Error).message
      expect(message).toContain(UNREACHABLE)
      expect(message).toContain("Is it running?")
    }
  } finally {
    delete process.env["ALTIMATE_WORKSPACE_LINK_API_URL"]
  }
})

test("WorkspaceBackendApi.createMemoryEntry against an unreachable backend throws a URL-inclusive error", async () => {
  process.env["ALTIMATE_WORKSPACE_LINK_API_URL"] = UNREACHABLE
  try {
    await WorkspaceBackendApi.createMemoryEntry("ws_x", "token_x", { type: "preference", text: "x", source: "test" })
    throw new Error("unreachable")
  } catch (err) {
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain(UNREACHABLE)
    expect(message).toContain("Is it running?")
  } finally {
    delete process.env["ALTIMATE_WORKSPACE_LINK_API_URL"]
  }
})
