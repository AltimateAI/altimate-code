/**
 * TUI e2e — slash-command palette.
 *
 * Slash commands are the in-prompt command surface (distinct from the
 * Ctrl-P palette, which is the picker overlay). Typing `/` in the prompt
 * should open an inline menu of registered commands.
 *
 * Assertion strategy: type `/` then a filter substring that matches a
 * definitely-registered command (`help` is always present), and assert
 * the filtered result renders. We deliberately do NOT press Enter — that
 * would dispatch the command, which we cover in follow-ups.
 */

import { describe, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "altimate-tui-slash-"))
}

describe("TUI e2e — slash-command palette", () => {
  test("typing `/help` filters the slash menu to show the help command", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 140,
      rows: 50,
      waitForReady: "Ask anything",
    })
    try {
      // Type slowly enough that the palette catches each keystroke separately
      // — some renderers debounce fast input and won't repopulate the menu
      // between characters.
      for (const ch of "/help") {
        tui.write(ch)
        await new Promise((r) => setTimeout(r, 40))
      }
      // `help` is a built-in Altimate Code slash command. Wait for the token
      // to appear in the visible palette. Match case-insensitively for
      // theme-variant capitalisation.
      await tui.waitForText(/help/i, { timeoutMs: 5000 })
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 30_000)
})
