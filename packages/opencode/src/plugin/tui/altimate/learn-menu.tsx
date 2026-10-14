// altimate_change - new file
// `/learn`: the project's lessons and their sync with the workspace, in the session. Status, sync now, turn sync
// off or on, and the workspace's review queue in the browser. The logic lives in `@/altimate/learn/menu`; this file
// only renders it. Reviewing staged candidates and held proposals stays on the CLI for now.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import type { syncEnabled } from "@/altimate/learn/config"

type LearnConfig = Parameters<typeof syncEnabled>[0]

const id = "altimate:learn-menu"

/**
 * `learn` as the session loaded it, with the project config file's own `learn` keys on top: `/learn` writes that
 * file, and the session's copy is not reloaded until the next session.
 */
async function learnConfig(api: TuiPluginApi, root: string): Promise<LearnConfig> {
  // `learn` is fork-owned config and intentionally absent from the generated SDK types.
  const loaded = (api.state.config as { learn?: LearnConfig }).learn
  const { readProjectLearning } = await import("@/altimate/learn/project-config")
  const file = await readProjectLearning(root, api.state.path.directory).catch(() => undefined)
  return { ...loaded, ...file } as LearnConfig
}

const learnRoot = (api: TuiPluginApi) => (api.state.path.worktree !== "/" ? api.state.path.worktree : api.state.path.directory)

/** Whether the project is linked here, and the workspace's Learned rules tab when its web address is known. */
async function workspaceLink(directory: string): Promise<{ linked: boolean; queue: string | null }> {
  try {
    const [{ readLocalBinding }, { AltimateApi }, { buildManageUrl, resolveWorkspaceWebUrl }] = await Promise.all([
      import("@/altimate/workspace/state"), import("@/altimate/api/client"), import("@/altimate/workspace/browser-handoff"),
    ])
    const binding = await readLocalBinding(directory)
    if (!binding) return { linked: false, queue: null }
    const creds = await AltimateApi.getCredentials().catch(() => undefined)
    const base = creds ? resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName) : null
    return { linked: true, queue: base ? `${buildManageUrl(base, binding.datamateId)}?tab=learned-rules` : null }
  } catch {
    return { linked: false, queue: null }
  }
}

async function showLearnMenu(api: TuiPluginApi) {
  const directory = api.state.path.directory
  const root = learnRoot(api)
  const learn = await learnConfig(api, root)
  const [Menu, { lessonsLine }] = await Promise.all([import("@/altimate/learn/menu"), import("./workspace-sidebar")])
  const [summary, { linked, queue }] = await Promise.all([Menu.summary(root, directory, learn), workspaceLink(directory)])

  const rows: { title: string; value: string; description?: string; category: string }[] = [
    {
      title: `${summary.approved} approved ${summary.approved === 1 ? "lesson" : "lessons"}`,
      value: "info:approved",
      description: summary.staged.length
        ? `Staged changes in ${summary.staged.join(", ")}: review with \`altimate-code learn show\`, then \`learn promote\`.`
        : summary.learning ? "Nothing staged." : "Learning is off for this project.",
      category: "Lessons",
    },
  ]
  if (summary.sync) {
    rows.push({
      title: summary.lessons ? lessonsLine(summary.lessons) : "Not synced here yet",
      value: "info:sync",
      description: summary.unsupportedUntil
        ? `The workspace server does not support lesson sync yet; next try after ${summary.unsupportedUntil}.`
        : summary.pullError
          ? `Last pull failed: ${summary.pullError}`
          : summary.lessons
            ? "Approved team lessons are delivered; yours go to the workspace owner's review queue."
            : linked ? "Syncs at the start of a session and every few minutes during it." : "Link this project to a workspace to share lessons (/workspace).",
      category: "Sync",
    })
  } else {
    rows.push({
      title: "Lesson sync is off",
      value: "info:sync",
      description: summary.forcedOff ?? "Team lessons are not delivered and nothing is sent.",
      category: "Sync",
    })
  }

  const actions = [
    ...(summary.sync && linked ? [{ title: "Sync now", value: "sync", description: "Pull team lessons and send queued proposals.", category: "Actions" }] : []),
    ...(queue ? [{ title: "Open review queue", value: "open", description: "The workspace's Learned rules tab, in the browser.", category: "Actions" }] : []),
    // An environment override or kill switch wins over the project config, so the toggle would change nothing.
    ...(summary.forcedOff
      ? []
      : [summary.sync
          ? { title: "Turn sync off", value: "off", description: "Stop sharing lessons with the workspace; local lessons stay.", category: "Actions" }
          : { title: "Turn sync on", value: "on", description: "Share lessons with the linked workspace.", category: "Actions" }]),
    { title: "Done", value: "done", description: "Close this menu.", category: "Actions" },
  ]

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Learn"
      options={[...rows, ...actions]}
      current={actions[0].value}
      renderFilter={false}
      onSelect={(option) => {
        if (option.value.startsWith("info:")) return
        if (option.value === "open") {
          if (queue) void import("./workspace").then(({ openManageUrl }) => openManageUrl(api, queue))
          return
        }
        api.ui.dialog.clear()
        if (option.value === "sync") {
          api.ui.toast({ variant: "info", message: "Syncing lessons…", duration: 3_000 })
          Menu.syncNow(root, directory, learn)
            .then((result) => api.ui.toast({ variant: result.ok ? "success" : "warning", message: result.message, duration: 8_000 }))
            .catch((err) => api.ui.toast({ variant: "error", message: `Lesson sync failed: ${String(err)}`, duration: 8_000 }))
          return
        }
        if (option.value === "off" || option.value === "on") {
          const on = option.value === "on"
          Menu.setSync(root, directory, on)
            .then(({ file }) => {
              api.ui.toast({
                variant: "success",
                message: `Lesson sync turned ${on ? "on" : "off"} in ${file}. It applies from your next session.`,
                duration: 8_000,
              })
            })
            .catch((err) => api.ui.toast({ variant: "error", message: `Could not change lesson sync: ${String(err)}`, duration: 8_000 }))
        }
      }}
    />
  ))
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "altimate.learn.menu",
        title: "Learn",
        desc: "Project lessons and their sync with the workspace",
        category: "Altimate",
        namespace: "palette",
        slashName: "learn",
        run() {
          showLearnMenu(api).catch((err) => api.ui.toast({ variant: "error", message: `Learn menu failed: ${String(err)}`, duration: 8_000 }))
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }

export default plugin
