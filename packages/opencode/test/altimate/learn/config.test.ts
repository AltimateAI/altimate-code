// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { autoReflectEnabled, captureEnabled, learnEnabled, workspacesOn } from "../../../src/altimate/learn/config"

describe("learning kill switch", () => {
  test("defaults enabled without configuration or an env override", () => {
    expect(learnEnabled(undefined, {})).toBe(true)
    expect(learnEnabled({}, {})).toBe(true)
    expect(learnEnabled({ enabled: true }, {})).toBe(true)
    expect(learnEnabled({ enabled: false }, {})).toBe(false)
  })

  for (const value of ["0", "false", "FALSE", "FaLsE"]) {
    test(`env ${value} disables learning even when config enables it`, () => {
      expect(learnEnabled({ enabled: true }, { ALTIMATE_LEARN: value })).toBe(false)
    })
  }

  for (const value of ["1", "true", "TRUE", "TrUe"]) {
    test(`env ${value} enables learning even when config disables it`, () => {
      expect(learnEnabled({ enabled: false }, { ALTIMATE_LEARN: value })).toBe(true)
    })
  }

  test("unrecognized env values fall back to config and the enabled default", () => {
    for (const value of ["", "invalid"]) {
      expect(learnEnabled(undefined, { ALTIMATE_LEARN: value })).toBe(true)
      expect(learnEnabled({ enabled: false }, { ALTIMATE_LEARN: value })).toBe(false)
    }
  })

  test("capture and auto-reflect opt-ins cannot override the kill switch", () => {
    const config = { enabled: false, capture: true, auto_reflect: true }
    const env = { ALTIMATE_LEARN_CAPTURE: "1", ALTIMATE_LEARN_AUTO: "1" }
    expect(captureEnabled(config, env)).toBe(false)
    expect(autoReflectEnabled(config, env)).toBe(false)
    expect(captureEnabled({ ...config, enabled: true }, { ...env, ALTIMATE_LEARN: "0" })).toBe(false)
    expect(autoReflectEnabled({ ...config, enabled: true }, { ...env, ALTIMATE_LEARN: "0" })).toBe(false)
    expect(captureEnabled(config, { ...env, ALTIMATE_LEARN: "1" })).toBe(true)
    expect(autoReflectEnabled(config, { ...env, ALTIMATE_LEARN: "1" })).toBe(true)
  })
})

describe("workspaces switch", () => {
  test("the kill switch and assessment mode each turn workspaces off, as Flag reads them", () => {
    expect(workspacesOn({})).toBe(true)
    expect(workspacesOn({ ALTIMATE_DISABLE_WORKSPACE: "1" })).toBe(false)
    for (const value of ["true", "1", "yes", "on"]) expect(workspacesOn({ ALTIMATE_ASSESSMENT_MODE: value })).toBe(false)
    for (const value of ["", "0", "false"]) expect(workspacesOn({ ALTIMATE_ASSESSMENT_MODE: value })).toBe(true)
  })
})
