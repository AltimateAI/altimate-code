// altimate_change — end-to-end onboarding funnel telemetry.
//
// Opt-in: ALTIMATE_E2E=1. These drive a real CLI process through a PTY, so they are slower and
// more timing-sensitive than the rest of the suite and should not gate anyone's commit.
//
// Assertions are on the event stream that arrives over HTTP, never on screen contents beyond the
// minimum needed to know which screen we are on — terminal rendering changes far more often than
// the telemetry contract does.
import { describe, expect, test } from "bun:test"
import { KEY, startCli, startSink } from "./telemetry-sink"

const enabled = process.env.ALTIMATE_E2E === "1"

describe.skipIf(!enabled)("onboarding funnel (e2e)", () => {
  test(
    "a first run through Big Pickle emits the Part 1 funnel, joined by one launch_id",
    async () => {
      const sink = startSink()
      const cli = await startCli(sink)
      try {
        // First run opens the curated picker with no stored credentials.
        await sink.waitFor("model_picker_shown")

        // Big Pickle is the fifth row and needs no signup, so the whole flow stays local.
        //
        // Steps are paced with sleeps rather than waiting for an event or for screen text.
        // Events arrive on the flush interval, so they lag the UI by seconds and cannot gate the
        // next keystroke; and the terminal output is per-cell ANSI, so a rendered label is split
        // across escape sequences and never matches a substring search.
        cli.press(KEY.down.repeat(4))
        await Bun.sleep(400)
        cli.press(KEY.enter)
        await Bun.sleep(1200)

        cli.press("y") // accept the Big Pickle interstitial
        await Bun.sleep(2500)

        cli.press("n") // decline the scan gate
        await Bun.sleep(3000)

        cli.press(KEY.ctrlC)
        await Bun.sleep(1200)
        cli.press(KEY.ctrlC)
        await Promise.race([cli.exited, Bun.sleep(15_000)])
        await Bun.sleep(1500)

        const names = sink.names()
        expect(names).toContain("onboarding_started")
        expect(names).toContain("model_picker_shown")
        expect(names).toContain("provider_selected")
        expect(names).toContain("big_pickle_choice")

        const picker = sink.envelopes.find((e) => e.name === "model_picker_shown")!
        expect(picker.properties.trigger).toBe("first_run")

        const provider = sink.envelopes.find((e) => e.name === "provider_selected")!
        expect(provider.properties.provider).toBe("big_pickle")

        const choice = sink.envelopes.find((e) => e.name === "scan_gate_choice")!
        expect(choice.properties.choice).toBe("skip")

        // The point of launch_id: TUI-thread events (started, picker) and worker-thread events
        // must be attributable to the same run even though they carry different sessions.
        const launchIds = new Set(sink.envelopes.map((e) => e.properties.launch_id))
        expect(launchIds.size).toBe(1)
        expect([...launchIds][0]).toBeTruthy()

        // A completed onboarding is not an abandoned one.
        expect(names).not.toContain("onboarding_abandoned")
      } finally {
        await cli.cleanup()
        sink.stop()
      }
    },
    120_000,
  )

  test(
    "quitting at the picker reports abandonment, and it survives process exit",
    async () => {
      const sink = startSink()
      const cli = await startCli(sink)
      try {
        await sink.waitFor("model_picker_shown")

        // Quit without choosing anything. The event is emitted during shutdown, so this is the
        // only test that proves the exit-flush path actually delivers.
        cli.press(KEY.ctrlC)
        await Bun.sleep(1000)
        cli.press(KEY.ctrlC)
        await Promise.race([cli.exited, Bun.sleep(20_000)])
        await Bun.sleep(2000)

        const abandoned = await sink.waitFor("onboarding_abandoned", 15_000)
        expect(abandoned.properties.last_stage).toBe("model_picker")
        expect(sink.names()).not.toContain("onboarding_completed")
      } finally {
        await cli.cleanup()
        sink.stop()
      }
    },
    120_000,
  )
})
