// altimate_change - new file
// The fork's TUI plugin list. The boot-box workspace welcome section is kept out of it: in 0.12.5, with it mounted on
// the home screen, every keybinding stopped working once its binding lookup ran, so the TUI could not be quit.
import { afterEach, describe, expect, test } from "bun:test"
import { altimateTuiPlugins } from "../../../src/plugin/tui/altimate"

const prior = process.env.ALTIMATE_DISABLE_WORKSPACE
afterEach(() => {
  if (prior === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
  else process.env.ALTIMATE_DISABLE_WORKSPACE = prior
})

const ids = () => altimateTuiPlugins({ experimentalEventSystem: false }).map((p) => p.id)

describe("altimate TUI plugins", () => {
  // The welcome section is back: 0.12.6 left it out over the dead keybindings, fixed in its view
  // (see test/altimate/plugin/workspace-welcome-slot.test.tsx).
  test("with workspaces on, the workspace plugins and the welcome section are registered", () => {
    delete process.env.ALTIMATE_DISABLE_WORKSPACE
    expect(ids()).toContain("altimate:workspace")
    expect(ids()).toContain("altimate:sidebar-workspace")
    expect(ids()).toContain("altimate:welcome-workspace")
  })

  test("the kill switch leaves every workspace plugin out", () => {
    process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
    expect(ids().filter((id) => id.includes("workspace"))).toEqual([])
  })
})
