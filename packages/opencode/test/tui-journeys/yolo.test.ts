// altimate_change — real-binary journey for the YOLO mode ctrl+y toggle.
//
// Covers the four states the spec mocks up, in order:
//   1. the `ctrl+y yolo` hint is visible on the chat panel
//   2. ctrl+y opens a confirmation prompt that requires an explicit Yes/No
//   3. answering Yes shows the enabled state
//   4. ctrl+y again turns it off with NO confirmation prompt
//
// Plus the properties that are easy to regress and invisible in a screenshot:
// declining leaves it off, the shortcut exists before the first prompt has created
// a session, and the confirmation copy states which guardrails survive.
//
// Every journey pins ALTIMATE_CLI_YOLO=false. Without it the suite inherits whatever
// the developer's shell has set (yolo is a common local default), which silently
// inverts the starting state and makes the first ctrl+y a *disable*.
import { describe, expect, test } from "bun:test"
import { booted, submitPrompt, suiteEnabled, withJourney, type TmuxJourney } from "./harness"

const maybeDescribe = suiteEnabled() ? describe : describe.skip
const journeyOptions = { timeout: 75_000, retry: 1 }
const journeyEnv = { env: { ALTIMATE_CLI_YOLO: "false" } }

const CONFIRM = /Turn on YOLO mode for this session\?/i
const ENABLED = /YOLO ON/i
const HINT_OFF = /ctrl\+y\s+yolo/i

async function openConfirm(tui: TmuxJourney) {
  tui.send("C-y")
  await tui.waitFor((plain) => CONFIRM.test(plain), 20_000)
}

async function inSession(tui: TmuxJourney) {
  await booted(tui)
  await tui.ctx.llm.text("ready")
  await submitPrompt(tui, "hi")
  await tui.waitFor((plain) => plain.includes("ready"), 30_000)
}

maybeDescribe("real-binary TUI journeys: yolo mode", () => {
  test(
    "yolo: hint shows, ctrl+y confirms, Yes enables, ctrl+y disables without confirming",
    async () => {
      await withJourney(
        "yolo toggle round trip",
        async (tui) => {
          await inSession(tui)

          // 1. hint on the chat panel, in the off state
          await tui.waitFor((plain) => HINT_OFF.test(plain), 20_000)
          expect(tui.snapshot()).not.toMatch(ENABLED)

          // 2. ctrl+y asks first rather than enabling straight away
          await openConfirm(tui)
          const confirmScreen = tui.snapshot()
          expect(confirmScreen).toMatch(/Yes/)
          expect(confirmScreen).toMatch(/No/)

          // 3. Yes enables, and the enabled state is visible
          tui.send("y")
          await tui.waitFor((plain) => ENABLED.test(plain), 20_000)

          // 4. ctrl+y again turns it off WITHOUT a confirmation prompt
          tui.send("C-y")
          await tui.waitFor((plain) => !ENABLED.test(plain), 20_000)
          expect(tui.snapshot()).not.toMatch(CONFIRM)
        },
        journeyEnv,
      )
    },
    journeyOptions,
  )

  test(
    "yolo: answering No leaves it off",
    async () => {
      await withJourney(
        "yolo confirm declined",
        async (tui) => {
          await inSession(tui)
          await openConfirm(tui)
          tui.send("n")
          await tui.waitFor((plain) => !CONFIRM.test(plain), 20_000)
          expect(tui.snapshot()).not.toMatch(ENABLED)
        },
        journeyEnv,
      )
    },
    journeyOptions,
  )

  test(
    "yolo: escape dismisses the confirmation without enabling",
    async () => {
      await withJourney(
        "yolo confirm escaped",
        async (tui) => {
          await inSession(tui)
          await openConfirm(tui)
          tui.send("Escape")
          await tui.waitFor((plain) => !CONFIRM.test(plain), 20_000)
          expect(tui.snapshot()).not.toMatch(ENABLED)
        },
        journeyEnv,
      )
    },
    journeyOptions,
  )

  test(
    "yolo: the shortcut works on the welcome screen, before any session exists",
    async () => {
      // Regression guard: the command was originally registered in the session route,
      // so on first launch the hint was missing and ctrl+y did nothing at all.
      await withJourney(
        "yolo pre-session",
        async (tui) => {
          await booted(tui)
          await tui.waitFor((plain) => HINT_OFF.test(plain), 20_000)
          await openConfirm(tui)
          tui.send("y")
          await tui.waitFor((plain) => ENABLED.test(plain), 20_000)
        },
        journeyEnv,
      )
    },
    journeyOptions,
  )

  test(
    "yolo: the confirmation states which guardrails survive",
    async () => {
      // The prompt must not read as "the agent can now do anything". Server-side deny
      // rules (DROP DATABASE / DROP SCHEMA / TRUNCATE) are never auto-approved because
      // Permission.ask refuses them before any event reaches the TUI, and a user
      // deciding Yes/No is entitled to know that.
      await withJourney(
        "yolo confirm copy",
        async (tui) => {
          await booted(tui)
          await openConfirm(tui)
          const plain = tui.snapshot()
          expect(plain).toMatch(/DROP DATABASE/i)
          expect(plain).toMatch(/[Ss]till blocked/)
          expect(plain).toMatch(/session only|turns off when you quit/i)
        },
        journeyEnv,
      )
    },
    journeyOptions,
  )
})
