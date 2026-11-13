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
          // Returns quickly (one `claude --version`) so the dialog shows its waiting screen; the login
          // check (which starts `claude` and reads every model's context window) runs in the callback.
          async authorize() {
            // A missing or outdated `claude` is named on the waiting screen, since the login check
            // below only logs why it has not connected yet.
            const blocker = await ClaudeAgent.setupProblem().catch(() => undefined)
            return {
              url: SETUP_URL,
              method: "auto" as const,
              instructions: blocker
                ? `${blocker} This connects as soon as a supported Claude Code is logged in.`
                : "Checking your Claude Code login. If you have not logged in yet, run `claude auth login` in a terminal; this connects as soon as it finds the login.",
              async callback() {
                // Bound to this instance; the dialog can be dismissed or the instance reloaded while this
                // polls, and nothing cancels the callback, so it stops once the instance is disposed.
                const login = await ClaudeAgent.loginCheck()
                const deadline = Date.now() + RECHECK_LIMIT_MS
                while (!login.disposed()) {
                  const reason = ClaudeAgent.problem(await login.run())
                  if (!reason) return { type: "success" as const, key: ClaudeAgent.AUTH_KEY }
                  if (Date.now() >= deadline) {
                    log.warn("Claude Code login was not found", { reason })
                    return { type: "failed" as const }
                  }
                  await Bun.sleep(RECHECK_MS)
                }
                return { type: "failed" as const }
              },
            }
          },
        },
      ],
    },
  }
}
