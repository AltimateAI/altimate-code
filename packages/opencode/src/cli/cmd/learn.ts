// altimate_change - new file
//
// `altimate-code learn`: turn a finished session plus external feedback (CI or
// verifier output, review comments, user corrections) into bounded, linted edits
// to a project playbook skill, then optionally publish it to the workspace.
// Edits are staged as a candidate; nothing reaches the promoted skill (or the
// workspace) until `learn promote`.
import type { Argv } from "yargs"
import { EOL } from "os"
import fs from "node:fs/promises"
import path from "node:path"
import * as prompts from "@clack/prompts"
import { Cause, Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Playbook from "../../altimate/learn/playbook"
import * as Store from "../../altimate/learn/store"
import { summarize, describeApplied, describeRejected } from "../../altimate/learn/curator"
import { sourceFromTrajectory, redactSecrets, type DigestSource } from "../../altimate/learn/digest"
import { DEFAULT_TIMEOUT_MS, FEEDBACK_KINDS, providerGenerate, type FeedbackKind, type Generate } from "../../altimate/learn/reflect"
import * as Signals from "../../altimate/learn/signals"
import { errText, reflectCore, reflectSessionSignals, sourceFromSession } from "../../altimate/learn/session-reflect"

const out = (text: string) => process.stdout.write(text + EOL)

const nameOption = (yargs: Argv) =>
  yargs.option("name", {
    type: "string",
    default: Playbook.DEFAULT_NAME,
    describe: "playbook skill name",
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

const ReflectCommand = effectCmd({
  // yargs reads `--feedback -` as an option with no value plus a stray `-` positional; a hidden
  // optional positional absorbs the `-` so `.strict()` still rejects genuinely unknown arguments.
  command: "reflect [stdin]",
  describe: "stage playbook edits from a session and external feedback",
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
        describe: "when creating the playbook: auto-load only if one of these files exists (default dbt_project.yml, else always)",
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

    const resolveGenerate = Effect.fn("Cli.learn.generate")(function* () {
      const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
      if (!args.model) {
        const { FreeTier } = yield* Effect.promise(() => import("../../altimate/free/client"))
        yield* Effect.promise(() => FreeTier.autoRegisterWithin(undefined, () => {}))
      }
      const modelLabel = args.model ? `--model ${args.model}` : "the default model"
      const model = yield* run("Invalid --model (expected provider/model): ", async () =>
        args.model ? Provider.parseModel(args.model as string) : undefined,
      )
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
          feedbackFlagged: flagged !== undefined,
          applied: curated.applied,
          rejected: curated.rejected,
          bullets: curated.next.length,
          candidate: curated.applied.length > 0 ? Store.paths(root, name).candidate : null,
        }
      }
      out(summary)
      if (flagged) out(flagged)
      for (const a of curated.applied) out(`  ${describeApplied(a, redactSecrets)}`)
      for (const r of curated.rejected) out(`  ${describeRejected(r, redactSecrets)}`)
      if (curated.applied.length > 0)
        out(`Candidate: ${Store.paths(root, name).candidate}\nReview with \`altimate-code learn show\`, then \`learn promote\`.`)
      return undefined
    }

    if (fromSignals) {
      const all = yield* run("", () => Signals.listSignals(root, { session: args.session as string | undefined }))
      const sessions = args.session ? [args.session as string] : Signals.pendingSessions(all)
      if (all.length === 0 || sessions.length === 0) {
        if (args.json) out(JSON.stringify({ name, sessions: [], message: "nothing to learn" }, null, 2))
        else out("No open learning signals; nothing to learn.")
        return
      }
      const { generate, modelLabel } = yield* resolveGenerate()
      const reports: unknown[] = []
      let failures = 0
      for (const sessionID of sessions) {
        const attempt = yield* Effect.tryPromise({
          try: () =>
            reflectSessionSignals({ root, name, sessionID, getGenerate: async () => generate, applyPaths, modelLabel }),
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

    const { generate, modelLabel } = yield* resolveGenerate()
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
    yargs
      .option("session", { type: "string", describe: "only this session" })
      .option("all", { type: "boolean", default: false, describe: "include consumed signals" })
      .option("json", { type: "boolean", default: false, describe: "machine-readable output" }),
  handler: Effect.fn("Cli.learn.signals")(function* (args) {
    yield* run("", async () => {
      const root = await projectRoot()
      const list = await Signals.listSignals(root, { session: args.session as string | undefined, all: args.all as boolean })
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
    yargs
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
      })
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
  describe: "show the promoted playbook, the candidate and their diff",
  builder: (yargs: Argv) => nameOption(yargs),
  handler: Effect.fn("Cli.learn.show")(function* (args) {
    const name = args.name as string
    yield* run("", async () => {
      const root = await projectRoot()
      const promoted = await Store.readPromoted(root, name)
      const candidate = await Store.readCandidate(root, name)
      out(`# Promoted${promoted === undefined ? " (none)" : ""}`)
      if (promoted !== undefined) out(promoted.trimEnd())
      out(`\n# Candidate${candidate === undefined ? " (none)" : ""}`)
      if (candidate !== undefined) out(candidate.trimEnd())
      const diff = await Store.diff(root, name)
      out(`\n# Diff${diff ? "" : " (none)"}`)
      if (diff) out(diff.trimEnd())
      out(`\nPending recoveries: ${(await Store.readPendingReplacements(root, name)).length}`)
      if (promoted === undefined && candidate === undefined) out(`\nNo playbook "${name}" yet. ${START_HINT}`)
      else if (diff) out("\nRun `altimate-code learn promote` to make the candidate live, or `learn reject` to discard it.")
    })
  }),
})

const PromoteCommand = effectCmd({
  command: "promote",
  describe: "promote the candidate to the project skill",
  builder: (yargs: Argv) =>
    nameOption(yargs)
      .option("yes", { type: "boolean", default: false, describe: "skip the confirmation prompt" })
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
    const diff = yield* run("", () => Store.diff(root, name))
    if (!diff) {
      const hasCandidate = yield* run("", async () => (await Store.readCandidate(root, name)) !== undefined)
      return yield* fail(
        (hasCandidate
          ? `Nothing to promote: the candidate does not differ from the promoted "${name}".`
          : `Nothing to promote: there is no candidate for "${name}". ${START_HINT}`) +
          (args.publish ? ` To share the promoted version as it is, run \`altimate-code skill publish ${name}\`.` : ""),
      )
    }
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
    const { archived } = yield* run("", () => Store.promote(root, name))
    out(`Promoted "${name}"${archived ? ` (previous version archived as v${archived})` : ""}.`)
    if (!args.publish) return
    const { publishSkill, describePublish, explainPublishError } = yield* Effect.promise(
      () => import("../../altimate/workspace/skill-publish"),
    )
    const { Instance } = yield* Effect.promise(() => import("@/project/instance"))
    const report = yield* Effect.tryPromise({
      try: () =>
        publishSkill({
          projectDirectory: Instance.directory,
          projectRoot: root,
          skillDirectory: Store.paths(root, name).skillDir,
          name,
          description: Playbook.PLAYBOOK_DESCRIPTION,
          replace: args.replace === true,
        }),
      catch: (e) => e,
    }).pipe(
      Effect.catch((e) =>
        fail(`Promoted locally, but publish failed: ${explainPublishError(e) ?? (e instanceof Error ? e.message : String(e))}`),
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
  "  playbook   a project skill (.altimate-code/skills/<name>/SKILL.md) auto-loaded into sessions",
  "  candidate  staged playbook edits from `reflect`; nothing is live yet",
  "  promote    make the candidate the live playbook (the previous one is archived)",
  "  publish    share the promoted playbook with the team via the workspace (`promote --publish`)",
  "",
  "Workflow: reflect on a session with feedback, review with show, promote.",
  "  altimate-code learn reflect --session <id> --feedback ci.log --feedback-kind ci",
  "  altimate-code learn show",
  "  altimate-code learn promote",
  "  altimate-code learn rollback   # undo the last promote",
  "Find session ids with `altimate-code session list`. Pipe feedback with `--feedback -`.",
  "",
  "Automatic capture (local only, opt-in): set ALTIMATE_LEARN_CAPTURE=1 or config learn.capture=true.",
  "  user corrections and repeated tool failures are recorded in .altimate-code/learn/signals.jsonl",
  "  altimate-code learn signals [--all]            list them",
  "  altimate-code learn reflect --session <id>     learn from a session's signals (no --feedback)",
  "  altimate-code learn reflect --pending          learn from every session with open signals",
  "  altimate-code learn signal add --kind review --text '...'   record a review comment or CI log",
  "Auto-reflect at the end of `run`: ALTIMATE_LEARN_AUTO=1 or learn.auto_reflect=true (model: ALTIMATE_LEARN_MODEL or learn.model).",
].join(EOL)

export const LearnCommand = cmd({
  command: "learn",
  describe: "learn team conventions from sessions and feedback into a playbook skill",
  builder: (yargs: Argv) =>
    yargs
      .epilog(LEARN_HELP)
      // Bad options get one line, not the whole help screen.
      .fail((msg, err) => {
        if (err) throw err
        process.stderr.write(`Error: ${msg.replace(/\s*\n\s*/g, " ")} (see \`altimate-code learn --help\`)${EOL}`)
        process.exit(1)
      })
      .command(ReflectCommand)
      .command(SignalsCommand)
      .command(SignalCommand)
      .command(ShowCommand)
      .command(PromoteCommand)
      .command(RollbackCommand)
      .command(RejectCommand)
      .demandCommand(),
  async handler() {},
})
