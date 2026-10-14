// altimate_change - new file
// `/learn`: the project's lessons and their sync with the workspace, in the session. Status, sync now, turn sync
// off or on, the workspace's review queue in the browser, reviewing and promoting staged changes, and resubmitting
// held proposals. The logic lives in `@/altimate/learn/menu`; this file only renders it.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { syncEnabled } from "@/altimate/learn/config"

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
  const [summary, { linked, queue }, held] = await Promise.all([
    Menu.summary(root, directory, learn), workspaceLink(directory), Menu.heldProposals(root, learn),
  ])

  const rows: { title: string; value: string; description?: string; category: string }[] = [
    {
      title: `${summary.approved} approved ${summary.approved === 1 ? "lesson" : "lessons"}`,
      value: "info:approved",
      description: summary.staged.length
        ? `Staged changes in ${summary.staged.join(", ")}: choose Review staged changes below.`
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
    ...summary.staged.map((store) => ({
      title: summary.staged.length > 1 ? `Review staged changes: ${store}` : "Review staged changes",
      value: `review:${store}`,
      description: "See what the candidate changes, then promote or discard it.",
      category: "Actions",
    })),
    ...(held.length
      ? [{ title: `Held proposals (${held.length})`, value: "held", description: "Proposals waiting for you after a conflict; resubmit them.", category: "Actions" }]
      : []),
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
        if (option.value.startsWith("review:")) {
          showStagedReview(api, root, directory, learn, option.value.slice("review:".length)).catch((err) => failed(api, err))
          return
        }
        if (option.value === "held") {
          showHeld(api, root, directory, learn).catch((err) => failed(api, err))
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

const failed = (api: TuiPluginApi, err: unknown) =>
  api.ui.toast({ variant: "error", message: err instanceof Error ? err.message : String(err), duration: 8_000 })

type Row = { title: string; value: string; description?: string; category: string }

/** A yes/no step before an action that changes lessons, like the CLI's confirmation prompt. */
function confirm(api: TuiPluginApi, title: string, yes: { title: string; description: string }, onYes: () => void, onNo: () => void) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={title}
      options={[
        { title: yes.title, value: "yes", description: yes.description },
        { title: "Cancel", value: "no", description: "Go back without changing anything." },
      ]}
      current="no"
      renderFilter={false}
      onSelect={(option) => (option.value === "yes" ? onYes() : onNo())}
    />
  ))
}

async function showStagedReview(api: TuiPluginApi, root: string, directory: string, learn: LearnConfig, store: string) {
  const Menu = await import("@/altimate/learn/menu")
  const review = await Menu.stagedReview(root, store)
  if (!review) {
    api.ui.dialog.clear()
    api.ui.toast({ variant: "info", message: `Nothing staged in "${store}" any more.`, duration: 5_000 })
    return
  }
  const rows: Row[] = [
    ...review.warnings.map((warning, i) => ({ title: `! ${warning}`, value: `info:warn:${i}`, category: "Check before promoting" })),
    ...review.added.map((lesson) => ({ title: `+ ${lesson.text}`, value: `info:add:${lesson.id}`, description: lesson.id, category: "Added" })),
    ...review.changed.map(({ before, after }) => ({
      title: `~ ${after.text}`,
      value: `info:change:${after.id}`,
      description: before.text === after.text ? `${after.id}: tags or pin changed` : `was: ${before.text}`,
      category: "Changed",
    })),
    ...review.removed.map((lesson) => ({ title: `- ${lesson.text}`, value: `info:remove:${lesson.id}`, description: lesson.id, category: "Removed" })),
  ]
  const count = review.added.length + review.changed.length + review.removed.length
  const actions: Row[] = [
    {
      title: "Promote",
      value: "promote",
      description: syncEnabled(learn) ? "Make these the approved lessons and send them for the owner's review." : "Make these the approved lessons.",
      category: "Actions",
    },
    { title: "Discard", value: "reject", description: "Throw the staged candidate away; the approved lessons stay.", category: "Actions" },
    { title: "Back", value: "back", description: "Return to the Learn menu.", category: "Actions" },
  ]
  const back = () => void showLearnMenu(api).catch((err) => failed(api, err))
  const again = () => void showStagedReview(api, root, directory, learn, store).catch((err) => failed(api, err))
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={`Staged changes · ${store} · ${count} ${count === 1 ? "change" : "changes"}`}
      options={[...rows, ...actions]}
      current="promote"
      renderFilter={false}
      onSelect={(option) => {
        if (option.value.startsWith("info:")) return
        if (option.value === "back") return back()
        if (option.value === "promote")
          return confirm(api, `Promote ${count} ${count === 1 ? "change" : "changes"} to "${store}"?`,
            { title: "Promote", description: review.warnings.length ? "Including the lessons flagged above." : "The previous version is archived; `learn rollback` restores it." },
            () => {
              api.ui.dialog.clear()
              Menu.promote(root, directory, store, review.candidateHash, learn)
                .then((result) => api.ui.toast({ variant: "success", message: result.message, duration: 8_000 }))
                .catch((err) => failed(api, err))
            }, again)
        if (option.value === "reject")
          return confirm(api, `Discard the staged candidate for "${store}"?`,
            { title: "Discard", description: "This cannot be undone; the approved lessons stay as they are." },
            () => {
              api.ui.dialog.clear()
              import("@/altimate/learn/store")
                .then((Store) => Store.reject(root, store))
                .then((done) => api.ui.toast({ variant: "success", message: done ? `Discarded the candidate for "${store}".` : `No candidate for "${store}".`, duration: 6_000 }))
                .catch((err) => failed(api, err))
            }, again)
      }}
    />
  ))
}

async function showHeld(api: TuiPluginApi, root: string, directory: string, learn: LearnConfig) {
  const Menu = await import("@/altimate/learn/menu")
  const held = await Menu.heldProposals(root, learn)
  const back = () => void showLearnMenu(api).catch((err) => failed(api, err))
  if (!held.length) {
    api.ui.dialog.clear()
    api.ui.toast({ variant: "info", message: "No held proposals.", duration: 5_000 })
    return
  }
  // One row per key: a resubmit sends every held proposal for that key.
  const keys = [...new Map(held.map((p) => [p.lesson_key, p])).values()]
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={`Held proposals · ${held.length}`}
      options={[
        ...keys.map((p) => ({ title: `${p.change_type} ${p.lesson_key}: ${p.text}`, value: `key:${p.lesson_key}`, description: p.reason, category: "Held" })),
        { title: "Back", value: "back", description: "Return to the Learn menu.", category: "Actions" },
      ]}
      current={`key:${keys[0].lesson_key}`}
      renderFilter={false}
      onSelect={(option) => {
        if (option.value === "back") return back()
        const key = option.value.slice("key:".length)
        confirm(api, `Resubmit ${key}?`,
          { title: "Resubmit", description: "Send it again against the workspace's current version. Review the conflict there first." },
          () => {
            api.ui.dialog.clear()
            api.ui.toast({ variant: "info", message: `Resubmitting ${key}…`, duration: 3_000 })
            Menu.resubmit(root, directory, key, learn)
              .then((result) => api.ui.toast({ variant: result.ok ? "success" : "warning", message: result.message, duration: 8_000 }))
              .catch((err) => failed(api, err))
          },
          () => void showHeld(api, root, directory, learn).catch((err) => failed(api, err)))
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
