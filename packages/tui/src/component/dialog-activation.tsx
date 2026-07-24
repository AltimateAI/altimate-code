import { createMemo, createSignal, For, onMount } from "solid-js"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
// Detection + KV constants live TUI-side (this file's siblings under
// `../altimate/onboarding/`). TUI can't import from `packages/opencode`,
// so a TUI-only "display-order" detection lives here — see
// tui-detection.ts docstring for the ownership split.
import { detectUsableSetup, type UsableSetupVerdict } from "../altimate/onboarding/tui-detection"
import {
  ACTIVATION_CHOICES,
  KV_ACTIVATION_COMPLETED_CHOICE,
  KV_ACTIVATION_DISMISSED_AT,
  type ActivationChoice,
} from "../altimate/onboarding/kv-keys"
import { useTheme, selectedForeground } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useKV } from "../context/kv"

/**
 * First-run activation prompt — Step 2b of onboarding. Fires ONLY when the
 * user dismissed the scan-gate ("No" on `DialogScanGate`) with no dbt
 * project + no continuation. Also re-openable via the `/activation` slash
 * command.
 *
 * The three options mirror the ticket's target UX:
 *   - Connect data           → runs the existing `/onboard-connect scan` flow
 *   - Open sample project    → dispatches `/starter` (materializes + opens
 *                              the shipped jaffle-shop DuckDB sample)
 *   - Describe your own      → closes the dialog and prefills the prompt
 *     use case                buffer with a starter hint; user types
 *
 * Options are ordered by `detectUsableSetup(cwd)` — a project-with-usable-
 * profile setup leads with "Connect data", otherwise "Open sample project"
 * is first. Ordering only; every option remains selectable regardless.
 *
 * On any selection (including "not now"-style escape), we persist:
 *   - `KV_ACTIVATION_COMPLETED_CHOICE` — the choice enum
 *   - `KV_ACTIVATION_DISMISSED_AT`     — ISO timestamp
 * so the dialog does not auto-fire on future launches. The `/activation`
 * slash command is the escape hatch that re-opens it manually.
 *
 * `onChoose` is injected by App (which lives inside PromptRefProvider);
 * the dialog overlay sits above that provider, so this component cannot
 * dispatch slash commands itself — it hands the choice back to App.
 */
export function DialogActivation(props: { onChoose: (choice: ActivationChoice) => void }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const kv = useKV()
  // `selected` starts at -1 while detection is pending so an Enter press
  // BEFORE detection resolves does nothing — otherwise a user with a
  // detected-usable dbt project could hit Enter on the sample-first
  // fallback ordering and end up running /starter when "Connect data"
  // was the intended default. Detection typically finishes in <100ms
  // (fs walk + regex); the render impact is a single frame of "checking…".
  const [selected, setSelected] = createSignal<number>(-1)
  const [verdict, setVerdict] = createSignal<UsableSetupVerdict | undefined>(undefined)

  onMount(() => {
    dialog.setSize("large")
    // We probe `process.cwd()` — the shell dir the user launched
    // altimate-code from. For normal launches this is what we want. If a
    // wrapper (Codespaces launcher, custom shim) calls `process.chdir`
    // before invoking us, cwd could point at the wrapper's install path
    // instead of the user's dbt project — verdict downgrades to
    // "nothing", ordering leads with sample. Not catastrophic; user can
    // still pick "Connect data" manually. Documented Phase 5 e2e check.
    void detectUsableSetup(process.cwd())
      .then((r) => {
        setVerdict(r.verdict)
        setSelected(0) // now safe to enable Enter
      })
      .catch(() => {
        // Detection failure is not fatal — fall back to "sample first" order.
        setVerdict("nothing")
        setSelected(0)
      })
  })

  const options = createMemo(() => {
    const connect = {
      key: "connect_data" as const,
      label: "Connect data",
      help: "Point altimate at your dbt project + warehouse. I'll walk you through it.",
    }
    const sample = {
      key: "sample_project" as const,
      label: "Open sample project",
      help: "Try a preloaded jaffle-shop DuckDB project. No credentials, no cloud, works offline.",
    }
    const describe = {
      key: "describe_use_case" as const,
      label: "Describe your own use case",
      help: "Just tell me what you're trying to do — SQL, lineage, cost analysis, whatever.",
    }
    // A "usable" setup means dbt_project.yml + a resolvable profile —
    // lead with connect, since the user's real project is the highest-value
    // next action. Otherwise sample-first: it's a working experience with
    // zero setup cost.
    return verdict() === "usable" ? [connect, sample, describe] : [sample, connect, describe]
  })

  function run(choice: ActivationChoice) {
    // Persist BOTH keys atomically-enough (KV writes are individually
    // atomic via writeJsonAtomic + Flock, so two writes could interleave
    // with another process — but a future launch reading "dismissed_at set,
    // completed_choice missing" is a benign state we can handle by simply
    // not re-firing the dialog).
    kv.set(KV_ACTIVATION_COMPLETED_CHOICE, choice)
    kv.set(KV_ACTIVATION_DISMISSED_AT, new Date().toISOString())
    dialog.clear()
    props.onChoose(choice)
  }

  useKeyboard((evt) => {
    // Escape works even while detection is still resolving — the user
    // should never feel trapped by a "checking..." state.
    if (evt.name === "escape") {
      evt.preventDefault()
      run("dismissed")
      return
    }
    // All other keys are gated on detection having resolved (selected != -1).
    // Prevents Enter from firing the fallback ordering when the real
    // verdict is still ~100ms away.
    if (selected() < 0) return
    if (evt.name === "up") {
      setSelected((prev) => (prev - 1 + options().length) % options().length)
      evt.preventDefault()
      return
    }
    if (evt.name === "down") {
      setSelected((prev) => (prev + 1) % options().length)
      evt.preventDefault()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      const opt = options()[selected()]
      if (opt) run(opt.key)
      return
    }
    // Numeric shortcuts 1/2/3 — no modifier keys so users can't
    // accidentally trigger them while typing elsewhere.
    if (!evt.ctrl && !evt.meta) {
      const asNumber = Number(evt.name)
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options().length) {
        evt.preventDefault()
        run(options()[asNumber - 1]!.key)
      }
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        title=" What's next? "
        titleAlignment="left"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {selected() < 0 ? "Checking local project…" : "Pick one — or press esc to skip"}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => run("dismissed")}>
            esc
          </text>
        </box>
        <text fg={theme.textMuted}>You can always run /activation later to reopen this.</text>
        <box gap={1}>
          <For each={options()}>
            {(option, index) => {
              const active = () => selected() === index()
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseMove={() => setSelected(index())}
                  onMouseUp={() => run(option.key)}
                >
                  <text flexShrink={0} fg={theme.primary}>
                    {active() ? "❯" : " "}
                  </text>
                  <box
                    width={3}
                    flexShrink={0}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={active() ? theme.primary : transparent}
                  >
                    <text fg={active() ? selFg : theme.textMuted}>{index() + 1}</text>
                  </box>
                  <box flexShrink={0} width={28}>
                    <text
                      fg={active() ? theme.primary : theme.text}
                      attributes={active() ? TextAttributes.BOLD : undefined}
                    >
                      {option.label}
                    </text>
                  </box>
                  <box flexGrow={1}>
                    <text wrapMode="word" width="100%" fg={theme.textMuted}>
                      {option.help}
                    </text>
                  </box>
                </box>
              )
            }}
          </For>
        </box>
      </box>
    </box>
  )
}

// Re-export from onboarding module for App to consume without cross-package
// import juggling. App reads the choice enum to know which slash command
// to submit.
export { ACTIVATION_CHOICES }
export type { ActivationChoice }
