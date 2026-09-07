// altimate_change — does ctrl+y collide with the opentui console's copy-selection?
//
// `app.tsx` configures the console overlay with
// `consoleOptions: { keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }] }`,
// so `ctrl+y` already means something while the console holds focus. Review flagged the
// runtime behaviour as undefined and untested — a static keybind-config check cannot
// answer it, because the console binding does not live in TuiKeybind.Definitions.
//
// This drives the real binary: open the console, press ctrl+y, and record what actually
// happens. The assertion is deliberately written around whichever behaviour is real,
// with the finding documented, rather than asserting a behaviour we would prefer.
import { describe, expect, test } from "bun:test"
import { booted, suiteEnabled, withJourney, type TmuxJourney } from "./harness"

const maybeDescribe = suiteEnabled() ? describe : describe.skip
const journeyOptions = { timeout: 90_000, retry: 1 }

const CONFIRM = /Turn on YOLO mode for this session\?/i
const ENABLED = /YOLO ON/i

// The console toggle ships unbound ("none"); bind it so the journey can open the overlay.
const consoleEnv = {
  env: { ALTIMATE_CLI_YOLO: "false" },
  config: (base: Record<string, unknown>) => ({
    ...base,
    keybinds: { ...((base.keybinds as Record<string, unknown>) ?? {}), app_console: "ctrl+o" },
  }),
}

async function openConsole(tui: TmuxJourney) {
  tui.send("C-o")
  // The console overlay repaints the pane; give it a beat to appear.
  await Bun.sleep(1500)
}

maybeDescribe("real-binary TUI journeys: yolo vs console focus", () => {
  test(
    "ctrl+y with the console open does not silently half-fire",
    async () => {
      await withJourney(
        "yolo console focus",
        async (tui) => {
          await booted(tui)
          const before = tui.snapshot()
          expect(before).not.toMatch(ENABLED)

          await openConsole(tui)
          tui.send("C-y")
          await Bun.sleep(2000)
          const after = tui.snapshot()

          // Measured behaviour: the yolo binding takes precedence over the console's
          // copy-selection, and the confirmation still gates the bypass. Pinned as an
          // assertion rather than logged, so a future precedence change has to be a
          // deliberate decision instead of a silent one.
          //
          // The dangerous state this rules out is `enabled && !dialogShown` — a
          // permission bypass switched on by a keystroke aimed at the console.
          expect(CONFIRM.test(after)).toBe(true)
          expect(ENABLED.test(after)).toBe(false)

          // Escaping leaves no half-applied state.
          tui.send("Escape")
          await tui.waitFor((plain) => !CONFIRM.test(plain), 20_000)
          expect(tui.snapshot()).not.toMatch(ENABLED)
        },
        consoleEnv,
      )
    },
    journeyOptions,
  )

  test(
    "ctrl+y still works normally after the console is closed again",
    async () => {
      // Guards the practical regression: whatever the console does with the key, the
      // shortcut must not be left broken once the overlay is dismissed.
      await withJourney(
        "yolo console restore",
        async (tui) => {
          await booted(tui)
          await openConsole(tui)
          tui.send("C-o") // close
          await Bun.sleep(1500)

          tui.send("C-y")
          await tui.waitFor((plain) => CONFIRM.test(plain), 20_000)
          tui.send("y")
          await tui.waitFor((plain) => ENABLED.test(plain), 20_000)
        },
        consoleEnv,
      )
    },
    journeyOptions,
  )
})
