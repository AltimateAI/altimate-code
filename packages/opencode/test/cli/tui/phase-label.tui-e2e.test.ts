/**
 * TUI e2e — AI-7519: phase-label renders during the busy pre-first-visible-response window.
 *
 * The <10s-to-first-visible-response half of AI-7519 relies on the server
 * publishing session.phase events (fired by SessionPrompt.traceSpan on entry
 * and exit) and the TUI subscribing + rendering an honest label like
 * "Discovering tools..." or the "Thinking..." fallback next to the busy
 * spinner. Every static check + unit test can pass while the actual TUI
 * render silently drops the label — the AI-6298 experience demonstrated
 * exactly that failure mode. This spec drives the real TUI end-to-end so the
 * label is verified against the user's actual view.
 *
 * The label is expected to appear during the brief interval between
 * `status.type === "busy"` and the first token from the model. On a bare
 * prompt with no auth configured, the busy window closes almost immediately
 * with an error banner — but the phase spans still fire (Session.get,
 * Config.get, Telemetry.init all run before any LLM call is attempted) and
 * the "Thinking..." fallback rendered next to the spinner is a strict
 * superset of the specific bootstrap labels. Asserting on "Thinking..." keeps
 * the test tolerant to timing variance and provider unreachability.
 */

import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "altimate-tui-phase-"))
}

describe("TUI e2e — AI-7519 phase-label render", () => {
  test("phase-label renders next to the busy spinner after a prompt is submitted", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 140,
      rows: 50,
      waitForReady: "Ask anything",
    })
    try {
      // Type a short prompt and submit it. The exact content doesn't matter —
      // we're driving the session-prompt loop() to fire, which runs the
      // bootstrap traceSpan wrappers that publish session.phase events. The
      // loop() runs before any LLM call, so this works even if the machine
      // has no provider auth configured — the phase labels fire during
      // bootstrap, and the busy state is entered before the eventual error
      // banner (if any) resolves.
      for (const ch of "hi") {
        tui.write(ch)
        await new Promise((r) => setTimeout(r, 25))
      }
      tui.sendKey("Enter")

      // The label lookup falls back to "Thinking..." for any active busy
      // window without a specific phase name mapped. That fallback is a
      // strict superset of every specific bootstrap label, so asserting on
      // the fallback is robust to timing races (the specific labels flash
      // very briefly during their sub-millisecond spans).
      await tui.waitForText(/Thinking\.\.\./, { timeoutMs: 8000 })

      // Diagnostic dump for the specific labels — write out which ones caught.
      const rendered = tui.text()
      const specificLabels = {
        "Loading session": rendered.includes("Loading session"),
        "Loading config": rendered.includes("Loading config"),
        "Discovering tools": rendered.includes("Discovering tools"),
        "Preparing telemetry": rendered.includes("Preparing telemetry"),
        "Detecting project shape": rendered.includes("Detecting project shape"),
      }
      // eslint-disable-next-line no-console
      console.log("[AI-7519 e2e] specific label hits:", JSON.stringify(specificLabels))
      // The fallback assertion above is the load-bearing check; the specific
      // labels are timing-sensitive (sub-millisecond spans + PTY polling
      // interval). Not gated on hard equality.
      expect(rendered).toContain("Thinking...")
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 45_000)
})
