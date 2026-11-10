import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "@/util/log"
import { ClaudeAgent } from "./index"

const log = Log.create({ service: "claude-agent.plugin" })

const SETUP_URL = "https://code.claude.com/docs/en/setup"
// While /connect is open, check again on this interval so `claude auth login` in another
// terminal is picked up without restarting the dialog.
const RECHECK_MS = 3_000
const RECHECK_LIMIT_MS = 5 * 60_000

// Ported from upstream's `ClaudeIntegration` and the plugin's session-idle subscription.
// The login method only records that the user chose Claude Code. The login itself belongs to
// `claude`, and the CLI never reads or stores its token.
export async function ClaudeAgentPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    config: async (config) => {
      await ClaudeAgent.configure(config.provider?.[ClaudeAgent.ID]?.options)
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      await ClaudeAgent.idle(event.properties.sessionID).catch((error) =>
        log.warn("failed to release an idle Claude session", { error }),
      )
    },
    auth: {
      provider: ClaudeAgent.ID,
      methods: [
        {
          type: "oauth",
          label: "Claude Code login (claude auth login)",
          async authorize() {
            const first = ClaudeAgent.problem(await ClaudeAgent.check())
            return {
              url: SETUP_URL,
              method: "auto" as const,
              instructions: first
                ? `${first} This dialog connects as soon as Claude Code is logged in.`
                : "Claude Code is logged in. Connecting…",
              async callback() {
                const success = { type: "success" as const, key: ClaudeAgent.AUTH_KEY }
                if (!first) return success
                const deadline = Date.now() + RECHECK_LIMIT_MS
                let reason = first
                while (Date.now() < deadline) {
                  await Bun.sleep(RECHECK_MS)
                  const next = ClaudeAgent.problem(await ClaudeAgent.check())
                  if (!next) return success
                  reason = next
                }
                log.warn("Claude Code login was not found", { reason })
                return { type: "failed" as const }
              },
            }
          },
        },
      ],
    },
  }
}
