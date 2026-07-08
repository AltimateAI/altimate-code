/**
 * TUI e2e — leader-key pickers.
 *
 * The leader chord `Ctrl-X` gates most non-typing UI actions. This file
 * asserts that three of the highest-value pickers open and render their
 * expected content:
 *
 *   `<leader>a` → agent picker  (keybind: agent_list, keybind.ts:126)
 *   `<leader>t` → theme picker  (keybind: theme_list, keybind.ts:77)
 *   `<leader>l` → session list  (keybind: session_list, keybind.ts:87)
 *
 * Chose these three because:
 *   - agent switching is a first-class user path (builder → analyst → …)
 *   - theme picker is a proxy for "any picker whose content is code-owned
 *     rather than data-owned" — regressions here signal renderer breakage
 *   - session list exercises the persistence layer's TUI surface
 *
 * The model picker is exercised by the pre-existing model-picker smoke test.
 */

import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "altimate-tui-leader-"))
}

describe("TUI e2e — leader-key pickers", () => {
  test("<leader>a opens the agent picker", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 140,
      rows: 50,
      waitForReady: "Ask anything",
    })
    try {
      tui.sendKey("Ctrl-X")
      tui.write("a")
      // The agent picker header ("Agent" / "Agents") is stable across themes.
      // We match either since header casing differs between primary/subagent
      // sections.
      await tui.waitForText(/Agents?/i, { timeoutMs: 5000 })
      // Also assert at least one known built-in agent name renders. `builder`
      // is the default primary agent and is always present.
      await tui.waitForText("builder", { timeoutMs: 3000 })
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 30_000)

  test("<leader>t opens the theme picker", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 140,
      rows: 50,
      waitForReady: "Ask anything",
    })
    try {
      tui.sendKey("Ctrl-X")
      tui.write("t")
      // Theme picker chrome — the header shows "Theme" as a substring across
      // all known themes.
      await tui.waitForText(/Theme/i, { timeoutMs: 5000 })
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 30_000)

  test("<leader>l opens the session list", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 140,
      rows: 50,
      waitForReady: "Ask anything",
    })
    try {
      tui.sendKey("Ctrl-X")
      tui.write("l")
      // The session picker renders a header + at least the "no sessions yet"
      // placeholder OR real session titles. Matching /Session/i keeps this
      // stable regardless of session state on the running machine.
      await tui.waitForText(/Session/i, { timeoutMs: 5000 })
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 30_000)
})
