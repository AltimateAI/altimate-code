/**
 * sample_setup tool — LLM-invoked wrapper around materializeSample().
 *
 * The template at packages/opencode/src/command/template/onboard-connect.txt
 * branches on the tool's `output` (never `metadata` — the model only sees
 * `output`, per packages/opencode/src/session/message-v2.ts:822). The
 * `output` starts with a `status:` line that identifies success vs error;
 * these tests pin that contract shape end-to-end through `tool.execute`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SampleSetupTool } from "../../../src/altimate/tools/sample-setup"
import { MARKER_KIND, readMarker, writeMarker } from "../../../src/altimate/onboarding/marker"
import { initTool, type TestTool } from "../tool-fixture"

let tool: TestTool<typeof SampleSetupTool>
beforeAll(async () => {
  tool = await initTool(SampleSetupTool)
})

const CTX: any = { sessionID: "test-session" }

const ORIG_HOMEDIR = os.homedir
function pinHomedirTo(dir: string) {
  Object.defineProperty(os, "homedir", { value: () => dir, configurable: true })
}
afterEach(() => {
  Object.defineProperty(os, "homedir", { value: ORIG_HOMEDIR, configurable: true })
})

// Scratch dirs carved out of the REAL home directory. The sample_setup tool
// intentionally does NOT expose allowUnsafeParent on its LLM-facing schema
// (that would be a bypass of rejectUnsafeHome), so a fake home used to
// exercise the tool must survive rejectUnsafeHome on its own — which means
// NOT under os.tmpdir() (rejected as ephemeral), NOT /tmp/* (same), NOT
// /root as non-root. The user's real home is the one reliably-safe parent
// available across macOS + Linux CI; scoping into a UUID-suffixed subdir
// under it keeps the tests hermetic while still exercising the guard end-
// to-end.
const CREATED_SCRATCH_HOMES: string[] = []
function makeTmpHome(prefix: string): string {
  const realHome = os.homedir()
  const scratchHome = path.join(realHome, `.altimate-sample-setup-test-${prefix}-${Date.now().toString(36)}-${process.pid}`)
  fs.mkdirSync(scratchHome, { recursive: true })
  CREATED_SCRATCH_HOMES.push(scratchHome)
  return scratchHome
}
afterAll(() => {
  // Best-effort cleanup of every scratch home the tests created under the
  // user's real HOME. Individual test failures should not leak scratch
  // dirs; wrap each in try/catch so one stubborn dir doesn't block the
  // rest.
  for (const dir of CREATED_SCRATCH_HOMES) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe("sample_setup tool — LLM-facing contract", () => {
  test("fresh materialize → output starts with 'status: ok', includes path/reused/suffix", async () => {
    const home = makeTmpHome("fresh")
    pinHomedirTo(home)
    const result = await tool.execute({ preferred_target_name: "sample", allow_in_place_upgrade: false }, CTX)
    // Template branches on the FIRST LINE of output — assert that first.
    const firstLine = result.output.split("\n")[0]
    expect(firstLine).toBe("status: ok")
    // Body must carry the fields the template's routing table reads.
    expect(result.output).toContain(`path: ${path.join(home, "sample")}`)
    expect(result.output).toContain("reused: false")
    expect(result.output).toContain("suffix: 0")
    // Metadata carries the same info + the success flag (telemetry contract).
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.targetPath).toBe(path.join(home, "sample"))
    // Sanity: the materialized dir has the marker.
    expect(readMarker(result.metadata.targetPath as string)?.kind).toBe(MARKER_KIND)
  })

  test("second call to same target → 'status: ok' + 'reused: true' (template branch c)", async () => {
    const home = makeTmpHome("reuse")
    pinHomedirTo(home)
    await tool.execute({ preferred_target_name: "sample", allow_in_place_upgrade: false }, CTX)
    const second = await tool.execute({ preferred_target_name: "sample", allow_in_place_upgrade: false }, CTX)
    expect(second.output).toContain("status: ok")
    expect(second.output).toContain("reused: true")
    expect(second.metadata.success).toBe(true)
  })

  test("preferred name taken by unrelated content → suffix carries a non-zero value (template branch d)", async () => {
    const home = makeTmpHome("collide")
    pinHomedirTo(home)
    const preferred = path.join(home, "sample")
    fs.mkdirSync(preferred, { recursive: true })
    fs.writeFileSync(path.join(preferred, "user-file.txt"), "important")
    const result = await tool.execute({ preferred_target_name: "sample", allow_in_place_upgrade: false }, CTX)
    expect(result.output).toContain("status: ok")
    expect(result.output).toContain("reused: false")
    expect(result.output).toContain("suffix: 1")
    expect(result.output).toContain(`path: ${path.join(home, "sample-2")}`)
    // User's file untouched.
    expect(fs.readFileSync(path.join(preferred, "user-file.txt"), "utf8")).toBe("important")
  })

  test("existing our-sample at different version → 'reused: true' + 'Caller must prompt' note (template branch b)", async () => {
    const home = makeTmpHome("diffver")
    pinHomedirTo(home)
    const preferred = path.join(home, "sample")
    fs.mkdirSync(preferred, { recursive: true })
    writeMarker(preferred, {
      kind: MARKER_KIND,
      sampleName: "jaffle-shop-duckdb",
      version: "0.9.0",
      materializedAt: "2020-01-01T00:00:00.000Z",
      cliVersion: "0.9.0-old",
    })
    const result = await tool.execute({ preferred_target_name: "sample", allow_in_place_upgrade: false }, CTX)
    expect(result.output).toContain("status: ok")
    expect(result.output).toContain("reused: true")
    expect(result.output).toContain("Caller must prompt")
  })

  test("unsafe HOME → 'status: error' + verbatim actionable message in output (template branch a)", async () => {
    // Simulate the /root-as-non-root case rejectUnsafeHome catches: pin
    // os.homedir() to /tmp/xyz, since /tmp/* is universally refused.
    pinHomedirTo("/tmp/xyz-unsafe")
    const result = await tool.execute({ preferred_target_name: "sample", allow_in_place_upgrade: false }, CTX)
    // FIRST line — that's what the template reads before deciding to show
    // the sample menu vs surface the message.
    const firstLine = result.output.split("\n")[0]
    expect(firstLine).toBe("status: error")
    expect(result.output).toContain("reason: materialize_failed")
    // Body carries the guard's actionable text.
    expect(result.output).toContain("ephemeral")
    // Metadata records the failure for telemetry.
    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error).toBeDefined()
  })

  test("install_alongside=true skips version-mismatched slot 0 → lands at sample-2 with fresh marker (template branch b→install-alongside routing)", async () => {
    const home = makeTmpHome("alongside")
    pinHomedirTo(home)
    // Seed slot 0 with an older-version sample so install_alongside has
    // something to route around.
    const old = path.join(home, "sample")
    fs.mkdirSync(old, { recursive: true })
    writeMarker(old, {
      kind: MARKER_KIND,
      sampleName: "jaffle-shop-duckdb",
      version: "0.5.0",
      materializedAt: "2020-01-01T00:00:00.000Z",
      cliVersion: "0.5.0-old",
    })
    // Also seed a canary file in the old slot to prove install_alongside
    // leaves it untouched.
    fs.writeFileSync(path.join(old, "user-note.md"), "keep me")

    const result = await tool.execute(
      { preferred_target_name: "sample", allow_in_place_upgrade: false, install_alongside: true },
      CTX,
    )
    expect(result.output).toContain("status: ok")
    expect(result.output).toContain("reused: false")
    // Suffix carries a non-zero value; the template reads `path:` for the
    // canonical location so we assert on that.
    expect(result.output).toContain(`path: ${path.join(home, "sample-2")}`)
    // Old slot 0 untouched — its marker still says 0.5.0 and the canary is there.
    expect(readMarker(old)?.version).toBe("0.5.0")
    expect(fs.existsSync(path.join(old, "user-note.md"))).toBe(true)
    // New slot has the current-version marker.
    expect(readMarker(path.join(home, "sample-2"))?.kind).toBe(MARKER_KIND)
  })

  test("output includes a `dbt:` line the template's 'Build & query it' branch reads (finding 18)", async () => {
    // The template routes "Build & query it" by reading a `dbt:` line from
    // the sample_setup output — if that line disappears, the template's
    // build branch has to shell out again and duplicates work the tool
    // already did. Assert both the presence and the "present"/"missing"
    // dichotomy so a regression that dropped the field is caught.
    const home = makeTmpHome("dbtline")
    pinHomedirTo(home)
    const result = await tool.execute({ preferred_target_name: "sample", allow_in_place_upgrade: false }, CTX)
    expect(result.output).toContain("status: ok")
    const dbtLine = result.output.split("\n").find((l) => l.startsWith("dbt:"))
    expect(dbtLine, "output missing `dbt:` line — template's Build & query it branch would have to shell out").toBeDefined()
    // Exactly one of the two documented shapes:
    //   dbt: present (dbt-core X, duckdb-adapter present|missing)
    //   dbt: missing (dbt-core not on PATH)
    expect(dbtLine).toMatch(/^dbt: (present \(dbt-core .*, duckdb-adapter (present|missing)\)|missing \(dbt-core not on PATH\))$/)
  })

  test("tool boundary rejects bad preferred_target_name via the Zod schema (finding 29)", async () => {
    // preferred_target_name with a path separator should be refused at the
    // schema level (Zod regex on the tool argument), BEFORE materializeSample
    // even runs. tool.execute surfaces this as InvalidArgumentsError, so
    // the outer test guards against BOTH the throw AND the "no write
    // happened" contract — a regression that silently accepted "../foo"
    // would land on disk and this test would catch it.
    const home = makeTmpHome("zod-guard")
    pinHomedirTo(home)
    await expect(
      tool.execute(
        { preferred_target_name: "../escape", allow_in_place_upgrade: false } as any,
        CTX,
      ),
    ).rejects.toThrow(/invalid arguments|SchemaError|Expected/i)
    // No fs write happened — schema stopped it.
    expect(fs.readdirSync(home)).toEqual([])
  })
})
