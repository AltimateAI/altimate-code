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
import * as prompts from "@clack/prompts"
import { Cause, Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Playbook from "../../altimate/learn/playbook"
import * as Store from "../../altimate/learn/store"
import { curate, summarize } from "../../altimate/learn/curator"
import { buildDigest, sourceFromMessages, sourceFromTrajectory, redactSecrets, type DigestSource } from "../../altimate/learn/digest"
import { FEEDBACK_KINDS, providerGenerate, reflect, type FeedbackKind } from "../../altimate/learn/reflect"

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
    Effect.catch((e) => fail(`${label}${e instanceof Error ? e.message : String(e)}`)),
  )

const ReflectCommand = effectCmd({
  command: "reflect",
  describe: "stage playbook edits from a session and external feedback",
  builder: (yargs: Argv) =>
    nameOption(yargs)
      .option("session", { type: "string", describe: "session id to learn from" })
      .option("trajectory", {
        type: "string",
        describe: "trajectory JSON file (`trajectory export`), for a session recorded in another project",
      })
      .option("feedback", { type: "string", demandOption: true, describe: "feedback file, or - for stdin" })
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
      .option("json", { type: "boolean", default: false, describe: "machine-readable output" }),
  handler: Effect.fn("Cli.learn.reflect")(function* (args) {
    const name = args.name as string
    if (!args.session === !args.trajectory) return yield* fail("Pass exactly one of --session or --trajectory.")
    const root = yield* run("", async () => {
      Playbook.validateName(name)
      return projectRoot()
    })
    const feedbackKind = args["feedback-kind"] as FeedbackKind
    const feedback = yield* run("Cannot read feedback: ", async () =>
      args.feedback === "-" ? await Bun.stdin.text() : await fs.readFile(args.feedback as string, "utf8"),
    )
    if (!feedback.trim()) return yield* fail("Feedback is empty; nothing to learn from.")

    const source = yield* run("", async (): Promise<DigestSource> => {
      if (args.trajectory) return sourceFromTrajectory(JSON.parse(await fs.readFile(args.trajectory, "utf8")))
      const { Session } = await import("../../session")
      const { SessionID } = await import("../../session/schema")
      const sid = SessionID.make(args.session as string)
      try {
        await Session.get(sid)
      } catch {
        throw new Error(`Session not found: ${args.session}. For a session from another project, use --trajectory.`)
      }
      return sourceFromMessages(await Session.messages({ sessionID: sid }))
    })
    const digest = buildDigest(source)

    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    if (!args.model) {
      const { FreeTier } = yield* Effect.promise(() => import("../../altimate/free/client"))
      yield* Effect.promise(() => FreeTier.autoRegisterWithin(undefined, () => {}))
    }
    const generate = yield* providerGenerate(args.model ? Provider.parseModel(args.model as string) : undefined).pipe(
      Effect.catchCause((cause) => {
        const e = Cause.squash(cause)
        return fail(`Cannot resolve model: ${e instanceof Error ? e.message : String(e)}`)
      }),
    )

    const result = yield* run("Reflection failed: ", async () => {
      const pb = await Store.loadCandidate(root, name, { applyPaths: args["apply-paths"] as string[] | undefined })
      const deltas = await reflect({ digest, feedback, kind: feedbackKind, bullets: Playbook.bullets(pb) }, generate)
      const curated = curate(Playbook.bullets(pb), deltas)
      if (curated.applied.length > 0) await Store.saveCandidate(root, name, Playbook.withBullets(pb, curated.next))
      await Store.appendHistory(root, name, {
        action: "reflect",
        session: args.session as string | undefined,
        feedbackKind,
        feedbackHash: Store.sha256(feedback),
        applied: curated.applied,
        rejected: curated.rejected,
      })
      return { curated, proposed: deltas.length }
    })

    const { curated, proposed } = result
    const summary = summarize(curated)
    if (args.json) {
      out(
        JSON.stringify(
          {
            name,
            summary,
            proposed,
            applied: curated.applied,
            rejected: curated.rejected,
            bullets: curated.next.length,
            candidate: curated.applied.length > 0 ? Store.paths(root, name).candidate : null,
          },
          null,
          2,
        ),
      )
      return
    }
    out(summary)
    for (const r of curated.rejected) out(`  rejected ${r.delta.op}: ${r.reason}${r.delta.text ? ` — ${redactSecrets(r.delta.text)}` : ""}`)
    if (curated.applied.length > 0) out(`Candidate: ${Store.paths(root, name).candidate}\nReview with \`altimate-code learn show\`, then \`learn promote\`.`)
  }),
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
    })
  }),
})

const PromoteCommand = effectCmd({
  command: "promote",
  describe: "promote the candidate to the project skill",
  builder: (yargs: Argv) =>
    nameOption(yargs)
      .option("yes", { type: "boolean", default: false, describe: "skip the confirmation prompt" })
      .option("publish", { type: "boolean", default: false, describe: "publish to the bound workspace afterwards" }),
  handler: Effect.fn("Cli.learn.promote")(function* (args) {
    const name = args.name as string
    if (args.publish && !Flag.ALTIMATE_WORKSPACE)
      return yield* fail("`--publish` requires the workspace pilot: set ALTIMATE_WORKSPACE=1.")
    const root = yield* run("", async () => {
      Playbook.validateName(name)
      return projectRoot()
    })
    const diff = yield* run("", () => Store.diff(root, name))
    if (!diff)
      return yield* fail(
        `Nothing to promote: no candidate differs from the promoted "${name}".` +
          (args.publish ? ` To share the promoted version as it is, run \`altimate-code skill publish ${name}\`.` : ""),
      )
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
      const { restored } = await Store.rollback(root, name)
      out(`Restored "${name}" from archived v${restored}. Run \`skill publish ${name}\` to share it.`)
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

export const LearnCommand = cmd({
  command: "learn",
  describe: "learn team conventions from sessions and feedback into a playbook skill",
  builder: (yargs: Argv) =>
    yargs
      .command(ReflectCommand)
      .command(ShowCommand)
      .command(PromoteCommand)
      .command(RollbackCommand)
      .command(RejectCommand)
      .demandCommand(),
  async handler() {},
})
