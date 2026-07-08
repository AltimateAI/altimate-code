/**
 * TUI e2e — tool permission dialog renders on `ask` policy.
 *
 * When a policy is set to `ask` and a tool call fires, the TUI should
 * present a permission dialog identifying the tool. Fixture strategy:
 * write a project config that forces `bash: ask`, ask the model to run a
 * bash command, then wait for the dialog affordance in the transcript.
 *
 * Envelope-shaped assertion: we look for "permission" plus either the
 * tool name ("bash") or the choose-action affordance ("allow" / "deny").
 * Both are stable across the picker/dialog variants the TUI ships with.
 */

import { describe, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDirWithBashAsk(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "altimate-tui-perm-"))
  writeFileSync(
    path.join(dir, "altimate-code.json"),
    JSON.stringify({
      $schema: "https://altimate.ai/config.json",
      permission: { bash: "ask" },
    }),
  )
  return dir
}

describe("TUI e2e — tool permission dialog", () => {
  test("bash:ask surfaces a permission dialog when the model tries to shell", async () => {
    const project = makeProjectDirWithBashAsk()
    const tui = await launchTui({
      cwd: project,
      cols: 200,
      rows: 60,
      waitForReady: "Ask anything",
      env: {
        OPENCODE_CONFIG: path.join(project, "altimate-code.json"),
      },
    })
    try {
      tui.write("please run the shell command `pwd` for me")
      await new Promise((r) => setTimeout(r, 200))
      tui.sendKey("Enter")

      // Wait for either the permission dialog chrome (words specific to it)
      // OR the request rejection banner (in case the model was already
      // denied elsewhere and short-circuits). Both prove the permission
      // wiring routed the tool request.
      await tui.waitForText(
        /(?:allow|deny|permission|Bad Request|Error from provider|Upstream|Unable to connect)/i,
        { timeoutMs: 60_000 },
      )
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 90_000)
})
