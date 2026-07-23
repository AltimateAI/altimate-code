import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { Logo } from "./logo"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

// altimate_change — Claude-Code-style full-width boot box: big block wordmark on
// the left and a single "What is Altimate Code" section on the right. Shared
// between the home route and the session view so the header stays consistent
// when a command (e.g. /discover) starts a session. zIndex keeps it above
// transient top toasts (update/MCP) that would otherwise blank its top rows.
export function WelcomePanel() {
  const { theme } = useTheme()
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
            What is Altimate Code
          </text>
          <text fg={theme.textMuted} wrapMode="word" width="100%">
            Altimate Code is a specialized data engineering harness that sits between any LLM and your entire data
            stack. It gives your AI real context — column-level lineage, SQL analysis, dbt, and live warehouse
            metadata — so it reasons about your data instead of guessing.
          </text>
        </box>
      </box>
    </box>
  )
}
