/**
 * sample_setup tool — LLM-invoked wrapper around materializeSample().
 *
 * The template at packages/opencode/src/command/template/onboard-connect.txt
 * asks the LLM to call this tool from the activation-menu sample branch
 * and branches on the returned metadata. These tests pin the return
 * shape for the three success branches + the error passthrough contract.
 */

import { beforeAll, describe, expect, test } from "bun:test"
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

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// The tool's execute contract is `(args, ctx) => Promise<{title, metadata, output}>`.
// ctx is unused by this tool, so we pass a minimal stub.
const CTX: any = { sessionID: "test-session" }

describe("sample_setup tool — LLM-facing contract", () => {
  test("fresh materialize → metadata.reused=false, suffix=0, targetPath set, no error", async () => {
    const parent = makeTmp("sample-setup-fresh-")
    const result = await tool.execute(
      { preferred_target_name: "sample", target_parent: parent, allow_in_place_upgrade: false },
      CTX,
    )
    expect(result.metadata.error).toBe("")
    expect(result.metadata.reused).toBe(false)
    expect(result.metadata.suffix).toBe(0)
    expect(result.metadata.targetPath).toBe(path.join(parent, "sample"))
    // Sanity: the materialized dir has the marker.
    expect(readMarker(result.metadata.targetPath)?.kind).toBe(MARKER_KIND)
  })

  test("second call to same target → metadata.reused=true (template branch 1)", async () => {
    const parent = makeTmp("sample-setup-reuse-")
    await tool.execute(
      { preferred_target_name: "sample", target_parent: parent, allow_in_place_upgrade: false },
      CTX,
    )
    const second = await tool.execute(
      { preferred_target_name: "sample", target_parent: parent, allow_in_place_upgrade: false },
      CTX,
    )
    expect(second.metadata.reused).toBe(true)
    expect(second.metadata.error).toBe("")
  })

  test("preferred name taken by unrelated content → metadata.suffix>0 (template branch 3)", async () => {
    const parent = makeTmp("sample-setup-collide-")
    const preferred = path.join(parent, "sample")
    fs.mkdirSync(preferred)
    fs.writeFileSync(path.join(preferred, "user-file.txt"), "important")
    const result = await tool.execute(
      { preferred_target_name: "sample", target_parent: parent, allow_in_place_upgrade: false },
      CTX,
    )
    expect(result.metadata.reused).toBe(false)
    expect(result.metadata.suffix).toBe(1)
    expect(result.metadata.targetPath).toBe(path.join(parent, "sample-2"))
    // User's file untouched.
    expect(fs.readFileSync(path.join(preferred, "user-file.txt"), "utf8")).toBe("important")
  })

  test("unwritable target parent → structured error, output carries the actionable message verbatim", async () => {
    const result = await tool.execute(
      { target_parent: "/definitely/not/writable/anywhere", preferred_target_name: "sample", allow_in_place_upgrade: false },
      CTX,
    )
    expect(result.metadata.error).toBe("materialize_failed")
    expect(result.output).toContain("not writable")
  })

  test("existing our-sample at different version, no allow_in_place_upgrade → reused=true with 'Caller must prompt' hint", async () => {
    const parent = makeTmp("sample-setup-diffver-")
    // Pre-seed with our sample at an older version.
    const preferred = path.join(parent, "sample")
    fs.mkdirSync(preferred)
    writeMarker(preferred, {
      kind: MARKER_KIND,
      sampleName: "jaffle-shop-duckdb",
      version: "0.9.0",
      materializedAt: "2020-01-01T00:00:00.000Z",
      cliVersion: "0.9.0-old",
    })
    const result = await tool.execute(
      { preferred_target_name: "sample", target_parent: parent, allow_in_place_upgrade: false },
      CTX,
    )
    expect(result.metadata.reused).toBe(true)
    expect(result.metadata.note).toContain("Caller must prompt")
  })
})
