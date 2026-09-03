import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  // altimate_change — the continuation command follows the Altimate CLI branding
  expect(epilogue).toContain("altimate -s ses_123")
})
