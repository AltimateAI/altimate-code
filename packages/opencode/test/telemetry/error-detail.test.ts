import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

const { buildErrorFingerprintEvent, describeToolError, templateErrorMessage } = ErrorDetail
// built at runtime so no credential-shaped literal is committed
const basicAuth = Buffer.from(["adm", "pw"].join(":")).toString("base64")
const pgUri = ["postgres:", "//", "u", ":", "p", "@db:5432/x"].join("")

describe("templateErrorMessage", () => {
  test.each([
    ["column ssn_number does not exist in table hr.salaries", "column <x> does not exist in table <x>"],
    ["password: hunter2", "password: <x>"],
    ["Cannot delete file: permission denied", "Cannot delete file: permission denied"],
    ["failed (code 12)!", "failed (code <x>)!"],
  ])("%s", (raw, expected) => {
    expect(templateErrorMessage(raw)).toBe(expected)
  })

  test("Basic auth header keeps no secret", () => {
    const out = templateErrorMessage(`Authorization: Basic ${basicAuth}`)
    expect(out).toBe("Authorization: <x>")
  })

  test("unquoted SQL keeps no identifiers, numbers or names", () => {
    const out = templateErrorMessage("SELECT ssn FROM prod.hr.salaries WHERE id = 4417 AND name = Alice")
    for (const leak of ["prod", "hr.salaries", "4417", "Alice"]) expect(out).not.toContain(leak)
  })

  test.each([
    "bob@acme.com",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig",
    "deadbeefdeadbeefdeadbeefdeadbeef0123",
    "'hunter2' \"s3cret\"",
    "stg_salesforce_history_2024.sql",
  ])("replaces identifier-like token in %s", (raw) => {
    const out = templateErrorMessage(`bad ${raw} here`)
    expect(out).toBe("bad <x> here")
  })

  test.each([
    ["login failed password: supersecret", "login failed password: <x>"],
    ["Authorization: Bearer secrettoken", "Authorization: <x>"],
    ["bad api key hunter, retry", "bad api key <x>"],
    ["unknown column `customer name` in field list", "unknown column <x>"],
    ["bad value \u201cprivate customer phrase\u201d here", "bad value <x>"],
    ["bad \u00abprivate phrase\u00bb here", "bad <x>"],
    ["bad /Users/bob/proj/a.ts here", "bad <x>"],
    ["bad C:\\Users\\bob\\a.ts here", "bad <x>"],
    [`bad ${pgUri} here`, "bad <x>"],
    ['bad "password": hunter here', "bad password: <x>"],
    ['open "C:\\Program Files\\acme corp\\a.ts" failed', "open <x>"],
    ["open /home/x/my customer name/a.ts failed", "open <x>"],
    ['value "a \\" customer name" bad', "value <x>"],
    ["fetch https://h.example.com/p?token=zzz failed", "fetch <x>"],
    ["auth failed: client_secret: abc def ghi", "auth <x>"],
    ["bad access_token=hunter two three", "bad <x>"],
    ["password correct horse battery staple", "password <x>"],
    ["login failed for passphrase correct horse battery staple", "login failed for passphrase <x>"],
    ["client_secret: supersecret", "<x>"],
    ["access_token: secrettoken", "<x>"],
    ["api-key: secretvalue", "<x>"],
    ["password: correct horse battery staple", "password: <x>"],
    ["Alice does not have access", "<x> does not have access"],
    ["failed\raccount alice unavailable", "failed"],
    ["Error: value 'private customer phrase is invalid", "Error: value <x>"],
    ["xKqPzLmNaBcD failed", "<x> failed"],
    ["DROP TABLE prod.customer_records", "<x>"],
  ])("masks alphabetic credential values in %s", (raw, expected) => {
    expect(templateErrorMessage(raw)).toBe(expected)
  })

  test("only the first line, capped at 200 chars", () => {
    expect(templateErrorMessage("first line\nsecond line")).toBe("first line")
    expect(templateErrorMessage("word ".repeat(200)).length).toBeLessThanOrEqual(200)
  })
})

describe("error_fingerprint wiring", () => {
  const raw = "column ssn_number does not exist in table hr.salaries\n    at run (/w/packages/opencode/src/a.ts:1:1)"

  test("error_hash is identical to the pre-existing computation", () => {
    expect(describeToolError(raw).errorHash).toBe("3a0bc6389647e452")
  })

  test("event carries the template", () => {
    const d = describeToolError(raw)
    const base = {
      ...d,
      errorClass: "unknown",
      toolName: "bash",
      toolCategory: "shell",
      recovered: false,
      recoveryTool: "",
    }
    const ev: any = buildErrorFingerprintEvent("s1", base)
    expect(ev.type).toBe("error_fingerprint")
    expect(ev.error_message).toBe("column <x> does not exist in table <x>")
    expect(ev.error_hash).toBe(d.errorHash)
    expect("stack" in ev).toBe(false)
  })

  test("prompt.ts emits through these helpers", async () => {
    const src = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
    expect(src).toContain("...ErrorDetail.describeToolError(errorMsg)")
    expect(src).toContain("Telemetry.track(ErrorDetail.buildErrorFingerprintEvent(sessionID, err))")
  })
})
