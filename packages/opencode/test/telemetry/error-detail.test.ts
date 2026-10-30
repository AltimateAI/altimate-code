import { describe, expect, test } from "bun:test"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

const { buildErrorFingerprintEvent, describeToolError, templateErrorMessage, ERROR_VOCABULARY, CREDENTIAL_WORDS } =
  ErrorDetail

describe("templateErrorMessage", () => {
  test.each([
    ["Cannot delete file: permission denied", "cannot delete file permission denied"],
    ["connection refused", "connection refused"],
    ["column ssn_number does not exist in table hr.salaries", "column <x> number does not exist in table <x>"],
    ["Request failed with status 502", "request failed with status"],
  ])("readable: %s", (raw, expected) => {
    expect(templateErrorMessage(raw)).toBe(expected)
  })

  test.each([...CREDENTIAL_WORDS])("masks vocabulary words after %s", (word) => {
    expect(templateErrorMessage(`request failed with ${word}: connection refused`)).toBe("request failed with <x>")
  })

  test.each([
    ["password is connection refused", "<x>"],
    ["password=wrong user", "<x>"],
    ["connection failed: PaSsWoRd=wrong user", "connection failed <x>"],
    ['request failed: "password": "connection refused"', "request failed <x>"],
    ["request failed: api_key=wrong user", "request failed <x>"],
    ["request failed: access-token=connection refused", "request failed access <x>"],
    ["request failed: opaque password=wrong user", "request failed <x>"],
    ["password", "<x>"],
    ["password=1234 !!!", "<x>"],
  ])("masks the credential suffix: %s", (raw, expected) => {
    expect(templateErrorMessage(raw)).toBe(expected)
  })

  test("matches whole credential words rather than substrings", () => {
    expect(templateErrorMessage("keychain keyboard monkey tokenizer failed connection refused")).toBe(
      "<x> failed connection refused",
    )
  })

  test.each([
    "apikey",
    "apiKey",
    "accessToken",
    "authToken",
    "refreshToken",
    "bearerToken",
    "jwtToken",
    "jwtSecret",
    "clientSecret",
    "appSecret",
    "signature",
    "sig",
    "pass",
    "passwords",
    "secretKey",
    "sessionId",
    "connectionString",
    "privatekey",
    "privateKey",
    "PRIVATEKEY",
  ])("masks the exact credential alias %s", (key) => {
    expect(templateErrorMessage(`request failed: ${key}=wrong user`)).toBe("request failed <x>")
    expect(templateErrorMessage(`${key}: connection refused`)).toBe("<x>")
  })

  test.each([
    "request failed: connection_string=wrong user",
    "request failed: CONNECTION_STRING: connection refused",
    'request failed: "connection_string": "wrong user"',
    "request failed: connection-string=wrong user",
    "request failed: connection_\x1b[31mstring=wrong user",
  ])("masks the exact connection string key: %j", (raw) => {
    expect(templateErrorMessage(raw)).toBe("request failed <x>")
  })

  test.each([
    ["DATABASE_CONNECTION_STRING=wrong user", "database <x>"],
    ["db_connection_string=wrong user", "<x>"],
    ["connection_string_value=wrong user", "<x>"],
    ["request failed: DB_Connection_String_Value=connection refused", "request failed <x>"],
    ["request failed: 123connection_string456=wrong user", "request failed <x>"],
    ["request failed: _connection-string_=wrong user", "request failed <x>"],
    ["request failed: éconnection_string中=wrong user", "request failed <x>"],
    ["request failed: \x1b[31mDATABASE_CONNECTION_STRING\x1b[0m=wrong user", "request failed database <x>"],
    ["request failed: db_connection_string_value=wrong user", "request failed <x>"],
  ])("uses tokenizer boundaries for connection string keys: %j", (raw, expected) => {
    expect(templateErrorMessage(raw)).toBe(expected)
  })

  test.each([
    ["connection string=wrong user", "<x>"],
    ["connection string:wrong user", "<x>"],
    ["connection string: invalid", "<x>"],
    ["request failed: connection string=wrong user", "request failed <x>"],
    ["request failed: Connection String : connection refused", "request failed <x>"],
    ["request failed: CONNECTION\tSTRING\t=\twrong user", "request failed <x>"],
    ["request failed: connection  string   = connection refused", "request failed <x>"],
    ['request failed: "connection string" = "wrong user"', "request failed <x>"],
    ["request failed: 'connection string': 'wrong user'", "request failed <x>"],
    ["request failed: `connection string` = wrong user", "request failed <x>"],
    ["request failed: \x1b[31mconnection string\x1b[0m=wrong user", "request failed <x>"],
    ["request failed: connec\x1b[31mtion str\x1b[0ming=wrong user", "request failed <x>"],
  ])("masks spaced connection string assignments: %j", (raw, expected) => {
    expect(templateErrorMessage(raw)).toBe(expected)
  })

  test.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
    "keeps spaced key assignments on the first line: %j",
    (newline) => {
      expect(templateErrorMessage(`connection${newline}string=wrong user`)).toBe("connection")
      expect(templateErrorMessage(`connection string${newline}=wrong user`)).toBe("connection string")
      expect(templateErrorMessage(`connection string: wrong user${newline}connection refused`)).toBe("<x>")
    },
  )

  test.each([
    ["connection string is invalid", "connection string is invalid"],
    ["connection string", "connection string"],
    ["connection string invalid", "connection string invalid"],
    ['"connection string" is invalid', "connection string is invalid"],
    ["disconnection string=wrong user", "<x> string wrong user"],
    ["connection stringify=wrong user", "connection <x> wrong user"],
    ["connection strings: invalid", "connection <x> invalid"],
    ["connection refused", "connection refused"],
    ["signal received", "signal received"],
    ["connection_stringify is invalid", "connection <x> is invalid"],
    ["disconnection_string is invalid", "<x> string is invalid"],
    ["connection_strings are invalid", "connection <x> are invalid"],
    ["db_disconnection_string is invalid", "<x> string is invalid"],
    ["db_connection_stringify is invalid", "<x> connection <x> is invalid"],
    ["connection_strings_value is invalid", "connection <x> value is invalid"],
    ["privatekeyboard apikeyboard sigil signatured tokenizer failed", "<x> failed"],
  ])("keeps diagnostics without an exact credential marker: %s", (raw, expected) => {
    expect(templateErrorMessage(raw)).toBe(expected)
  })

  test.each([
    "request failed: \x1b[31mpassword\x1b[0m=wrong user",
    "request failed: pass\x1b[31mword=wrong user",
    "request failed: api\x1b[31mKey=wrong user",
    "request failed: \x1b[1;31mpassword\x1b[0m=connection refused",
    "request failed: \x1b]8;;https://example.test\x07password\x1b]8;;\x07=wrong user",
    "request failed: \x9b31mpassword\x9b0m=wrong user",
  ])("ignores ANSI sequences when matching credentials: %j", (raw) => {
    expect(templateErrorMessage(raw)).toBe("request failed <x>")
  })

  test("keeps diagnostic words inside ANSI styling", () => {
    expect(templateErrorMessage("connection \x1b[31mrefused\x1b[0m")).toBe("connection refused")
  })

  test.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])("does not let an OSC sequence consume %j", (newline) => {
    expect(templateErrorMessage(`first line \x1b]8;;${newline}\x07wrong user`)).toBe("first line")
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
    for (const w of CREDENTIAL_WORDS) expect(out.split(" ")).not.toContain(w)
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

  test.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])("does not inspect later lines after %j", (newline) => {
    expect(templateErrorMessage(`connection refused${newline}password is wrong user`)).toBe("connection refused")
    expect(templateErrorMessage(`password is wrong user${newline}connection refused`)).toBe("<x>")
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

  test.each([
    "request failed: password is connection refused",
    "request failed: \x1b[31mpassword\x1b[0m is connection refused",
  ])("credential suffix is hidden in the event without changing the hash: %j", (raw) => {
    const detail = describeToolError(raw)
    const event = buildErrorFingerprintEvent("s1", {
      ...detail,
      errorClass: "unknown",
      toolName: "bash",
      toolCategory: "shell",
      recovered: false,
      recoveryTool: "",
    })
    expect(event).toMatchObject({
      error_message: "request failed <x>",
      error_hash: "ae7e754cfb2d72a2",
    })
  })

  test("prompt.ts emits through these helpers", async () => {
    const src = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
    expect(src).toContain("...ErrorDetail.describeToolError(errorMsg)")
    expect(src).toContain("Telemetry.track({ ...ErrorDetail.buildErrorFingerprintEvent(sessionID, err), ...turnWorkspace })")
  })
})
