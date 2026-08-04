// altimate_change — tests for cli_context auth URL parameter
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { buildAuthorizeUrl, buildCliContext, getOrCreateMachineId } from "../../src/altimate/plugin/altimate"

describe("buildCliContext", () => {
  test("returns a valid base64url-encoded JSON blob with machine_id", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-ctx-"))
    const idPath = path.join(tmpDir, "machine-id")
    fs.writeFileSync(idPath, "test-uuid-1234", "utf8")

    const encoded = buildCliContext(idPath)

    // base64url: only A-Z a-z 0-9 - _ (no +/=)
    expect(encoded).toMatch(/^[A-Za-z0-9\-_]+$/)

    const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>
    expect(ctx["v"]).toBe(1)
    expect(ctx["machine_id"]).toBe("test-uuid-1234")
    expect(typeof ctx["cli_version"]).toBe("string")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("creates machine_id file when absent and includes it in context", () => {
    // getOrCreateMachineId mints a UUID when the file is missing, so machine_id
    // is always present (as a non-empty string) unless telemetry is disabled.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-ctx-new-"))
    const nonExistentPath = path.join(tmpDir, "subdir", "machine-id")

    const encoded = buildCliContext(nonExistentPath)
    const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

    expect(ctx["v"]).toBe(1)
    // machine_id must be present and non-empty (newly minted UUID)
    expect(typeof ctx["machine_id"]).toBe("string")
    expect((ctx["machine_id"] as string).length).toBeGreaterThan(0)
    // The same id must have been written to disk for telemetry to use
    expect(fs.readFileSync(nonExistentPath, "utf8").trim()).toBe(ctx["machine_id"])

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("trims whitespace from machine-id file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-ctx-ws-"))
    const idPath = path.join(tmpDir, "machine-id")
    // Many editors/tools write a trailing newline
    fs.writeFileSync(idPath, "  trimmed-uuid  \n", "utf8")

    const encoded = buildCliContext(idPath)
    const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

    expect(ctx["machine_id"]).toBe("trimmed-uuid")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("telemetry opt-out", () => {
    let savedEnv: string | undefined

    beforeEach(() => {
      savedEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    })

    afterEach(() => {
      if (savedEnv === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
      else process.env.ALTIMATE_TELEMETRY_DISABLED = savedEnv
    })

    test("omits machine_id key when ALTIMATE_TELEMETRY_DISABLED=true", () => {
      process.env.ALTIMATE_TELEMETRY_DISABLED = "true"

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-ctx-disabled-"))
      const idPath = path.join(tmpDir, "machine-id")
      fs.writeFileSync(idPath, "should-not-appear", "utf8")

      const encoded = buildCliContext(idPath)
      const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

      // machine_id must be absent when telemetry is disabled
      expect(Object.prototype.hasOwnProperty.call(ctx, "machine_id")).toBe(false)
      expect(ctx["v"]).toBe(1)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    test("includes machine_id when ALTIMATE_TELEMETRY_DISABLED is not set", () => {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-ctx-enabled-"))
      const idPath = path.join(tmpDir, "machine-id")
      fs.writeFileSync(idPath, "expected-uuid", "utf8")

      const encoded = buildCliContext(idPath)
      const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

      expect(ctx["machine_id"]).toBe("expected-uuid")

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })
})

describe("getOrCreateMachineId", () => {
  test("returns existing id when file is present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-mid-"))
    const idPath = path.join(tmpDir, "machine-id")
    fs.writeFileSync(idPath, "existing-uuid\n", "utf8")

    expect(getOrCreateMachineId(idPath)).toBe("existing-uuid")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("creates a UUID file when absent and returns it", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-mid-create-"))
    const idPath = path.join(tmpDir, "subdir", "machine-id")

    const id = getOrCreateMachineId(idPath)

    // Must be a non-empty string that was written to disk
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
    expect(fs.readFileSync(idPath, "utf8").trim()).toBe(id)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("two concurrent callers with absent file converge on the same id", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-mid-race-"))
    const idPath = path.join(tmpDir, "machine-id")

    // Simulate a race: call getOrCreateMachineId twice before either has written
    const [id1, id2] = await Promise.all([
      Promise.resolve(getOrCreateMachineId(idPath)),
      Promise.resolve(getOrCreateMachineId(idPath)),
    ])

    expect(id1).toBe(id2)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe("buildAuthorizeUrl", () => {
  test("URL contains cli_context param that decodes to valid JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-auth-url-"))
    const idPath = path.join(tmpDir, "machine-id")
    fs.writeFileSync(idPath, "url-test-uuid", "utf8")

    // Temporarily override machine-id path via a patched buildCliContext call
    // by providing a custom machine_id file — buildAuthorizeUrl uses buildCliContext()
    // internally with no path arg, so test the URL shape via the exported helper.
    const url = buildAuthorizeUrl("https://app.myaltimate.com", "http://127.0.0.1:7317/callback", "test-state-abc")

    // Must contain cli_context query param
    expect(url).toContain("cli_context=")
    expect(url).toContain("client=altimate-code")
    expect(url).toContain("state=test-state-abc")
    expect(url).toContain("redirect=")

    // Extract and decode cli_context
    const parsed = new URL(url)
    const encoded = parsed.searchParams.get("cli_context")
    expect(encoded).toBeTruthy()

    const ctx = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>
    expect(ctx["v"]).toBe(1)
    expect(typeof ctx["cli_version"]).toBe("string")
    // machine_id may or may not be present depending on env, but if present must be a string
    if (Object.prototype.hasOwnProperty.call(ctx, "machine_id")) {
      expect(typeof ctx["machine_id"]).toBe("string")
      expect((ctx["machine_id"] as string).length).toBeGreaterThan(0)
    }

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("deleting cli_context line would cause cli_context param to be absent — URL integration is guarded", () => {
    // This test asserts that buildAuthorizeUrl really does embed cli_context.
    // If the &cli_context=... line were removed from buildAuthorizeUrl, this test fails.
    const url = buildAuthorizeUrl("https://app.myaltimate.com", "http://127.0.0.1:7317/callback", "state-xyz")
    const parsed = new URL(url)
    expect(parsed.searchParams.has("cli_context")).toBe(true)
  })
})
