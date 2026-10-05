// Workspaces are on by default; ALTIMATE_DISABLE_WORKSPACE is the only way to turn them off.
// The test preload sets the switch for the rest of the suite, so this file is where the
// default itself is checked.
import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { isEnabled as engineEnabled } from "../../../src/altimate/workspace/engine-seams"
import { isEnabled as skillsEnabled } from "../../../src/altimate/workspace/skill-sync"
import { isEnabled as memoryEnabled } from "../../../src/altimate/workspace/memory-sync"

const ORIGINAL = process.env.ALTIMATE_DISABLE_WORKSPACE

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
  else process.env.ALTIMATE_DISABLE_WORKSPACE = ORIGINAL
})

describe("the workspace kill switch", () => {
  test("workspaces are on when the switch is not set", () => {
    delete process.env.ALTIMATE_DISABLE_WORKSPACE
    expect(Flag.ALTIMATE_DISABLE_WORKSPACE).toBe(false)
    expect(engineEnabled()).toBe(true)
    expect(skillsEnabled()).toBe(true)
    expect(memoryEnabled()).toBe(true)
  })

  test("setting the switch turns every workspace gate off", () => {
    process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
    expect(Flag.ALTIMATE_DISABLE_WORKSPACE).toBe(true)
    expect(engineEnabled()).toBe(false)
    expect(skillsEnabled()).toBe(false)
    expect(memoryEnabled()).toBe(false)
  })

  test("the switch fails closed: any value but empty, 0 or false turns workspaces off", () => {
    for (const on of ["1", "true", "TRUE", "yes", "on", " 1 ", "anything"]) {
      process.env.ALTIMATE_DISABLE_WORKSPACE = on
      expect(Flag.ALTIMATE_DISABLE_WORKSPACE).toBe(true)
      expect(engineEnabled()).toBe(false)
    }
    for (const off of ["", "0", "false", "FALSE"]) {
      process.env.ALTIMATE_DISABLE_WORKSPACE = off
      expect(Flag.ALTIMATE_DISABLE_WORKSPACE).toBe(false)
    }
  })

  test("the retired opt-in variable has no effect, either way", () => {
    const prior = process.env.ALTIMATE_WORKSPACE
    try {
      delete process.env.ALTIMATE_DISABLE_WORKSPACE
      process.env.ALTIMATE_WORKSPACE = "0"
      expect([engineEnabled(), skillsEnabled(), memoryEnabled()]).toEqual([true, true, true])
      // Nor can it override the kill switch.
      process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
      process.env.ALTIMATE_WORKSPACE = "1"
      expect([engineEnabled(), skillsEnabled(), memoryEnabled()]).toEqual([false, false, false])
    } finally {
      if (prior === undefined) delete process.env.ALTIMATE_WORKSPACE
      else process.env.ALTIMATE_WORKSPACE = prior
    }
  })
})
