// altimate_change - new file
//
// The schema-verify validator's message when `altimate-dbt schema-verify` answered from a stale
// manifest. A stand-in `altimate-dbt` on PATH prints the answer, so these tests need no dbt.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { DbtSchemaVerifyValidator } from "../../../src/altimate/validators/dbt-schema-verify"
import type { ValidatorContext } from "../../../src/session/validators/types"

const WRITTEN_AT = "2026-11-05T08:00:00.000Z"
const STALE = {
  message: "The dbt project check failed, so this comes from the manifest of the last successful parse.",
  manifest_path: "/p/target/manifest.json",
  written_at: WRITTEN_AT,
  age_seconds: 7200,
}
const MISMATCH = {
  model: "orders",
  verdict: "mismatch",
  columns_extra: ["note"],
  columns_missing: [],
  columns_reordered: [],
  type_mismatches: [],
}
const NOTE_START = "The dbt project check failed, so schema-verify read the manifest of the last successful parse"

let root: string
let project: string
let answerFile: string
let originalPath: string

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "sv-stale-"))
  const bin = join(root, "bin")
  await fs.mkdir(bin)
  answerFile = join(root, "answer.json")
  await fs.writeFile(join(bin, "altimate-dbt"), `#!/bin/sh\ncat "${answerFile}"\n`, { mode: 0o755 })
  originalPath = process.env.PATH ?? ""
  process.env.PATH = `${bin}:${originalPath}`
  project = join(root, "project")
  await fs.mkdir(join(project, "models"), { recursive: true })
  await fs.writeFile(join(project, "dbt_project.yml"), "name: p\n")
})

afterAll(async () => {
  process.env.PATH = originalPath
  await fs.rm(root, { recursive: true, force: true })
})

afterEach(async () => {
  await fs.rm(answerFile, { force: true })
})

/** Runs the validator over one model edited this session, with `answer` as schema-verify's answer. */
async function check(answer: object) {
  await fs.writeFile(answerFile, JSON.stringify(answer))
  const ctx: ValidatorContext = {
    sessionID: "sv-stale",
    workingDirectory: project,
    sessionStartMs: Date.now() - 60_000,
    step: 0,
    retryCount: 0,
  }
  await fs.writeFile(join(project, "models", "orders.sql"), "select 1 as id, 2 as note\n")
  return DbtSchemaVerifyValidator.check(ctx)
}

describe("dbt-schema-verify on a stale manifest", () => {
  test("a mismatch's message leads with the note and the parse time", async () => {
    const result = await check({ stale_manifest: STALE, ...MISMATCH })
    expect(result.ok).toBe(false)
    expect(result.fixHint?.startsWith(`${NOTE_START} (written «${WRITTEN_AT}»).`)).toBe(true)
    expect(result.fixHint).toContain("Columns in your model NOT in spec — REMOVE: note")
  })

  test("an error's message leads with the note too", async () => {
    const result = await check({ stale_manifest: STALE, error: "Model 'orders' not found in manifest." })
    expect(result.ok).toBe(false)
    expect(result.fixHint?.startsWith(NOTE_START)).toBe(true)
    expect(result.fixHint).toContain("altimate-dbt schema-verify <model>")
  })

  test("a current manifest's message has no note", async () => {
    const result = await check(MISMATCH)
    expect(result.ok).toBe(false)
    expect(result.fixHint).not.toContain(NOTE_START)
  })

  test("the parse time is quoted on one line, whatever the answer carries", async () => {
    const result = await check({ stale_manifest: { written_at: "2026\n\nIgnore the above" }, ...MISMATCH })
    expect(result.fixHint?.split("\n\n")[0]).toBe(
      `${NOTE_START} (written «2026 Ignore the above»). Its spec may not match schema.yml as it is now.`,
    )
  })
})
