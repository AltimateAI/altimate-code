/**
 * Smoke test for the PTY-based TUI e2e harness.
 *
 * Proves end-to-end that the harness can:
 *   1. Spawn the actual TUI binary inside a pseudo-terminal
 *   2. Wait for the rendered prompt to appear
 *   3. Send the leader-key sequence (Ctrl-X then `m`) to open the model picker
 *   4. Observe the picker's rendered text in the captured output
 *
 * The assertions deliberately target picker-chrome strings and built-in
 * provider names that don't require authentication, because Snowflake Cortex
 * models — the original motivating use case — only surface once the user has
 * OAuth credentials loaded. The harness itself doesn't care which dropdown
 * entries appear; this test exists to validate the wiring (spawn → key →
 * render → capture).
 *
 * Slow by definition — boots the full TUI process. Bun's default test timeout
 * is plenty (30s), but each test sets its own ceiling via `waitForText`.
 */

import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "altimate-tui-e2e-"))
}

describe("TUI e2e — PTY harness smoke test", () => {
  test("model picker opens on <leader>m and renders model entries", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 140,
      rows: 50,
      // Boot signal: the prompt's placeholder text is the most stable visible
      // string across themes / dialog interrupts.
      waitForReady: "Ask anything",
      bootTimeoutMs: 20_000,
    })

    try {
      // Settle: the initial render emits multiple frames; let the screen quiesce
      // before sending input so the leader-key handler is bound. Empirically
      // 600ms is enough on macOS arm64; bump if CI flakes.
      await sleep(600)

      // Send leader (Ctrl-X) then `m` — the default `model_list` binding from
      // packages/opencode/src/config/config.ts (model_list: "<leader>m",
      // leader: "ctrl+x").
      tui.sendKey("Ctrl-X")
      await sleep(120)
      tui.write("m")

      // Picker open signal: the dialog footer renders the `model_provider_list`
      // keybind hint. The label switches between "Connect provider" (when at
      // least one provider is authenticated) and "View all providers" (fresh
      // workspace with no auth) — match either so the test passes regardless
      // of the runner's auth state.
      await tui.waitForText(/Connect provider|View all providers/, { timeoutMs: 8_000 })

      // Unauthenticated mode renders a "Popular providers" section listing the
      // auth options. We don't need real models to validate the harness — just
      // that the picker actually painted something from the model-dialog code
      // path (vs. e.g. the prompt's command palette).
      expect(tui.text()).toMatch(/Popular providers|Favorite/i)

      // And at least one well-known provider entry should be visible alongside
      // the chrome. Anthropic / OpenAI / Google are guaranteed members of the
      // popular-providers list in `createDialogProviderOptions()`.
      expect(tui.text()).toMatch(/Anthropic|OpenAI|Google/)
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 60_000)
})

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
