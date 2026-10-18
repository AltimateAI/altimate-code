import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

const { buildErrorFingerprintEvent, describeToolError, templateErrorMessage, ERROR_VOCABULARY } = ErrorDetail

const CREDENTIAL_WORDS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "key",
  "auth",
  "credential",
  "bearer",
  "cookie",
  "session",
]

describe("templateErrorMessage", () => {
  test.each([
    ["Cannot delete file: permission denied", "cannot delete file permission denied"],
    ["connection refused", "connection refused"],
    ["column ssn_number does not exist in table hr.salaries", "column <x> number does not exist in table <x>"],
    ["Request failed with status 502", "request failed with status"],
  ])("readable: %s", (raw, expected) => {
    expect(templateErrorMessage(raw)).toBe(expected)
  })

  const adversarial = [
    "password: hunter",
    "password: supersecret",
    "Authorization: Bearer secrettoken",
    "client_secret=abcdef api_key: zzz access-token hunter",
    "the passphrase is correct horse battery",
    "`password` is `hunter`",
    "\u201cpassword\u201d: \u201chunter\u201d",
    'say \\"password\\": \\"hunter\\"',
    "cannot open /Users/bob smith/My Projects/Acme Corp/data.csv",
    "C:\\Users\\bob smith\\a.ts failed",
    "SELECT ssn FROM prod.hr.salaries WHERE id = 4417 AND name = Alice",
    "Alice Bob Carol failed",
    "ERROR FAILED CaNnOt",
    "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5",
    "bob@acme.com not found",
    "https://h.example.com/p?token=zzz failed",
    "postgres://admin:S3cret@db:5432/x refused",
    "\u00e9t\u00e9 \u4e2d\u6587 \u0434\u0430\u043d\u043d\u044b\u0435 failed",
    "line one\nsecret line two",
    "line one\u2028secret",
    "AKIAIOSFODNN7EXAMPLE ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  ]

  test.each(adversarial)("only vocabulary words or <x> for %j", (raw) => {
    const out = templateErrorMessage(raw)
    expect(out).toMatch(/^[a-z<>x ]*$/)
    for (const tok of out.split(" ").filter(Boolean)) {
      expect(tok === "<x>" || ERROR_VOCABULARY.has(tok)).toBe(true)
    }
    expect(out).not.toContain("<x> <x>")
    for (const w of CREDENTIAL_WORDS) expect(out).not.toContain(w)
  })

  test("user words never survive", () => {
    const out = templateErrorMessage(adversarial.join(" "))
    for (const leak of ["hunter", "supersecret", "bob", "smith", "acme", "alice", "salaries", "prod"]) {
      expect(out).not.toContain(leak)
    }
  })

  test("vocabulary is sorted and holds no credential words", () => {
    const list = [...ERROR_VOCABULARY]
    expect(list).toEqual([...list].sort())
    for (const w of CREDENTIAL_WORDS) expect(ERROR_VOCABULARY.has(w)).toBe(false)
  })

  test("only the first line, capped at 200 chars", () => {
    expect(templateErrorMessage("first line\nsecond line")).toBe("first line")
    expect(templateErrorMessage("error ".repeat(200)).length).toBeLessThanOrEqual(200)
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
    expect(ev.error_message).toBe("column <x> number does not exist in table <x>")
    expect(ev.error_hash).toBe(d.errorHash)
    expect("stack" in ev).toBe(false)
  })

  test("prompt.ts emits through these helpers", async () => {
    const src = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
    expect(src).toContain("...ErrorDetail.describeToolError(errorMsg)")
    expect(src).toContain("Telemetry.track(ErrorDetail.buildErrorFingerprintEvent(sessionID, err))")
  })
})
