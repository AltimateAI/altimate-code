// altimate_change - new file
// TUI-only observer: correction text stays in memory, and the core is imported only
// after the interactive guard. The existing toast has no actions, so dismissal is a CLI command.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
// altimate_change start — honor the learning kill switch in the TUI
import { learnEnabled } from "@/altimate/learn/config"
// altimate_change end

export function nudgeEnvironmentAllowed(
  env: NodeJS.ProcessEnv = process.env,
  stdinTTY = process.stdin.isTTY,
  stdoutTTY = process.stdout.isTTY,
) {
  return env.CI === undefined && stdinTTY === true && stdoutTTY === true
}

type InstallOptions = {
  env?: NodeJS.ProcessEnv
  stdinTTY?: boolean
  stdoutTTY?: boolean
  load?: () => Promise<Pick<typeof import("@/altimate/learn/nudge"), "LearnNudge">>
}

export async function installLearnNudge(api: TuiPluginApi, options: InstallOptions = {}) {
  const env = options.env ?? process.env
  const interactive = () => nudgeEnvironmentAllowed(env, options.stdinTTY, options.stdoutTTY)
  // altimate_change start — disabled learning must not load or register the observer
  const learningEnabled = () => {
    // `learn` is fork-owned config and intentionally absent from the generated SDK types.
    const config = api.state.config as { learn?: { enabled?: boolean } }
    return learnEnabled(config.learn, env)
  }
  if (!interactive() || !learningEnabled()) return
  // altimate_change end

  const { LearnNudge } = await (options.load ?? (() => import("@/altimate/learn/nudge")))()
  // altimate_change start — recheck the kill switch after the lazy import
  if (api.lifecycle.signal.aborted || !learningEnabled()) return
  // altimate_change end

  const nudge = new LearnNudge({
    enabled: () => {
      // `learn` is fork-owned config and intentionally absent from the generated SDK types.
      const config = api.state.config as { learn?: { capture?: boolean } }
      return config.learn?.capture === true || /^(1|true)$/i.test(env.ALTIMATE_LEARN_CAPTURE ?? "")
    },
    project: () => {
      const route = api.route.current
      const sessionID = route.name === "session" ? route.params?.sessionID : undefined
      const projectID = typeof sessionID === "string" ? api.state.session.get(sessionID)?.projectID : undefined
      // Linked worktrees share the server's project identity. Nongit directories
      // use the shared "global" project, so keep their individual path identity.
      if (projectID && projectID !== "global") return `project:${projectID}`
      const { worktree, directory } = api.state.path
      return worktree && worktree !== "/" ? worktree : directory
    },
    eligible: (sessionID) => {
      const route = api.route.current
      // altimate_change start — recheck the kill switch before counting or recording a nudge
      return (
        learningEnabled() &&
        interactive() &&
        api.state.ready &&
        route.name === "session" &&
        route.params?.sessionID === sessionID
      )
      // altimate_change end
    },
    hasPriorAssistant: (sessionID, messageID) =>
      api.state.session
        .messages(sessionID)
        .some((message) => message.role === "assistant" && !!message.time.completed && message.id < messageID),
    show: (message) => api.ui.toast({ variant: "info", message, duration: 15000 }),
  })

  api.event.on("message.updated", (event) => nudge.onMessage(event.properties.info))
  api.event.on("message.part.updated", (event) => void nudge.onPart(event.properties.part))
  api.event.on("session.status", (event) => {
    if (event.properties.status.type === "idle") void nudge.onIdle(event.properties.sessionID)
  })
  api.lifecycle.onDispose(() => nudge.dispose())
}

const tui: TuiPlugin = async (api) => {
  await installLearnNudge(api)
}

const plugin: BuiltinTuiPlugin = { id: "altimate:learn-nudge", tui }
export default plugin
