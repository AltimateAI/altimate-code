import { Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { Logo } from "@tui/component/logo"
import { useReady } from "@tui/component/dialog-model"
import { Installation } from "@/installation"

// altimate_change — Claude-Code-style full-width boot box: big block wordmark on
// the left and a "What is Altimate Code" section on the right. Shared between the
// home route and the session view so the header stays consistent when a command
// (e.g. /discover) starts a session. zIndex keeps it above transient top toasts
// (update/MCP) that would otherwise blank its top rows.
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
        {/* The only text in the boot box: what Altimate Code is. Rendered brighter
            (full text color, not muted) as the prominent, primary content. The two
            description sentences share one inner box (no gap) so they stay uniformly
            single-spaced; if the second sentence wraps, its continuation lines up with
            the rest instead of looking cramped against a blank-line-separated sibling.
            The outer gap keeps the heading and CTA spaced. No tips here. */}
        <box gap={1}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            What is Altimate Code
          </text>
          <box>
            <text fg={theme.text} wrapMode="word" width="100%">
              Altimate Code is a specialized data engineering harness that sits between any LLM and your entire data
              stack.
            </text>
            <text fg={theme.text} wrapMode="word" width="100%">
              It gives your AI real context — column-level lineage, SQL analysis, dbt, and live warehouse metadata — so
              it reasons about your data instead of guessing.
            </text>
          </box>
          {/* CTA only until a model is connected — stale afterwards */}
          <Show when={!ready()}>
            <text fg={theme.primary} wrapMode="word" width="100%">
              Connect your AI model to start.
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}
