// altimate_change — tests for cli_context auth URL parameter
import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { buildCliContext } from "../../src/altimate/plugin/altimate"

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

  test("omits machine_id value when file does not exist", () => {
    const nonExistentPath = path.join(os.tmpdir(), `altimate-no-such-${Date.now()}`, "machine-id")

    const encoded = buildCliContext(nonExistentPath)
    const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

    expect(ctx["v"]).toBe(1)
    // machine_id is empty string, not omitted — frontend can tell "error reading" from "no key"
    expect(ctx["machine_id"]).toBe("")
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
})
