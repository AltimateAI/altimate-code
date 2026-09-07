import { Match, Show, Switch, createMemo } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { Logo } from "./logo"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { useReady } from "./altimate-onboarding"
import { welcomePanelVariant } from "./welcome-panel-utils"

const CONNECT_CTA = "Connect your AI model to start."

// altimate_change — Claude-Code-style boot box: "What is Altimate Code" plus the
// readiness-aware CTA. Shared between the home route and the session view so the
// header stays consistent when a command (e.g. /discover) starts a session.
// zIndex keeps it above transient top toasts (update/MCP) that would otherwise
// blank its top rows.
//
// Responsive (issue #1067): the full two-column boot box is a ~13-row bordered
// box that ate ~40% of the screen. It now scales down by AVAILABLE size — the
// caller measures the terminal (useTerminalDimensions) and passes what the panel
// actually gets, following the repo's breakpoint idiom (a createMemo over the
// reactive dimensions, cf. routes/session/permission.tsx:450,
// component/upgrade-indicator.tsx:14):
//   full   — wordmark + full description (large windows only)
//   medium — title + a condensed description (one line on a wide terminal, two at
//            medium's narrow end), no wordmark (the common case)
//   compact — a short line; the border title already carries the version
//
// `availableWidth` / `availableHeight` are the space the panel actually gets, not
// the whole terminal — the caller subtracts its padding, any sibling sidebar
// (session's contentWidth), and the route's vertical reserve (HOME/SESSION_
// VERTICAL_RESERVE). Using the raw terminal would keep `full` selected in a
// sidebar-narrowed column or a short window and swell the panel back up — the bug
// #1067 is about. Both props are REQUIRED: a call site that forgot one would
// silently get the pre-fix raw-terminal behavior, so the type system guards it
// (there's no in-repo render test of the call sites).
export function WelcomePanel(props: { availableWidth: number; availableHeight: number }) {
  const { theme } = useTheme()
  const ready = useReady()

  // props are reactive getters, so reading them inside the memo tracks — the
  // variant recomputes when the caller's dimensions/sidebar change.
  const variant = createMemo(() => welcomePanelVariant(props.availableWidth, props.availableHeight))

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
      <Switch>
        {/* compact — a short line; the border title already carries the version.
            wrapMode keeps it readable if the terminal is extremely narrow. */}
        <Match when={variant() === "compact"}>
          <box paddingLeft={2} paddingRight={2} width="100%">
            <text fg={ready() ? theme.text : theme.primary} wrapMode="word" width="100%">
              {ready() ? "Your data-aware AI harness." : CONNECT_CTA}
            </text>
          </box>
        </Match>

        {/* medium — title + one condensed description + CTA, no block wordmark */}
        <Match when={variant() === "medium"}>
          <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={0} width="100%">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Welcome to Altimate Code
            </text>
            <text fg={theme.text} wrapMode="word" width="100%">
              Gives your AI real context on your data stack — lineage, SQL, dbt, and live warehouse metadata.
            </text>
            <Show when={!ready()}>
              <text fg={theme.primary} wrapMode="word" width="100%">
                {CONNECT_CTA}
              </text>
            </Show>
          </box>
        </Match>

        {/* full — the original two-column boot box */}
        <Match when={variant() === "full"}>
          <box flexDirection="row" width="100%">
            {/* left column — the block-letter wordmark (logo is ~50 cols) */}
            <box
              width={54}
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
                    {CONNECT_CTA}
                  </text>
                </Show>
              </box>
            </box>
          </box>
        </Match>
      </Switch>
    </box>
  )
}
