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
import {
  curate,
  summarize,
  describeApplied,
  describeRejected,
  flagSuspiciousFeedback,
} from "../../altimate/learn/curator"
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

/** Named errors (e.g. ModelNotFoundError) carry their detail in `data`, not `message`. */
function errText(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const data = (e as { data?: unknown }).data
  if (e.message && e.message !== e.name) return e.message
  return data ? `${e.name}: ${JSON.stringify(data)}` : e.name
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
      .option("session", { type: "string", describe: "session id to learn from" })
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
      .option("json", { type: "boolean", default: false, describe: "machine-readable output" }),
  handler: Effect.fn("Cli.learn.reflect")(function* (args) {
    const name = args.name as string
    if (!args.session === !args.trajectory) return yield* fail("Pass exactly one of --session or --trajectory.")
    const root = yield* run("", async () => {
      Playbook.validateName(name)
      return projectRoot()
    })
    const feedbackKind = args["feedback-kind"] as FeedbackKind
    const feedbackFrom = Store.feedbackSource(args.feedback, [args.stdin])
    if (!feedbackFrom) return yield* fail("Pass --feedback <file> (or `--feedback -` to read stdin).")
    const feedback = yield* run("Cannot read feedback: ", async () =>
      feedbackFrom === "stdin" ? await Bun.stdin.text() : await fs.readFile(feedbackFrom.file, "utf8"),
    )
    if (!feedback.trim()) return yield* fail("Feedback is empty; nothing to learn from.")
    const flagged = flagSuspiciousFeedback(feedback)

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
    const modelLabel = args.model ? `--model ${args.model}` : "the default model"
    const model = yield* run("Invalid --model (expected provider/model): ", async () =>
      args.model ? Provider.parseModel(args.model as string) : undefined,
    )
    const generate = yield* providerGenerate(model).pipe(
      Effect.catchCause((cause) => fail(`Cannot resolve ${modelLabel}: ${errText(Cause.squash(cause))}`)),
    )

    const result = yield* run("Reflection failed: ", async () => {
      const pb = await Store.loadCandidate(root, name, { applyPaths: args["apply-paths"] as string[] | undefined })
      const deltas = await reflect({ digest, feedback, kind: feedbackKind, bullets: Playbook.bullets(pb) }, generate).catch(
        (e) => {
          throw new Error(`Model call failed (${modelLabel}): ${errText(e)}`)
        },
      )
      const curated = curate(Playbook.bullets(pb), deltas, {
        feedbackId: Store.shortHash(feedback),
        harmfulFrom: await Store.readHarmfulFrom(root, name),
      })
      if (curated.applied.length > 0) await Store.saveCandidate(root, name, Playbook.withBullets(pb, curated.next))
      await Store.writeHarmfulFrom(root, name, curated.harmfulFrom)
      await Store.appendHistory(root, name, {
        action: "reflect",
        session: args.session as string | undefined,
        feedbackKind,
        feedbackHash: Store.sha256(feedback),
        feedbackFlagged: flagged ? true : undefined,
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
            feedbackFlagged: flagged !== undefined,
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
    if (flagged) out(flagged)
    for (const a of curated.applied) out(`  ${describeApplied(a, redactSecrets)}`)
    for (const r of curated.rejected) out(`  ${describeRejected(r, redactSecrets)}`)
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
      .command(ShowCommand)
      .command(PromoteCommand)
      .command(RollbackCommand)
      .command(RejectCommand)
      .demandCommand(),
  async handler() {},
})
