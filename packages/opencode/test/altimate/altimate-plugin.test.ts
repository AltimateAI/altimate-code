// altimate_change — tests for cli_context auth URL parameter
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import path from "path"
import { buildAuthorizeUrl, buildCliContext } from "../../src/altimate/plugin/altimate"
import { getOrCreateMachineId } from "../../src/altimate/util/machine-id"
import { Config } from "../../src/config/config"
import { tmpdir } from "../fixture/fixture"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

// buildCliContext resolves the telemetry opt-out via Config.get(), which throws
// "InstanceRef not provided" in the unit-test context and — by design — fails
// CLOSED, omitting machine_id. Stub Config.get() to an enabled config so the
// machine_id path is exercised; individual opt-out tests override the stub.
function stubConfig(impl: () => Promise<unknown>) {
  return spyOn(Config, "get").mockImplementation(impl as never)
}

describe("buildCliContext", () => {
  let cfg: ReturnType<typeof spyOn>
  let savedDisabled: string | undefined

  beforeEach(() => {
    // Clear any real opt-out from the dev's shell so these "telemetry enabled"
    // tests are not silently broken by an exported ALTIMATE_TELEMETRY_DISABLED.
    savedDisabled = process.env.ALTIMATE_TELEMETRY_DISABLED
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
    cfg = stubConfig(async () => ({}))
  })
  afterEach(() => {
    cfg.mockRestore()
    if (savedDisabled === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
    else process.env.ALTIMATE_TELEMETRY_DISABLED = savedDisabled
  })

  test("returns a valid base64url-encoded JSON blob with machine_id", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "machine-id")
    fs.writeFileSync(idPath, VALID_UUID, "utf8")

    const encoded = await buildCliContext(idPath)

    // base64url: only A-Z a-z 0-9 - _ (no +/=)
    expect(encoded).toMatch(/^[A-Za-z0-9\-_]+$/)

    const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>
    expect(ctx["v"]).toBe(1)
    expect(ctx["machine_id"]).toBe(VALID_UUID)
    expect(typeof ctx["cli_version"]).toBe("string")
  })

  test("creates machine_id file when absent and includes it in context", async () => {
    await using dir = await tmpdir()
    const nonExistentPath = path.join(dir.path, "subdir", "machine-id")

    const encoded = await buildCliContext(nonExistentPath)
    const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

    expect(ctx["v"]).toBe(1)
    expect(typeof ctx["machine_id"]).toBe("string")
    expect((ctx["machine_id"] as string).length).toBeGreaterThan(0)
    // The same id must have been written to disk for telemetry to reuse
    expect(fs.readFileSync(nonExistentPath, "utf8").trim()).toBe(ctx["machine_id"] as string)
  })

  test("trims whitespace from machine-id file", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "machine-id")
    fs.writeFileSync(idPath, `  ${VALID_UUID}  \n`, "utf8")

    const encoded = await buildCliContext(idPath)
    const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

    expect(ctx["machine_id"]).toBe(VALID_UUID)
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

    test("omits machine_id when ALTIMATE_TELEMETRY_DISABLED=true", async () => {
      process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
      await using dir = await tmpdir()
      const idPath = path.join(dir.path, "machine-id")
      fs.writeFileSync(idPath, VALID_UUID, "utf8")

      const encoded = await buildCliContext(idPath)
      const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

      expect(Object.prototype.hasOwnProperty.call(ctx, "machine_id")).toBe(false)
      expect(ctx["v"]).toBe(1)
    })

    test("omits machine_id when config.telemetry.disabled is set", async () => {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      cfg.mockImplementation((async () => ({ telemetry: { disabled: true } })) as never)
      await using dir = await tmpdir()
      const idPath = path.join(dir.path, "machine-id")
      fs.writeFileSync(idPath, VALID_UUID, "utf8")

      const encoded = await buildCliContext(idPath)
      const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

      expect(Object.prototype.hasOwnProperty.call(ctx, "machine_id")).toBe(false)
    })

    test("omits machine_id when Config.get() throws (fails CLOSED in the worker)", async () => {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      cfg.mockImplementation((async () => {
        throw new Error("InstanceRef not provided")
      }) as never)
      await using dir = await tmpdir()
      const idPath = path.join(dir.path, "machine-id")
      fs.writeFileSync(idPath, VALID_UUID, "utf8")

      const encoded = await buildCliContext(idPath)
      const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

      // Config unreadable → must NOT transmit the durable id.
      expect(Object.prototype.hasOwnProperty.call(ctx, "machine_id")).toBe(false)
    })

    test("includes machine_id when telemetry is enabled", async () => {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      await using dir = await tmpdir()
      const idPath = path.join(dir.path, "machine-id")
      fs.writeFileSync(idPath, VALID_UUID, "utf8")

      const encoded = await buildCliContext(idPath)
      const ctx = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>

      expect(ctx["machine_id"]).toBe(VALID_UUID)
    })
  })
})

describe("getOrCreateMachineId", () => {
  test("returns existing id when file is present", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "machine-id")
    fs.writeFileSync(idPath, `${VALID_UUID}\n`, "utf8")

    expect(getOrCreateMachineId(idPath)).toBe(VALID_UUID)
  })

  test("creates a UUID file when absent and returns it", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "subdir", "machine-id")

    const id = getOrCreateMachineId(idPath)

    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
    expect(fs.readFileSync(idPath, "utf8").trim()).toBe(id)
  })

  test("wx EEXIST (lost race) re-reads and returns the winner's id", () => {
    const winner = "550e8400-e29b-41d4-a716-4466554400ff"
    // Simulate a real race: the file is absent at lstat (ENOENT → create path),
    // but a concurrent writer created it before our `wx` write, so writeFileSync
    // throws EEXIST and we must re-read what the winner wrote.
    const lstatSpy = spyOn(fs, "lstatSync").mockImplementation(() => {
      const e = new Error("nope") as NodeJS.ErrnoException
      e.code = "ENOENT"
      throw e
    })
    const mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation(() => undefined as never)
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {
      const e = new Error("exists") as NodeJS.ErrnoException
      e.code = "EEXIST"
      throw e
    })
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(() => winner as never)
    try {
      expect(getOrCreateMachineId("/does/not/matter/machine-id")).toBe(winner)
      expect(readSpy).toHaveBeenCalled()
    } finally {
      lstatSpy.mockRestore()
      mkdirSpy.mockRestore()
      writeSpy.mockRestore()
      readSpy.mockRestore()
    }
  })

  test("returns '' when mkdir fails (read-only home) instead of throwing", () => {
    // Regression guard: mkdirSync must be inside the try/catch so a read-only
    // $HOME / restricted container returns "" rather than propagating and
    // breaking sign-in via buildCliContext → buildAuthorizeUrl → authorize().
    const lstatSpy = spyOn(fs, "lstatSync").mockImplementation(() => {
      const e = new Error("nope") as NodeJS.ErrnoException
      e.code = "ENOENT"
      throw e
    })
    const mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation(() => {
      const e = new Error("eacces") as NodeJS.ErrnoException
      e.code = "EACCES"
      throw e
    })
    try {
      expect(getOrCreateMachineId("/root/.altimate/machine-id")).toBe("")
    } finally {
      lstatSpy.mockRestore()
      mkdirSpy.mockRestore()
    }
  })
})

describe("buildAuthorizeUrl", () => {
  let cfg: ReturnType<typeof spyOn>
  let savedDisabled: string | undefined

  beforeEach(() => {
    savedDisabled = process.env.ALTIMATE_TELEMETRY_DISABLED
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
    cfg = stubConfig(async () => ({}))
  })
  afterEach(() => {
    cfg.mockRestore()
    if (savedDisabled === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
    else process.env.ALTIMATE_TELEMETRY_DISABLED = savedDisabled
  })

  test("carries cli_context in the fragment (not the query), decoding to the machine_id", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "machine-id")
    fs.writeFileSync(idPath, VALID_UUID, "utf8")

    // Forward the temp machine-id path so the test never writes into the real $HOME.
    const url = await buildAuthorizeUrl(
      "https://app.myaltimate.com",
      "http://127.0.0.1:7317/callback",
      "test-state-abc",
      idPath,
    )

    expect(url).toContain("#cli_context=")
    expect(url).toContain("client=altimate-code")
    expect(url).toContain("state=test-state-abc")
    expect(url).toContain("redirect=")

    const parsed = new URL(url)
    // The durable id must NOT be in the query string (it would hit access logs).
    expect(parsed.searchParams.has("cli_context")).toBe(false)

    const encoded = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("cli_context")
    expect(encoded).toBeTruthy()

    const ctx = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>
    expect(ctx["v"]).toBe(1)
    expect(typeof ctx["cli_version"]).toBe("string")
    // Non-vacuous: the machine_id we wrote must round-trip through the URL.
    expect(ctx["machine_id"]).toBe(VALID_UUID)
  })

  test("removing the #cli_context= line would drop the param — integration is guarded", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "machine-id")
    fs.writeFileSync(idPath, VALID_UUID, "utf8")

    const url = await buildAuthorizeUrl(
      "https://app.myaltimate.com",
      "http://127.0.0.1:7317/callback",
      "state-xyz",
      idPath,
    )
    const parsed = new URL(url)
    expect(new URLSearchParams(parsed.hash.replace(/^#/, "")).has("cli_context")).toBe(true)
    // And never in the query string, where it would be logged.
    expect(parsed.searchParams.has("cli_context")).toBe(false)
  })
})

// altimate_change — failure-mode coverage for getOrCreateMachineId
describe("getOrCreateMachineId — failure modes", () => {
  test("returns empty string for non-UUID content without throwing", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "machine-id")
    fs.writeFileSync(idPath, "not-a-uuid-at-all", "utf8")

    expect(getOrCreateMachineId(idPath)).toBe("")
  })

  test("returns empty string for oversized file without throwing", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "machine-id")
    fs.writeFileSync(idPath, "x".repeat(513), "utf8")

    expect(getOrCreateMachineId(idPath)).toBe("")
  })

  test("returns empty string for a valid UUID of the wrong version", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "machine-id")
    // v1 UUID (third group starts with 1, not 4)
    fs.writeFileSync(idPath, "550e8400-e29b-11d4-a716-446655440000", "utf8")

    expect(getOrCreateMachineId(idPath)).toBe("")
  })

  test("returns empty string for an empty file without minting over it", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "machine-id")
    fs.writeFileSync(idPath, "", "utf8")

    expect(getOrCreateMachineId(idPath)).toBe("")
    expect(fs.readFileSync(idPath, "utf8")).toBe("")
  })

  test("returns empty string when the path is a directory", async () => {
    await using dir = await tmpdir()
    const idPath = path.join(dir.path, "machine-id")
    fs.mkdirSync(idPath)

    expect(getOrCreateMachineId(idPath)).toBe("")
  })

  test("returns empty string when the path is a symlink (not followed)", async () => {
    await using dir = await tmpdir()
    const targetPath = path.join(dir.path, "target")
    fs.writeFileSync(targetPath, "550e8400-e29b-41d4-a716-446655440099", "utf8")
    const linkPath = path.join(dir.path, "machine-id")
    fs.symlinkSync(targetPath, linkPath)

    expect(getOrCreateMachineId(linkPath)).toBe("")
  })
})
