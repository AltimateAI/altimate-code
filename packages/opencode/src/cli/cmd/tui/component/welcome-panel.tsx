import { Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { Logo } from "@tui/component/logo"
import { useReady } from "@tui/component/dialog-model"
import { Installation } from "@/installation"

// altimate_change — Claude-Code-style full-width boot box: big block wordmark on
// the left, a "Tips for getting started" section (readiness-aware: /connect →
// /discover) and a "What is Altimate Code" section on the right. Shared between
// the home route and the session view so the header stays consistent when a
// command (e.g. /discover) starts a session. zIndex keeps it above transient top
// toasts (update/MCP) that would otherwise blank its top rows.
export function WelcomePanel() {
  const { theme } = useTheme()
  const ready = useReady()
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title={Installation.VERSION === "local" ? " Altimate Code " : ` Altimate Code v${Installation.VERSION} `}
      titleAlignment="left"
      flexShrink={0}
      width="100%"
      zIndex={2000}
      backgroundColor={theme.background}
      flexDirection="row"
    >
      {/* left column — the block-letter wordmark (59 cols wide) */}
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
      {/* right column — tips + what-is sections */}
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
        {/* "What is Altimate Code" comes FIRST — a first-time user reads what the
            product is before anything else. This is the ONLY place the copy renders. */}
        <box gap={0}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            What is Altimate Code
          </text>
          <text fg={theme.textMuted} wrapMode="word" width="100%">
            Altimate Code is a specialized data engineering harness that sits between any LLM and your entire data
            stack. It gives your AI real context — column-level lineage, SQL analysis, dbt, and live warehouse
            metadata — so it reasons about your data instead of guessing.
          </text>
          {/* CTA only until a model is connected — stale afterwards */}
          <Show when={!ready()}>
            <text fg={theme.text} wrapMode="word" width="100%">
              Connect your AI model to start.
            </text>
          </Show>
        </box>
        {/* Warehouse//discover guidance is premature before a model exists —
            it appears only once a model is connected. */}
        <Show when={ready()}>
          <box border={["top"]} borderColor={theme.border} />
          <box gap={0}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              Tips for getting started
            </text>
            <text wrapMode="word" width="100%">
              <span style={{ fg: theme.textMuted }}>Connect your warehouse or dbt project — run </span>
              <span style={{ fg: theme.primary }}>/discover</span>
              <span style={{ fg: theme.textMuted }}>
                {" "}
                to detect your data stack, then just say what you want to do
              </span>
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}
