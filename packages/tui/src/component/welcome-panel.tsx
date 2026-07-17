import { Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { Logo } from "./logo"
import { useReady } from "./altimate-onboarding"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

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
      title={InstallationVersion === "local" ? " Altimate Code " : ` Altimate Code v${InstallationVersion} `}
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
        <box gap={0}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            Tips for getting started
          </text>
          <Show
            when={ready()}
            fallback={
              <text wrapMode="word" width="100%">
                <span style={{ fg: theme.textMuted }}>Run </span>
                <span style={{ fg: theme.primary }}>/connect</span>
                <span style={{ fg: theme.textMuted }}>
                  {" "}
                  to pick your AI model provider — 75+ providers supported · Altimate LLM Gateway recommended (10M free
                  tokens)
                </span>
              </text>
            }
          >
            <text wrapMode="word" width="100%">
              <span style={{ fg: theme.textMuted }}>Now connect your warehouse or dbt project — run </span>
              <span style={{ fg: theme.primary }}>/discover</span>
              <span style={{ fg: theme.textMuted }}>
                {" "}
                to detect your data stack, then just say what you want to do
              </span>
            </text>
          </Show>
        </box>
        <box border={["top"]} borderColor={theme.border} />
        <box gap={0}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            What is Altimate Code
          </text>
          <text fg={theme.textMuted} wrapMode="word" width="100%">
            The intelligence layer for data engineering AI — 100+ deterministic tools for SQL analysis, column-level
            lineage, dbt, FinOps, and warehouse connectivity across every major cloud platform.
          </text>
          <text fg={theme.textMuted} wrapMode="word" width="100%">
            Run standalone in your terminal, embed underneath Claude Code or Codex, or integrate into CI pipelines and
            orchestration DAGs. Precision data tooling for any LLM.
          </text>
        </box>
      </box>
    </box>
  )
}
