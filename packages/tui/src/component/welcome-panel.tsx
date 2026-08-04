import { Show, createMemo } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { Logo } from "./logo"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { useReady } from "./altimate-onboarding"
import { welcomePanelVariant } from "./welcome-panel-utils"

// altimate_change — Claude-Code-style boot box: "What is Altimate Code" plus the
// readiness-aware CTA. Shared between the home route and the session view so the
// header stays consistent when a command (e.g. /discover) starts a session.
// zIndex keeps it above transient top toasts (update/MCP) that would otherwise
// blank its top rows.
//
// Responsive (issue #1067): the full two-column boot box with the block wordmark
// is ~65 cols wide and ~8 rows tall, which eats half a small terminal. So it
// scales down by terminal size, following the repo's breakpoint idiom
// (createMemo on useTerminalDimensions, e.g. routes/session/permission.tsx,
// component/upgrade-indicator.tsx). Both axes matter — the wordmark is wide AND
// tall:
//   full   — wordmark + full description (large terminals)
//   medium — title + one condensed line, no wordmark
//   compact — a single line; the border title already shows the version
export function WelcomePanel() {
  const { theme } = useTheme()
  const ready = useReady()
  const dimensions = useTerminalDimensions()

  const variant = createMemo(() => welcomePanelVariant(dimensions().width, dimensions().height))
  const compact = createMemo(() => variant() === "compact")
  const medium = createMemo(() => variant() === "medium")
  const full = createMemo(() => variant() === "full")

  const title = InstallationVersion === "local" ? " Altimate Code " : ` Altimate Code v${InstallationVersion} `

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title={title}
      titleAlignment="left"
      flexShrink={0}
      width="100%"
      zIndex={2000}
      backgroundColor={theme.background}
      flexDirection="column"
    >
      {/* compact — one line; the border title already carries the version */}
      <Show when={compact()}>
        <box paddingLeft={2} paddingRight={2} width="100%">
          <text fg={ready() ? theme.text : theme.primary} wrapMode="word" width="100%">
            {ready() ? "Your data-aware AI harness." : "Connect your AI model to start."}
          </text>
        </box>
      </Show>

      {/* medium — title + one condensed description + CTA, no block wordmark */}
      <Show when={medium()}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={0} width="100%">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Welcome to Altimate Code
          </text>
          <text fg={theme.text} wrapMode="word" width="100%">
            A data-engineering harness that gives your AI real context — column-level lineage, SQL analysis, dbt, and
            live warehouse metadata.
          </text>
          <Show when={!ready()}>
            <text fg={theme.primary} wrapMode="word" width="100%">
              Connect your AI model to start.
            </text>
          </Show>
        </box>
      </Show>

      {/* full — the original two-column boot box */}
      <Show when={full()}>
        <box flexDirection="row" width="100%">
          {/* left column — the block-letter wordmark */}
          <box
            width={65}
            flexShrink={0}
            alignItems="center"
            justifyContent="center"
            gap={1}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={1}
          >
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Welcome to Altimate Code
            </text>
            <Logo />
          </box>
          {/* right column — what-is section */}
          <box
            flexGrow={1}
            border={["left"]}
            borderColor={theme.border}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            gap={1}
          >
            <box gap={0}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                What is Altimate Code
              </text>
              <text fg={theme.text} wrapMode="word" width="100%">
                Altimate Code is a specialized data engineering harness that sits between any LLM and your entire data
                stack.
              </text>
              <text fg={theme.text} wrapMode="word" width="100%">
                It gives your AI real context — column-level lineage, SQL analysis, dbt, and live warehouse metadata —
                so it reasons about your data instead of guessing.
              </text>
              {/* CTA only until a model is connected — stale afterwards */}
              <Show when={!ready()}>
                <text fg={theme.primary} wrapMode="word" width="100%">
                  Connect your AI model to start.
                </text>
              </Show>
            </box>
          </box>
        </box>
      </Show>
    </box>
  )
}
