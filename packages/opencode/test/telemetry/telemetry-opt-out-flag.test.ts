// v0.9.5 review — Chaos gremlin P1 + End-user P2.
//
// Before this release the two telemetry-disable gates
// (`altimate/plugin/altimate.ts::buildCliContext` and `altimate/telemetry/index.ts::doInit`)
// each checked `process.env.ALTIMATE_TELEMETRY_DISABLED === "true"`. A user
// running `ALTIMATE_TELEMETRY_DISABLED=1 altimate ...` (the shape most users
// reach for) was silently ignored — telemetry stayed on. v0.9.4's CHANGELOG
// also referenced `OPENCODE_DISABLE_TELEMETRY=1` as an opt-out env var, but
// that name was wired into test fixtures only and never checked in product.
//
// Both call sites now route through `Flag.truthyEnv`, which accepts
// "true"/"TRUE"/"1" and honors the OPENCODE_DISABLE_TELEMETRY fallback.
// This file locks the contract in place so a future edit to `truthy()` (or
// to either call site) can't silently narrow it again.

import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

const VAR = "ALTIMATE_TELEMETRY_DISABLED"

afterEach(() => {
  delete process.env[VAR]
})

describe("Flag.truthyEnv — telemetry opt-out shape", () => {
  test("unset env var → false (default: telemetry enabled)", () => {
    delete process.env[VAR]
    expect(Flag.truthyEnv(VAR)).toBe(false)
  })

  test("empty string → false", () => {
    process.env[VAR] = ""
    expect(Flag.truthyEnv(VAR)).toBe(false)
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
    process.env[VAR] = value
    expect(Flag.truthyEnv(VAR)).toBe(expected)
  })

  test("re-reads process.env on each call (not frozen at import)", () => {
    delete process.env[VAR]
    expect(Flag.truthyEnv(VAR)).toBe(false)
    process.env[VAR] = "1"
    expect(Flag.truthyEnv(VAR)).toBe(true)
    process.env[VAR] = "false"
    expect(Flag.truthyEnv(VAR)).toBe(false)
  })
})
