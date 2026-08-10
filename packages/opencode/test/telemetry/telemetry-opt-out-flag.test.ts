// v0.9.5 review — Chaos gremlin P1 + End-user P2, plus bot-review follow-ups
// (codex + coderabbit + cubic all named the same gap: the initial version of
// this file only tested the shared `Flag.truthyEnv` helper against
// `ALTIMATE_TELEMETRY_DISABLED`. That meant a regression that dropped the
// `OPENCODE_DISABLE_TELEMETRY` fallback OR removed the OR-composition at either
// call site (`altimate/plugin/altimate.ts::buildCliContext`,
// `altimate/telemetry/index.ts::doInit`) would still pass every test — the
// exact failure this file exists to prevent).
//
// The file now covers three layers:
//   1. Parser semantics — `Flag.truthyEnv` accepts "true"/"TRUE"/"1", rejects
//      the everything-else surface (case sensitivity, whitespace, non-1 digits).
//   2. Consumer-boundary composition — the exact `truthyEnv(A) || truthyEnv(B)`
//      shape used at both gate sites returns true when EITHER env var is set.
//   3. Gate-site source anchor — both `altimate.ts` and `telemetry/index.ts`
//      reference both env-var names on the same line. Brittle by design: if a
//      future edit deletes the fallback branch, this test catches it without
//      needing to boot the full telemetry init in a unit test.
//
// Env-mutation isolation: each test snapshots the two vars before mutating
// them and restores what it found. This keeps the suite safe against other
// tests in the same process reading `process.env.ALTIMATE_TELEMETRY_DISABLED`
// or `OPENCODE_DISABLE_TELEMETRY` and against parallel suites in other
// packages (bot-review follow-up, coderabbit).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Flag } from "../../src/flag/flag"

const ALTIMATE_VAR = "ALTIMATE_TELEMETRY_DISABLED"
const OPENCODE_VAR = "OPENCODE_DISABLE_TELEMETRY"

// Snapshot both env vars and restore them after each test — protects against
// leakage into or out of this suite regardless of what set them.
let snapshot: { altimate: string | undefined; opencode: string | undefined }

beforeEach(() => {
  snapshot = {
    altimate: process.env[ALTIMATE_VAR],
    opencode: process.env[OPENCODE_VAR],
  }
})

afterEach(() => {
  if (snapshot.altimate === undefined) delete process.env[ALTIMATE_VAR]
  else process.env[ALTIMATE_VAR] = snapshot.altimate
  if (snapshot.opencode === undefined) delete process.env[OPENCODE_VAR]
  else process.env[OPENCODE_VAR] = snapshot.opencode
})

describe("Flag.truthyEnv — parser semantics on ALTIMATE_TELEMETRY_DISABLED", () => {
  test("unset env var → false (default: telemetry enabled)", () => {
    delete process.env[ALTIMATE_VAR]
    expect(Flag.truthyEnv(ALTIMATE_VAR)).toBe(false)
  })

  test("empty string → false", () => {
    process.env[ALTIMATE_VAR] = ""
    expect(Flag.truthyEnv(ALTIMATE_VAR)).toBe(false)
  })

  test.each([
    ["true", true],
    ["TRUE", true],
    ["True", true],
    ["1", true],
    ["false", false],
    ["FALSE", false],
    ["0", false],
    ["yes", false],
    ["on", false],
    ["  true  ", false], // no trimming — matches existing truthy() semantics
    ["2", false],
  ])("value %j → %s", (value, expected) => {
    process.env[ALTIMATE_VAR] = value
    expect(Flag.truthyEnv(ALTIMATE_VAR)).toBe(expected)
  })

  test("re-reads process.env on each call (not frozen at import)", () => {
    delete process.env[ALTIMATE_VAR]
    expect(Flag.truthyEnv(ALTIMATE_VAR)).toBe(false)
    process.env[ALTIMATE_VAR] = "1"
    expect(Flag.truthyEnv(ALTIMATE_VAR)).toBe(true)
    process.env[ALTIMATE_VAR] = "false"
    expect(Flag.truthyEnv(ALTIMATE_VAR)).toBe(false)
  })
})

describe("Consumer-boundary composition — both env vars route through the same OR gate", () => {
  // The two production callers use `truthyEnv(A) || truthyEnv(B)`. These tests
  // exercise both branches of that OR expression so a regression that hard-wires
  // one branch to false would fail here (codex/coderabbit/cubic finding).
  //
  // We reproduce the composition inline via a local helper so the tests read
  // as one unit rather than four permutations. The "gate-site anchor" tests
  // below then prove the production callers actually contain this shape.
  const gate = () =>
    Flag.truthyEnv(ALTIMATE_VAR) || Flag.truthyEnv(OPENCODE_VAR)

  test("neither set → gate is closed (telemetry enabled)", () => {
    delete process.env[ALTIMATE_VAR]
    delete process.env[OPENCODE_VAR]
    expect(gate()).toBe(false)
  })

  test("only ALTIMATE_TELEMETRY_DISABLED set → gate is open (primary branch)", () => {
    delete process.env[OPENCODE_VAR]
    process.env[ALTIMATE_VAR] = "1"
    expect(gate()).toBe(true)
  })

  test("only OPENCODE_DISABLE_TELEMETRY set → gate is open (fallback branch)", () => {
    // v0.9.4 CHANGELOG advertised this name; before v0.9.5 it was silently
    // ignored in product. Removing the second `truthyEnv(...)` from either
    // call site would silently regress this — the source-anchor test below
    // catches that additional shape.
    delete process.env[ALTIMATE_VAR]
    process.env[OPENCODE_VAR] = "1"
    expect(gate()).toBe(true)
  })

  test.each([
    ["true", "true"],
    ["1", "1"],
    ["TRUE", "true"],
  ])(
    "both set (%j / %j) → gate is open",
    (altimateVal, opencodeVal) => {
      process.env[ALTIMATE_VAR] = altimateVal
      process.env[OPENCODE_VAR] = opencodeVal
      expect(gate()).toBe(true)
    },
  )

  test("both set with non-truthy values → gate is closed", () => {
    process.env[ALTIMATE_VAR] = "false"
    process.env[OPENCODE_VAR] = "0"
    expect(gate()).toBe(false)
  })
})

describe("Gate-site anchor — both call sites reference both env-var names", () => {
  // codex/coderabbit/cubic all pointed out that testing the shared helper in
  // isolation doesn't prove the CALLER retains the fallback branch. Without an
  // integration-level runner for `doInit()` / `buildCliContext` (both touch
  // Config, machine-id, and a network sink), the closest deterministic proof is
  // a source-shape assertion: both call sites must mention both env-var names
  // within a small window. A future edit that deletes the fallback fails here
  // and gives a clear name for what regressed.
  //
  // The window (a single non-comment line, or up to two adjacent non-comment
  // lines) is deliberately narrow — enough for the OR expression to wrap to a
  // second line for prettier, but not enough for the two names to sit in
  // unrelated pieces of the file.
  const GATE_FILES = [
    "src/altimate/plugin/altimate.ts",
    "src/altimate/telemetry/index.ts",
  ]

  test.each(GATE_FILES)(
    "%s references both %s and %s in the same gate",
    (relativePath) => {
      const absolute = path.resolve(__dirname, "../..", relativePath)
      const source = fs.readFileSync(absolute, "utf8")
      // Strip line comments so a `// mentions X and Y` comment doesn't count.
      const codeLines = source
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, "").trim())
      const window = 2
      let matched = false
      for (let i = 0; i < codeLines.length && !matched; i++) {
        const slice = codeLines.slice(i, i + window).join(" ")
        if (slice.includes(ALTIMATE_VAR) && slice.includes(OPENCODE_VAR)) {
          matched = true
        }
      }
      expect(matched).toBe(true)
    },
  )
})
