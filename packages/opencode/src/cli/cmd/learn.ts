// altimate_change - new file
//
// `altimate-code learn`: turn a finished session plus external feedback (CI or
// verifier output, review comments, user corrections) into bounded, linted edits
// to a project lesson store, then optionally publish it to the workspace.
// Reflected edits are staged until `learn promote`; pin/unpin directly updates
// approved lesson metadata.
import type { Argv } from "yargs"
import { EOL } from "os"
import fs from "node:fs/promises"
import path from "node:path"
// altimate_change start — unique sibling files for atomic project config updates
import { randomUUID } from "node:crypto"
// altimate_change end
import * as prompts from "@clack/prompts"
import { Cause, Effect } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Playbook from "../../altimate/learn/playbook"
import * as Store from "../../altimate/learn/store"
import { MAX_TEXT, summarize, describeApplied, describeRejected } from "../../altimate/learn/curator"
import { sourceFromTrajectory, redactSecrets, type DigestSource } from "../../altimate/learn/digest"
import { DEFAULT_TIMEOUT_MS, FEEDBACK_KINDS, providerGenerate, type FeedbackKind, type Generate } from "../../altimate/learn/reflect"
import * as Signals from "../../altimate/learn/signals"
import { learnMaxStored, learnModel } from "../../altimate/learn/auto"
import { autoReflectEnabled, captureEnabled } from "../../altimate/learn/capture"
// altimate_change start — report the learning kill switch independently of capture
import { learnEnabled } from "../../altimate/learn/config"
// altimate_change end
import { fileHookEnabled, resolveLimits } from "../../altimate/learn/select"
import { errText, prepareReflection, reflectCore, reflectSessionSignals, sourceFromSession } from "../../altimate/learn/session-reflect"
import { bootstrap, DEFAULT_BOOTSTRAP_LIMIT, DEFAULT_MAX_REFLECTIONS, DEFAULT_MAX_SECONDS, type BootstrapModel } from "../../altimate/learn/bootstrap"
import { importReviews } from "../../altimate/learn/import-reviews"
import { formatUsage } from "../../altimate/learn/usage"
// altimate_change start — log best-effort learning maintenance failures
import { Log } from "../../util/log"

const log = Log.create({ service: "learn.cli" })
// altimate_change end

const out = (text: string) => process.stdout.write(text + EOL)

const nameOption = (yargs: Argv) =>
  yargs.option("name", {
    type: "string",
    default: Playbook.DEFAULT_NAME,
    describe: "lesson store name",
  })

/** The project root: where `.altimate-code/` lives and what `skill publish` treats as the boundary. */
async function projectRoot() {
  const { Instance } = await import("@/project/instance")
  return Instance.worktree !== "/" ? Instance.worktree : Instance.directory
}

const run = <A>(label: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => e,
  }).pipe(
    Effect.catch((e) => fail(`${label}${errText(e)}`)),
  )

const START_HINT =
  "Run `altimate-code learn reflect --session <id> --feedback <file>` to start (find a session id with `altimate-code session list`)."

// altimate_change start — explain how to re-enable the learning kill switch
const LEARN_DISABLED_HINT =
  "Learning stays disabled; set learn.enabled=true or ALTIMATE_LEARN=1 to re-enable (ALTIMATE_LEARN overrides config)."
// altimate_change end

/** Match the project locations loaded by Config, never the user's global configuration. */
async function writeProjectLearning(root: string, enabled: boolean): Promise<string> {
  // altimate_change start — match discovered project config precedence from the current directory
  const [{ Instance }, { Filesystem }] = await Promise.all([
    import("@/project/instance"), import("@/util/filesystem"),
  ])
  // Config merges in the opposite order. Edit the highest-precedence existing project file
  // so a second supported config cannot silently override the new opt-in setting.
  const names = ["opencode.jsonc", "opencode.json", "altimate-code.jsonc", "altimate-code.json"]
  const directories: string[] = []
  for await (const dir of Filesystem.up({ targets: [".altimate-code", ".opencode"], start: Instance.directory, stop: root }))
    directories.push(dir)
  const candidates = directories.reverse().flatMap((dir) => names.map((name) => path.join(dir, name)))
  for await (const file of Filesystem.up({ targets: ["opencode.jsonc", "opencode.json"], start: Instance.directory, stop: root }))
    candidates.push(file)
  // altimate_change end
  let file = path.join(root, ".altimate-code", "altimate-code.json")
  let text = "{}\n"
  for (const candidate of candidates) {
    const current = await fs.readFile(candidate, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (current === undefined) continue
    file = candidate
    text = current
    break
  }
  const errors: ParseError[] = []
  const config = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config))
    throw new Error(`Cannot update ${file}: expected a JSON configuration object.`)
  const indent = /^([ \t]+)"/m.exec(text)?.[1]
  const formattingOptions = {
    insertSpaces: !indent?.includes("\t"),
    tabSize: indent?.length ?? 2,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  }
  // Like the MCP config writer, patch JSONC without expanding variables or rewriting other keys.
  for (const key of ["capture", "auto_reflect"])
    text = applyEdits(text, modify(text, ["learn", key], enabled, { formattingOptions }))
  await fs.mkdir(path.dirname(file), { recursive: true })
  // altimate_change start — preserve config targets and permissions during atomic project updates
  const target = await fs.realpath(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return file
    throw error
  })
  const mode = await fs.stat(target).then((stat) => stat.mode & 0o777).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return 0o600
    throw error
  })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, text, { flag: "wx", mode })
    await fs.chmod(temporary, mode)
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true })
  }
  // altimate_change end
  return file
}

// altimate_change start — explain effective capture overrides after project opt-in
async function captureOverrideHint(): Promise<string> {
  const value = process.env.ALTIMATE_LEARN_CAPTURE
  if (value === "0" || value?.toLowerCase() === "false")
    return `ALTIMATE_LEARN_CAPTURE=${value} overrides config. Unset it or set ALTIMATE_LEARN_CAPTURE=1.`
  if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    const source = process.env.ALTIMATE_CLI_DISABLE_PROJECT_CONFIG ? "ALTIMATE_CLI_DISABLE_PROJECT_CONFIG" : "OPENCODE_DISABLE_PROJECT_CONFIG"
    return `Project config loading is disabled by ${source}. Unset it and run \`altimate-code learn enable\` again.`
  }
  const [{ Config }, { ConfigManaged }, { env }] = await Promise.all([
    import("@/config/config"), import("@/config/managed"), import("@opencode-ai/core/flag/flag"),
  ])
  const names = ["altimate-code.json", "altimate-code.jsonc", "opencode.json", "opencode.jsonc"]
  const directories = (await Config.directories()).filter((dir) =>
    dir.endsWith(".altimate-code") || dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR)
  const sources: { source: string; text?: string }[] = directories.flatMap((dir) => names.map((name) => ({ source: path.join(dir, name) })))
  // Match Config's order: directories, inline config, then managed settings.
  const inline = env("OPENCODE_CONFIG_CONTENT")
  if (inline) sources.push({ source: process.env.ALTIMATE_CLI_CONFIG_CONTENT ? "ALTIMATE_CLI_CONFIG_CONTENT" : "OPENCODE_CONFIG_CONTENT", text: inline })
  sources.push(...names.map((name) => ({ source: path.join(ConfigManaged.managedConfigDir(), name) })))
  const managed = await ConfigManaged.readManagedPreferences()
  if (managed) sources.push(managed)
  for (const { source, text } of sources.reverse()) {
    const content = text ?? await fs.readFile(source, "utf8").catch(() => "")
    const capture = parse(content)?.learn?.capture
    if (capture === false)
      return `learn.capture=false is set in ${source}. Set learn.capture=true there or remove that override.`
    if (capture === true) break
  }
  return "A higher-precedence configuration overrides the project setting. Set learn.capture=true in that configuration, or set ALTIMATE_LEARN_CAPTURE=1 for this process."
}
// altimate_change end

const EnableCommand = effectCmd({
  command: "enable",
  describe: "enable learning capture and automatic reflection for this project",
  handler: Effect.fn("Cli.learn.enable")(function* () {
    yield* run("", async () => {
      const root = await projectRoot()
      const file = await writeProjectLearning(root, true)
      // altimate_change start — explicit capture opt-in checks effective config and preserves the learning kill switch
      try {
        const { dismissNudge } = await import("../../altimate/learn/nudge-state")
        await dismissNudge()
      } catch (error) {
        log.warn("Failed to dismiss learning nudge", { error: errText(error) })
      }
      const { Config } = await import("@/config/config")
      await Config.invalidate()
      const learn = (await Config.get()).learn
      if (!learnEnabled(learn)) {
        out("Project capture settings written: learn.capture=true, learn.auto_reflect=true.")
        out(LEARN_DISABLED_HINT)
      } else if (!captureEnabled(learn)) {
        const hint = await captureOverrideHint().catch((error) => {
          log.warn("Failed to identify learning config override", { error: errText(error) })
          return "Set learn.capture=true in the overriding config, or set ALTIMATE_LEARN_CAPTURE=1 for this process."
        })
        throw new Error(`Wrote project config: ${file}, but capture remains off (effective learn.capture=false). ${hint}`)
      } else {
        out(`Project learning enabled: learn.capture=true, learn.auto_reflect=${autoReflectEnabled(learn)}.`)
      }
      // altimate_change end
      out(`Project config: ${file}`)
      out(`Local data: ${Store.paths(root, Playbook.DEFAULT_NAME).learnDir}`)
      out("Automatic reflection stages candidates; review with `altimate-code learn show`, then `learn promote`.")
      if (process.stdin.isTTY && process.stdout.isTTY) {
        out("Next steps:")
        out("  altimate-code learn bootstrap")
        out("  altimate-code learn import-reviews")
      }
    })
  }),
})

const DisableCommand = effectCmd({
  command: "disable",
  describe: "disable learning capture and automatic reflection for this project",
  handler: Effect.fn("Cli.learn.disable")(function* () {
    yield* run("", async () => {
      const file = await writeProjectLearning(await projectRoot(), false)
      out("Project learning disabled: learn.capture=false, learn.auto_reflect=false.")
      out(`Project config: ${file}`)
    })
  }),
})

const NudgeCommand = cmd({
  command: "nudge",
  describe: "manage the learning reminder",
  builder: (yargs: Argv) =>
    yargs.command(effectCmd({
      command: "off",
      describe: "don't show the learning reminder again in any project",
      handler: Effect.fn("Cli.learn.nudge.off")(function* () {
        yield* run("", async () => {
          const { dismissNudge } = await import("../../altimate/learn/nudge-state")
          await dismissNudge()
          out("Learning reminders permanently dismissed for all projects.")
        })
      }),
    })).demandCommand(),
  async handler() {},
})

const StatusCommand = effectCmd({
  command: "status",
  describe: "show learning settings, lesson counts, signals and reflection status",
  builder: (yargs: Argv) => nameOption(yargs).option("json", { type: "boolean", default: false, describe: "machine-readable output" }),
  handler: Effect.fn("Cli.learn.status")(function* (args) {
    yield* run("", async () => {
      const root = await projectRoot()
      const name = args.name as string
      const { Config } = await import("@/config/config")
      const { readScheduleState, resolveRecoveryLimits } = await import("../../altimate/learn/schedule-state")
      const learn = (await Config.get()).learn
      const status = await Store.transaction(root, async () => {
        const signals = await Signals.listSignals(root, {}, name)
        const state = await readScheduleState(root, name)
        let lastReflection = state.lastReflection
        // Manual reflections and earlier versions record successful results in the history.
        const history = await fs.readFile(Store.paths(root, name).history, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return ""
          throw error
        })
        // altimate_change start — summarize malformed history entries once per status command
        let skipped = 0
        // altimate_change end
        for (const line of history.trim().split("\n").reverse()) {
          if (!line) continue
          // altimate_change start — tolerate interrupted or corrupt history writes
          let entry: Store.HistoryEntry | null
          try {
            entry = JSON.parse(line)
          } catch {
            skipped++
            continue
          }
          if (entry?.action !== "reflect" || !entry.ts) continue
          // altimate_change end
          if (!lastReflection || Date.parse(entry.ts) > Date.parse(lastReflection.at)) lastReflection = {
            at: entry.ts,
            sessionID: entry.session ?? "external",
            result: "success",
            summary: `${entry.applied?.length ?? 0} applied, ${entry.rejected?.length ?? 0} rejected`,
            usage: entry.usage,
          }
          break
        }
        // altimate_change start — avoid flooding logs after a torn history write
        if (skipped) log.warn("Skipping malformed learning history entries", { skipped })
        // altimate_change end
        const sessions = Signals.pendingSessions(signals)
        const approved = await Store.loadApproved(root, name)
        return {
          name,
          // altimate_change start — expose the effective learning kill switch and re-enable guidance
          enabled: learnEnabled(learn),
          ...(!learnEnabled(learn) ? { note: LEARN_DISABLED_HINT } : {}),
          // altimate_change end
          capture: captureEnabled(learn),
          auto_reflect: autoReflectEnabled(learn),
          file_hook: fileHookEnabled(learn),
          data: Store.paths(root, name).learnDir,
          approved: approved.length,
          pinned: approved.filter((lesson) => lesson.pinned).map((lesson) => lesson.id),
          candidate: (await Store.loadCandidateLessons(root, name))?.length ?? 0,
          retired: (await Store.loadRetired(root, name)).length,
          open_signals: signals.length,
          pending_recoveries: sessions.length,
          pending_replacements: (await Store.readPendingReplacements(root, name)).length,
          backoff_sessions: sessions.filter((session) => (state.recoveries[session]?.retryAt ?? 0) > Date.now()).length,
          last_reflection: lastReflection ?? null,
          limits: { ...resolveLimits(learn), max_stored: learnMaxStored(learn?.max_stored), ...resolveRecoveryLimits(learn) },
        }
      })
      if (args.json) return out(JSON.stringify(status, null, 2))
      out(`Learning enabled: ${status.enabled ? "yes" : "no"}`)
      // altimate_change start — surface the learning kill switch in human-readable status
      if (status.note) out(status.note)
      // altimate_change end
      out(`Capture: ${status.capture ? "on" : "off"}; automatic reflection: ${status.auto_reflect ? "on" : "off"}`)
      out(`File hook: ${status.file_hook ? "on" : "off"}`)
      out(`Local data: ${status.data}`)
      out(`Lessons: ${status.approved} approved, ${status.candidate} candidate, ${status.retired} retired`)
      out(`Pinned lessons: ${status.pinned.length}${status.pinned.length ? ` (${status.pinned.join(", ")})` : ""}`)
      out(`Open signals: ${status.open_signals}`)
      out(`Pending recoveries: ${status.pending_recoveries} session(s); ${status.backoff_sessions} in backoff`)
      out(`Pending replacements: ${status.pending_replacements}`)
      out(status.last_reflection
        ? `Last reflection: ${status.last_reflection.at} - ${status.last_reflection.result}: ${status.last_reflection.summary}`
        : "Last reflection: never")
      out(`Limits: ${Object.entries(status.limits).map(([key, value]) => `${key}=${value}`).join(", ")}`)
    })
  }),
})

const BootstrapCommand = effectCmd({
  command: "bootstrap",
  describe: "seed candidate lessons from this project's past sessions",
  builder: (yargs: Argv) => nameOption(yargs)
    .option("since", { type: "string", default: "30d", describe: "session creation boundary: duration (30d, 24h, 4w) or ISO date" })
    .option("limit", { type: "number", default: DEFAULT_BOOTSTRAP_LIMIT, describe: "maximum root sessions to inspect" })
    .option("model", { type: "string", alias: ["m"], describe: "chosen provider/model (default: learn.model, then the configured default model)" })
    .option("yes", { type: "boolean", default: false, describe: "confirm sending the displayed scope; required outside a TTY" })
    .option("dry-run", { type: "boolean", default: false, describe: "print scope and redacted signals; send nothing and leave bootstrap state unchanged" })
    .option("max-reflections", { type: "number", default: DEFAULT_MAX_REFLECTIONS, describe: "maximum reflection batches; 0 imports signals only" })
    .option("max-seconds", { type: "number", default: DEFAULT_MAX_SECONDS, describe: "total time budget after confirmation, in seconds" })
    .epilog("Bootstrap sends redacted excerpts of past sessions to the chosen model. Review the scope before confirming. Lessons are candidates only: learn show, then learn promote. Rerun to finish pending reflections and continue the history cursor."),
  handler: Effect.fn("Cli.learn.bootstrap")(function* (args) {
    const result = yield* run("", async () => {
      const [{ Config }, { Provider }, { Instance }, { InstanceRef }, { AppRuntime }] = await Promise.all([
        import("@/config/config"), import("@/provider/provider"), import("@/project/instance"),
        import("@/effect/instance-ref"), import("@/effect/app-runtime"),
      ])
      const config = await Config.get()
      const context = Instance.current
      const modelArg = args.model || learnModel(config.learn?.model)
      if (modelArg && !/^[^/\s]+\/\S+$/.test(modelArg)) throw new Error("Invalid model (expected provider/model).")
      return bootstrap({
        root: await projectRoot(), projectID: context.project.id, directory: context.directory,
        name: args.name, since: args.since, limit: args.limit, maxReflections: args["max-reflections"],
        maxSeconds: args["max-seconds"], maxStored: learnMaxStored(config.learn?.max_stored),
        yes: args.yes, dryRun: args["dry-run"],
      }, {
        out,
        isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
        confirm: async () => (await prompts.confirm({ message: "Send these redacted past-session excerpts to the displayed model?" })) === true,
        resolveModel: async () => {
          // Freeze one choice for the entire import. Resolving a language/provider client is
          // deferred until after consent and after the Stage 3 signal claim has been acquired.
          const chosen = modelArg ? Provider.parseModel(modelArg) : await Provider.defaultModel()
          const model: BootstrapModel = {
            ...chosen,
            generate: async (abortSignal, onUsage) => {
              const resolved = await Provider.getModel(chosen.providerID, chosen.modelID)
              model.cost = resolved.cost
              return AppRuntime.runPromise(providerGenerate(chosen, DEFAULT_TIMEOUT_MS, abortSignal, onUsage)
                .pipe(Effect.provideService(InstanceRef, context)))
            },
          }
          return model
        },
      })
    })
    if (result?.failures) return yield* fail("Bootstrap reflection failed; signals remain queued. Rerun `learn bootstrap` to continue.")
  }),
})

const ImportReviewsCommand = effectCmd({
  command: "import-reviews",
  describe: "seed candidate lessons from human reviews of merged GitHub pull requests",
  builder: (yargs: Argv) => nameOption(yargs)
    .option("repo", { type: "string", describe: "owner/name (default: the project's GitHub or GitHub Enterprise remote)" })
    .option("since", { type: "string", default: "30d", describe: "merge boundary: duration (30d, 24h, 4w) or ISO date" })
    .option("limit", { type: "number", default: 50, describe: "maximum merged pull requests to inspect" })
    .option("include-bots", { type: "boolean", default: false, describe: "include bot authors, overriding all bot filters" })
    .option("any-author", { type: "boolean", default: false, describe: "include reviewers who are not owners, members or collaborators of the repository" })
    // altimate_change start — accept repeated bot flags as well as comma lists
    .option("bots", { type: "string", array: true, describe: "additional bot logins to exclude; repeat or comma-separate (also: learn.review_bots)" })
    // altimate_change end
    .option("model", { type: "string", alias: ["m"], describe: "chosen provider/model (default: learn.model, then the configured default model)" })
    .option("yes", { type: "boolean", default: false, describe: "confirm sending the displayed scope; required outside a TTY" })
    .option("dry-run", { type: "boolean", default: false, describe: "fetch and print redacted review comments; send nothing and leave import state unchanged" })
    .option("max-reflections", { type: "number", default: DEFAULT_MAX_REFLECTIONS, describe: "maximum reflection batches; 0 imports signals only" })
    .epilog("Requires gh installed and authenticated for the repository host. Review import sends redacted review comments to the chosen model after confirmation. Lessons are candidates only: learn show, then learn promote. Rerun to resume a checkpoint or finish pending reflections."),
  handler: Effect.fn("Cli.learn.importReviews")(function* (args) {
    const result = yield* run("", async () => {
      const [{ Config }, { Provider }, { Instance }, { InstanceRef }, { AppRuntime }] = await Promise.all([
        import("@/config/config"), import("@/provider/provider"), import("@/project/instance"),
        import("@/effect/instance-ref"), import("@/effect/app-runtime"),
      ])
      const config = await Config.get()
      const context = Instance.current
      const modelArg = args.model || learnModel(config.learn?.model)
      if (modelArg && !/^[^/\s]+\/\S+$/.test(modelArg)) throw new Error("Invalid model (expected provider/model).")
      return importReviews({
        root: await projectRoot(), name: args.name, repo: args.repo, since: args.since, limit: args.limit,
        // altimate_change start — normalize every repeated bot flag's comma list
        includeBots: args["include-bots"], anyAuthor: args["any-author"], bots: args.bots?.flatMap((value) => value.split(",")).map((login) => login.trim()).filter(Boolean),
        // altimate_change end
        reviewBots: config.learn?.review_bots, maxReflections: args["max-reflections"],
        maxStored: learnMaxStored(config.learn?.max_stored), yes: args.yes, dryRun: args["dry-run"],
      }, {
        out,
        isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
        confirm: async () => (await prompts.confirm({ message: "Send these redacted review comments to the displayed model?" })) === true,
        resolveModel: async () => {
          // Select once for the displayed scope; defer provider resolution and generation
          // until confirmation and the Stage 3 signal claim have both succeeded.
          const chosen = modelArg ? Provider.parseModel(modelArg) : await Provider.defaultModel()
          const model: BootstrapModel = {
            ...chosen,
            generate: async (abortSignal, onUsage) => {
              const resolved = await Provider.getModel(chosen.providerID, chosen.modelID)
              model.cost = resolved.cost
              return AppRuntime.runPromise(providerGenerate(chosen, DEFAULT_TIMEOUT_MS, abortSignal, onUsage)
                .pipe(Effect.provideService(InstanceRef, context)))
            },
          }
          return model
        },
      })
    })
    if (result?.failures) return yield* fail("Review reflection failed; signals remain queued. Rerun `learn import-reviews` to continue.")
  }),
})

const ReflectCommand = effectCmd({
  // yargs reads `--feedback -` as an option with no value plus a stray `-` positional; a hidden
  // optional positional absorbs the `-` so `.strict()` still rejects genuinely unknown arguments.
  command: "reflect [stdin]",
  describe: "stage lesson edits from a session and external feedback",
  builder: (yargs: Argv) =>
    nameOption(yargs)
      .positional("stdin", { type: "string", hidden: true })
      .option("session", { type: "string", describe: "session id to learn from (without --feedback: from its captured signals)" })
      .option("pending", { type: "boolean", default: false, describe: "reflect on every session that has open captured signals" })
      .option("trajectory", {
        type: "string",
        describe: "trajectory JSON file (`trajectory export`), for a session recorded in another project",
      })
      .option("feedback", { type: "string", describe: "feedback file, or - for stdin" })
      .option("feedback-kind", {
        type: "string",
        choices: FEEDBACK_KINDS,
        default: "user" as FeedbackKind,
        describe: "where the feedback comes from",
      })
      .option("apply-paths", {
        type: "array",
        string: true,
        describe: "path triggers for lessons in a new store (no default)",
      })
      .option("model", { type: "string", alias: ["m"], describe: "model to use in the format of provider/model" })
      .option("timeout", {
        type: "number",
        default: DEFAULT_TIMEOUT_MS / 1000,
        describe: "seconds to wait for the model before giving up",
      })
      .option("json", { type: "boolean", default: false, describe: "machine-readable output" }),
  handler: Effect.fn("Cli.learn.reflect")(function* (args) {
    const name = args.name as string
    const feedbackFrom = Store.feedbackSource(args.feedback, [args.stdin])
    const pending = args.pending as boolean
    // Without feedback, a session's own captured signals are the feedback.
    const fromSignals = pending || (!!args.session && !args.trajectory && !feedbackFrom)
    if (pending) {
      if (args.session || args.trajectory || feedbackFrom)
        return yield* fail("--pending reflects on captured signals; do not combine it with --session, --trajectory or --feedback.")
    } else if (!args.session === !args.trajectory) return yield* fail("Pass exactly one of --session or --trajectory.")
    const root = yield* run("", async () => {
      Playbook.validateName(name)
      return projectRoot()
    })
    const timeoutSeconds = args.timeout as number
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return yield* fail("--timeout must be a positive number of seconds.")
    const applyPaths = args["apply-paths"] as string[] | undefined
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Effect.promise(() => Config.get())
    const maxStored = yield* run("", async () => learnMaxStored(config.learn?.max_stored))
    const modelArg = (args.model as string | undefined) || learnModel(config.learn?.model)
    const overrideLabel = modelArg ? `${args.model ? "--model" : "model"} ${modelArg}` : undefined

    const resolveGenerate = Effect.fn("Cli.learn.generate")(function* (source: DigestSource) {
      yield* run("", () => prepareReflection(root, name, applyPaths))
      const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
      const model = yield* run("Invalid model (expected provider/model): ", async () =>
        modelArg ? Provider.parseModel(modelArg) : source.model,
      )
      if (!model) {
        const { FreeTier } = yield* Effect.promise(() => import("../../altimate/free/client"))
        yield* Effect.promise(() => FreeTier.autoRegisterWithin(undefined, () => {}))
      }
      const modelLabel = overrideLabel ?? (model ? `model ${model.providerID}/${model.modelID}` : "the default model")
      const generate = yield* providerGenerate(model, timeoutSeconds * 1000).pipe(
        Effect.catchCause((cause) => fail(`Cannot resolve ${modelLabel}: ${errText(Cause.squash(cause))}`)),
      )
      return { generate: generate as Generate, modelLabel }
    })

    // Prints the human report, or returns the JSON object for the caller to emit.
    const report = (result: Awaited<ReturnType<typeof reflectCore>>, extra: Record<string, unknown> = {}) => {
      const { curated, proposed, flagged } = result
      const summary = summarize(curated)
      if (args.json) {
        return {
          name,
          ...extra,
          summary,
          proposed,
          ...result.usage,
          feedbackFlagged: flagged !== undefined,
          applied: curated.applied,
          rejected: curated.rejected,
          bullets: curated.next.length,
          candidate: curated.applied.length > 0 ? Store.paths(root, name).candidate : null,
        }
      }
      out(summary)
      out(formatUsage(result.usage))
      if (flagged) out(flagged)
      for (const a of curated.applied) out(`  ${describeApplied(a, redactSecrets)}`)
      for (const r of curated.rejected) out(`  ${describeRejected(r, redactSecrets)}`)
      if (curated.applied.length > 0)
        out(`Candidate: ${Store.paths(root, name).candidate}\nReview with \`altimate-code learn show\`, then \`learn promote\`.`)
      return undefined
    }

    if (fromSignals) {
      const all = yield* run("", () => Signals.listSignals(root, { session: args.session as string | undefined }, name))
      const sessions = args.session ? [args.session as string] : Signals.pendingSessions(all)
      if (all.length === 0 || sessions.length === 0) {
        if (args.json) out(JSON.stringify({ name, sessions: [], message: "nothing to learn" }, null, 2))
        else out("No open learning signals; nothing to learn.")
        return
      }
      const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
      const reports: unknown[] = []
      let failures = 0
      for (const sessionID of sessions) {
        const attempt = yield* Effect.tryPromise({
          try: () =>
            reflectSessionSignals({
              root, name, sessionID, applyPaths, maxStored, modelLabel: overrideLabel,
              getGenerate: async (source) => (await AppRuntime.runPromise(resolveGenerate(source))).generate,
            }),
          catch: (e) => e,
        }).pipe(
          Effect.map((r) => ({ ok: true as const, r })),
          Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
        )
        if (!attempt.ok) {
          failures++
          const message = `Reflection failed for session ${sessionID}: ${errText(attempt.e)}`
          if (args.json) reports.push({ session: sessionID, error: message })
          else process.stderr.write(message + EOL)
          continue
        }
        if (attempt.r.status === "none") continue
        const { result, signals, kind } = attempt.r
        if (!args.json)
          out(`Session ${sessionID}: learned from ${signals.length} signal${signals.length === 1 ? "" : "s"} (feedback kind: ${kind}).`)
        const json = report(result, { session: sessionID, signals: signals.length, feedbackKind: kind })
        if (json) reports.push(json)
      }
      if (args.json) out(JSON.stringify(pending ? reports : (reports[0] ?? null), null, 2))
      if (failures > 0) return yield* fail(`${failures} of ${sessions.length} session(s) failed; their signals stay open.`)
      return
    }

    const feedbackKind = args["feedback-kind"] as FeedbackKind
    if (!feedbackFrom) return yield* fail("Pass --feedback <file> (or `--feedback -` to read stdin).")
    if (feedbackFrom === "stdin") {
      const problem = Store.stdinFeedbackProblem(process.stdin.isTTY)
      if (problem) return yield* fail(problem)
    }
    const feedback = yield* run("Cannot read feedback: ", async () =>
      feedbackFrom === "stdin" ? await Bun.stdin.text() : await fs.readFile(feedbackFrom.file, "utf8"),
    )
    if (!feedback.trim()) return yield* fail("Feedback is empty; nothing to learn from.")

    const source = yield* run("", async (): Promise<DigestSource> => {
      if (args.trajectory) {
        const file = args.trajectory
        const raw = await fs.readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
          throw new Error(`Cannot read trajectory ${file}: ${e.code === "ENOENT" ? "no such file" : e.message}`)
        })
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          throw new Error(`Cannot read trajectory ${file}: not valid JSON (expected the output of \`trajectory export\`).`)
        }
        return sourceFromTrajectory(parsed as Parameters<typeof sourceFromTrajectory>[0])
      }
      return sourceFromSession(args.session as string)
    })

    const { generate, modelLabel } = yield* resolveGenerate(source)
    const result = yield* run("Reflection failed: ", () =>
      reflectCore({
        root,
        name,
        source,
        feedback,
        kind: feedbackKind,
        origin: (args.session as string | undefined) ?? path.resolve(args.trajectory as string),
        session: args.session as string | undefined,
        generate,
        applyPaths,
        maxStored,
        modelLabel,
      }),
    )
    const json = report(result)
    if (json) out(JSON.stringify(json, null, 2))
  }),
})

const SignalsCommand = effectCmd({
  command: "signals",
  describe: "list captured learning signals (open ones; --all includes consumed)",
  builder: (yargs: Argv) =>
    nameOption(yargs)
      .option("session", { type: "string", describe: "only this session" })
      .option("all", { type: "boolean", default: false, describe: "include consumed signals" })
      .option("json", { type: "boolean", default: false, describe: "machine-readable output" }),
  handler: Effect.fn("Cli.learn.signals")(function* (args) {
    yield* run("", async () => {
      const root = await projectRoot()
      const list = await Signals.listSignals(root, { session: args.session as string | undefined, all: args.all as boolean }, args.name as string)
      if (args.json) return out(JSON.stringify(list, null, 2))
      if (list.length === 0) return out(args.all ? "No learning signals." : "No open learning signals.")
      for (const s of list) {
        const text = s.text.replace(/\s+/g, " ").slice(0, 100)
        out(`${s.id}  ${s.status}${s.consumedBy ? `(${s.consumedBy})` : ""}  ${s.kind}  ${s.sessionID}  ${s.at}\n  ${text}`)
      }
    })
  }),
})

const SIGNAL_ADD_KINDS = ["review", "ci", "user"] as const

const SignalAddCommand = effectCmd({
  command: "add",
  describe: "record a learning signal from an integration (PR review comment, CI log, ...)",
  builder: (yargs: Argv) =>
    nameOption(yargs)
      .option("kind", { type: "string", choices: SIGNAL_ADD_KINDS, demandOption: true, describe: "where the signal comes from" })
      .option("text", { type: "string", describe: "the signal text" })
      .option("file", { type: "string", describe: "read the signal text from this file" })
      .option("session", { type: "string", default: Signals.EXTERNAL_SESSION, describe: "session the signal belongs to" }),
  handler: Effect.fn("Cli.learn.signal.add")(function* (args) {
    if (!args.text === !args.file) return yield* fail("Pass exactly one of --text or --file.")
    yield* run("", async () => {
      const root = await projectRoot()
      const text =
        args.text ??
        (await fs.readFile(args.file as string, "utf8").catch((e: NodeJS.ErrnoException) => {
          throw new Error(`Cannot read ${args.file}: ${e.code === "ENOENT" ? "no such file" : e.message}`)
        }))
      if (!text.trim()) throw new Error("Signal text is empty.")
      const kind = args.kind === "user" ? "user_correction" : (args.kind as "review" | "ci")
      const signal = await Signals.appendSignal(root, {
        kind,
        sessionID: args.session as string,
        text,
        reason: `recorded via \`learn signal add\` (${args.kind})`,
      }, args.name as string)
      out(signal ? `Recorded ${signal.id} (${signal.kind}) for session ${signal.sessionID}.` : "Already recorded; nothing added.")
    })
  }),
})

const SignalCommand = cmd({
  command: "signal",
  describe: "record learning signals from integrations",
  builder: (yargs: Argv) => yargs.command(SignalAddCommand).demandCommand(),
  async handler() {},
})

const ShowCommand = effectCmd({
  command: "show",
  describe: "show approved lessons, the candidate, flags and their diff",
  builder: (yargs: Argv) => nameOption(yargs),
  handler: Effect.fn("Cli.learn.show")(function* (args) {
    const name = args.name as string
    yield* run("", async () => {
      const root = await projectRoot()
      const { approved, candidate, diff, pending, hasApproved } = await Store.transaction(root, async () => ({
        approved: await Store.loadApproved(root, name),
        candidate: await Store.loadCandidateLessons(root, name),
        diff: await Store.diff(root, name),
        pending: await Store.readPendingReplacements(root, name),
        hasApproved: (await Store.readPromoted(root, name)) !== undefined,
      }))
      const show = (lessons: typeof approved) => {
        for (const lesson of lessons) {
          const labels = [lesson.pinned ? "pinned" : "", lesson.text.length > MAX_TEXT ? "long (shorten when next edited)" : ""].filter(Boolean)
          out(`[${lesson.id}] ${lesson.text}${labels.length ? ` (${labels.join("; ")})` : ""}`)
          out(`  helpful: ${lesson.helpful}; harmful: ${lesson.harmful}; applied: ${lesson.applied}${lesson.tags.length ? `; tags: ${lesson.tags.join(", ")}` : ""}`)
        }
        Store.verificationWarnings(JSON.stringify(lessons)).forEach(out)
      }
      out(`# Approved${hasApproved ? "" : " (none)"}`)
      show(approved)
      out(`\n# Candidate${candidate === undefined ? " (none)" : ""}`)
      if (candidate !== undefined) show(candidate)
      out(`\n# Diff${diff ? "" : " (none)"}`)
      if (diff) out(diff.trimEnd())
      out(`\nPending recoveries: ${pending.length}`)
      for (const recovery of pending) out(`  [${recovery.id}] ${recovery.text} (attempts: ${recovery.attempts})`)
      if (!hasApproved && candidate === undefined) out(`\nNo lesson store "${name}" yet. ${START_HINT}`)
      else if (diff) out("\nRun `altimate-code learn promote` to make the candidate live, or `learn reject` to discard it.")
    })
  }),
})

const SearchCommand = effectCmd({
  command: "search <query>",
  describe: "search approved and retired lessons by text or tags",
  builder: (yargs: Argv) => nameOption(yargs).positional("query", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.learn.search")(function* (args) {
    yield* run("", async () => {
      const root = await projectRoot()
      const name = args.name as string
      const matches = await Store.search(root, name, args.query as string)
      if (!matches.length) return out("No matching lessons.")
      for (const { lesson, state } of matches) out(`[${lesson.id}] ${state}: ${lesson.text}`)
    })
  }),
})

function pinCommand(pinned: boolean) {
  const action = pinned ? "pin" : "unpin"
  return effectCmd({
    command: `${action} <id>`,
    describe: pinned ? "pin an approved lesson to the core tier and protect it from eviction" : "unpin an approved lesson",
    builder: (yargs: Argv) => nameOption(yargs).positional("id", { type: "string", demandOption: true }),
    handler: Effect.fn(`Cli.learn.${action}`)(function* (args) {
      yield* run("", async () => {
        const lesson = await Store.setPinned(await projectRoot(), args.name as string, args.id as string, pinned)
        out(`${pinned ? "Pinned" : "Unpinned"} [${lesson.id}] ${lesson.text}`)
      })
    }),
  })
}

const PromoteCommand = effectCmd({
  command: "promote",
  describe: "make the candidate the approved lesson set",
  builder: (yargs: Argv) =>
    nameOption(yargs)
      .option("yes", { type: "boolean", default: false, describe: "skip the confirmation prompt" })
      .option("allow-flagged", {
        type: "boolean",
        default: false,
        describe: "with --yes: approve lessons flagged for mentioning skipping or disabling verification",
      })
      .option("publish", { type: "boolean", default: false, describe: "publish to the bound workspace afterwards" })
      .option("replace", {
        type: "boolean",
        default: false,
        describe: "with --publish: update your own same-name playbook even if it was published from another checkout",
      }),
  handler: Effect.fn("Cli.learn.promote")(function* (args) {
    const name = args.name as string
    if (args.publish && !Flag.ALTIMATE_WORKSPACE)
      return yield* fail("`--publish` requires the workspace pilot: set ALTIMATE_WORKSPACE=1.")
    const root = yield* run("", async () => {
      Playbook.validateName(name)
      return projectRoot()
    })
    const { diff, candidateHash } = yield* run("", () => Store.reviewCandidate(root, name))
    if (!diff) {
      const hasCandidate = yield* run("", async () => (await Store.readCandidate(root, name)) !== undefined)
      return yield* fail(
        (hasCandidate
          ? `Nothing to promote: the candidate does not differ from the approved "${name}".`
          : `Nothing to promote: there is no candidate for "${name}". ${START_HINT}`) +
          (args.publish ? " Publishing through `learn promote --publish` requires a changed candidate." : ""),
      )
    }
    out("Review the lessons below before making this candidate the approved set (and sharing it with your team if you publish).")
    out(diff.trimEnd())
    if (!args.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        return yield* fail("Refusing to promote without confirmation in a non-interactive session; pass --yes.")
      const ok = yield* Effect.promise(() =>
        prompts.confirm({
          message: args.publish ? "Promote and publish to the workspace?" : "Promote this candidate?",
        }),
      )
      if (ok !== true) return yield* fail("Cancelled.", 130)
    }
    const { archived } = yield* run("", () => Store.promote(root, name, {
      expectedCandidateHash: candidateHash,
      allowFlagged: !args.yes || args["allow-flagged"] === true,
    }))
    out(`Promoted "${name}"${archived ? ` (previous version archived as v${archived})` : ""}.`)
    if (!args.publish) return
    // altimate_change start — identify name conflicts for a direct publish retry
    const { publishSkill, describePublish, explainPublishError, SkillNameConflictError } = yield* Effect.promise(
      () => import("../../altimate/workspace/skill-publish"),
    )
    // altimate_change end
    const { Instance } = yield* Effect.promise(() => import("@/project/instance"))
    const report = yield* Effect.tryPromise({
      try: async () => {
        await Store.exportSkill(root, name)
        return publishSkill({
          projectDirectory: Instance.directory,
          projectRoot: root,
          skillDirectory: Store.paths(root, name).skillDir,
          name,
          description: Playbook.PLAYBOOK_DESCRIPTION,
          replace: args.replace === true,
        })
      },
      catch: (e) => e,
    }).pipe(
      Effect.catch((e) =>
        // altimate_change start — retry the exported skill after its candidate was promoted
        fail(`Promoted locally, but publish failed: ${explainPublishError(e) ?? (e instanceof Error ? e.message : String(e))}\n` +
          `Retry with \`altimate-code skill publish ${name}${args.replace || e instanceof SkillNameConflictError ? " --replace" : ""}\`.`),
        // altimate_change end
      ),
    )
    out(describePublish(report))
    yield* run("", () => Store.appendHistory(root, name, { action: "promote", published: true }))
  }),
})

const RollbackCommand = effectCmd({
  command: "rollback",
  describe: "restore the previously promoted version",
  builder: (yargs: Argv) => nameOption(yargs),
  handler: Effect.fn("Cli.learn.rollback")(function* (args) {
    const name = args.name as string
    yield* run("", async () => {
      const root = await projectRoot()
      const { restored } = await Store.rollback(root, name).catch((e) => {
        if (e instanceof Store.StoreError)
          throw new Error(`${e.message} \`learn promote\` archives the previous version each time, so there is nothing to restore yet. ${START_HINT}`)
        throw e
      })
      out(
        `Restored "${name}" from archived v${restored}.` +
          (Flag.ALTIMATE_WORKSPACE ? ` Run \`altimate-code skill publish ${name}\` to share it.` : ""),
      )
    })
  }),
})

const RejectCommand = effectCmd({
  command: "reject",
  describe: "discard the staged candidate",
  builder: (yargs: Argv) => nameOption(yargs),
  handler: Effect.fn("Cli.learn.reject")(function* (args) {
    const name = args.name as string
    yield* run("", async () => {
      const root = await projectRoot()
      out((await Store.reject(root, name)) ? `Discarded the candidate for "${name}".` : `No candidate for "${name}".`)
    })
  }),
})

const LEARN_HELP = [
  "Concepts:",
  "  approved   the live lesson set in .altimate-code/learn/<name>/approved.json",
  "  candidate  staged lessons from `reflect` in candidate.json; review before approval",
  "  promote    make the candidate the approved set (the previous set is archived)",
  "  publish    export approved lessons as a skill and share with the workspace (`promote --publish`)",
  "",
  "Workflow: reflect on a session with feedback, review with show, promote.",
  "  altimate-code learn reflect --session <id> --feedback ci.log --feedback-kind ci",
  "  altimate-code learn show",
  "  altimate-code learn search 'timestamp'   # approved and retired lessons",
  "  altimate-code learn promote",
  "  altimate-code learn rollback   # undo the last promote",
  "  altimate-code learn pin <id>    # keep an approved lesson in the core tier and protect it from eviction",
  "  altimate-code learn unpin <id>  # clear the pin on an approved lesson",
  "Find session ids with `altimate-code session list`. Pipe feedback with `--feedback -`.",
  "",
  "Automatic capture (local only, opt-in): `altimate-code learn enable` (disable with `learn disable`).",
  "  altimate-code learn status                   settings, counts, recoveries and limits",
  "  altimate-code learn nudge off                don't show the learning reminder again (all projects)",
  "  or set ALTIMATE_LEARN_CAPTURE=1 or config learn.capture=true",
  "  user corrections and repeated tool failures are recorded in .altimate-code/learn/team-playbook/signals.jsonl",
  "  altimate-code learn signals [--all]            list them",
  "  altimate-code learn reflect --session <id>     learn from a session's signals (no --feedback)",
  "  altimate-code learn reflect --pending          learn from every session with open signals",
  "  altimate-code learn bootstrap --dry-run        preview redacted signals from past project sessions",
  "  altimate-code learn bootstrap                  confirm sending redacted past-session excerpts to the chosen model",
  "  altimate-code learn import-reviews --dry-run    preview redacted human reviews from merged GitHub pull requests",
  "  altimate-code learn import-reviews              confirm sending reviews to the chosen model",
  "  altimate-code learn signal add --kind review --text '...'   record a review comment or CI log",
  "Auto-reflect after turns and at the end of `run`: ALTIMATE_LEARN_AUTO=1 or learn.auto_reflect=true (model: ALTIMATE_LEARN_MODEL or learn.model).",
  "Stored lesson cap: learn.max_stored or ALTIMATE_LEARN_MAX_STORED (default: 1000; pinned lessons are retained).",
  // altimate_change start — distinguish capture opt-out from disabling automatic learning and delivery
  "Disable all automatic learning and lesson delivery: learn.enabled=false or ALTIMATE_LEARN=0 (explicit learn commands still run).",
  "With capture off, the TUI reminder counts corrections in memory only; its only write is global learn-nudge.json",
  "(shown project hashes, total count, dismissed flag). Delivering already-approved lessons still writes session state.",
  // altimate_change end
].join(EOL)

export const LearnCommand = cmd({
  command: "learn",
  describe: "learn team conventions from sessions and feedback into a lesson store",
  builder: (yargs: Argv) =>
    yargs
      .epilog(LEARN_HELP)
      // Bad options get one line, not the whole help screen.
      .fail((msg, err) => {
        if (err) throw err
        process.stderr.write(`Error: ${msg.replace(/\s*\n\s*/g, " ")} (see \`altimate-code learn --help\`)${EOL}`)
        process.exit(1)
      })
      .command(EnableCommand)
      .command(DisableCommand)
      .command(NudgeCommand)
      .command(StatusCommand)
      .command(BootstrapCommand)
      .command(ImportReviewsCommand)
      .command(ReflectCommand)
      .command(SignalsCommand)
      .command(SignalCommand)
      .command(ShowCommand)
      .command(SearchCommand)
      .command(pinCommand(true))
      .command(pinCommand(false))
      .command(PromoteCommand)
      .command(RollbackCommand)
      .command(RejectCommand)
      .demandCommand(),
  async handler() {},
})
