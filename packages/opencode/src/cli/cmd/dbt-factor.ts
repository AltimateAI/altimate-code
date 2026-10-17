// altimate_change start — dbt-factor: shared SQL across models, proposed as one
// new intermediate model plus consumer edits, each consumer with its own proof.
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Dispatcher } from "../../altimate/native"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { findModel, loadManifest } from "./dbt-mart-helpers"
import { buildFactorPlan, formatFactorProposal, normalizeFactorProposals } from "./dbt-factor-helpers"
import { changesForFile, formatImpactText, normalizeImpactReport } from "./dbt-impact-helpers"
import { parityCommand } from "./dbt-optimize-helpers"

export const DbtFactorCommand = cmd({
  command: "dbt-factor",
  describe: "find SQL repeated across dbt models and propose computing it once in a shared model (deterministic)",
  builder: (yargs: Argv) =>
    yargs
      .option("project", { describe: "scan the whole project (default when --model is absent)", type: "boolean" })
      .option("model", { describe: "only proposals that touch this model", type: "string" })
      .option("min-occurrences", { describe: "minimum number of models sharing the logic", type: "number", default: 2 })
      .option("apply", {
        describe: "write proposal --proposal (default #1); refuses if any consumer proof is refuted",
        type: "boolean",
        default: false,
      })
      .option("proposal", { describe: "1-based proposal number to apply", type: "number", default: 1 })
      .option("cwd", { describe: "dbt project directory (default: current dir)", type: "string" })
      .option("manifest", { describe: "path to dbt manifest.json", type: "string" })
      .option("run-results", {
        describe: "dbt run_results.json — measured model time, the cost gate's size signal",
        type: "string",
      })
      .option("trino-profile", { describe: "trino-profile.json — the same size signal", type: "string" })
      .option("json", { describe: "emit the full result as JSON", type: "boolean", default: false }),

  handler: async (args: {
    project?: boolean
    model?: string
    "min-occurrences"?: number
    apply?: boolean
    proposal?: number
    cwd?: string
    manifest?: string
    "run-results"?: string
    "trino-profile"?: string
    json?: boolean
  }) => {
    const projectDir = path.resolve(args.cwd ?? process.cwd())
    const loaded = loadManifest(projectDir, args.manifest)
    if (!loaded.ok) return fatal(loaded.error)
    if (args.model && !findModel(loaded.manifest, args.model))
      return fatal(`model not found (or ambiguous) in the manifest: ${args.model}`)

    // Core `FactoringOpts` is `deny_unknown_fields`; its key is `min_models`.
    const options: Record<string, unknown> = { min_models: args["min-occurrences"] ?? 2 }
    if (args["run-results"]) options.run_results = path.resolve(args["run-results"])
    if (args["trino-profile"]) options.trino_profile = path.resolve(args["trino-profile"])
    const res = await Dispatcher.call("altimate_core.dbt_factoring", {
      project_dir: projectDir,
      options_json: JSON.stringify(options),
    }).catch((e: unknown) => ({ success: false, data: {} as Record<string, unknown>, error: String(e) }))
    if (!res.success) return fatal(res.error ?? "altimate_core.dbt_factoring failed")
    let proposals = normalizeFactorProposals(res.data.proposals)
    if (args.model) proposals = proposals.filter((p) => p.consumers.some((c) => c.model === args.model))

    const readRaw = (rel: string) => {
      const abs = path.join(projectDir, rel)
      return existsSync(abs) ? readFileSync(abs, "utf-8") : undefined
    }
    const plans = proposals.map((p) => ({ p, plan: buildFactorPlan({ manifest: loaded.manifest, proposal: p, readRaw }) }))

    const out: string[] = []
    let applied: string[] = []
    let refused: string | undefined
    const impacts: unknown[] = []
    if (args.apply) {
      const chosen = plans.find((x) => x.p.index === (args.proposal ?? 1))
      if (!chosen) refused = `no proposal #${args.proposal ?? 1} (there are ${plans.length})`
      else if (!chosen.plan.ok) refused = chosen.plan.reason
      else {
        const clash = chosen.plan.edits.find((e) => !e.before && existsSync(path.join(projectDir, e.file)))
        if (clash) refused = `refusing to overwrite existing file ${clash.file}`
        else {
          for (const e of chosen.plan.edits) {
            const abs = path.join(projectDir, e.file)
            mkdirSync(path.dirname(abs), { recursive: true })
            writeFileSync(abs, e.after)
          }
          applied = chosen.plan.edits.map((e) => e.file)
          // Impact of every touched consumer: an output-column change there is
          // a break somewhere downstream, and must be seen before merging.
          for (const c of chosen.p.consumers) {
            const edit = chosen.plan.edits.find((e) => e.file === findModel(loaded.manifest, c.model)?.original_file_path)
            const d = changesForFile({
              model: c.model,
              status: "modified",
              baseRaw: edit?.before,
              headRaw: edit?.after,
            })
            for (const u of d.unclassified) out.push(`dbt-impact ${u.model}: UNCLASSIFIED — ${u.reason}`)
            for (const change of d.changes) {
              const r = await Dispatcher.call("altimate_core.dbt_impact", {
                project_dir: projectDir,
                change_json: JSON.stringify(change),
              }).catch((e: unknown) => ({ success: false, data: {} as Record<string, unknown>, error: String(e) }))
              impacts.push({ change, report: r.success ? normalizeImpactReport(r.data) : { error: r.error } })
              if (r.success) out.push(formatImpactText(change, normalizeImpactReport(r.data)))
              else out.push(`dbt-impact ${c.model}: ${r.error}`)
            }
            if (!d.changes.length && !d.unclassified.length)
              out.push(`dbt-impact ${c.model}: no change to its SQL or materialization — nothing downstream to break`)
          }
        }
      }
    }

    const parity = proposals.flatMap((p) =>
      p.consumers.map((c) => {
        const node = findModel(loaded.manifest, c.model)
        return node ? parityCommand(node) : `altimate dbt-parity --model ${c.model} --before <relation> --after <relation>`
      }),
    )

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            version: 1,
            proposals: plans.map(({ p, plan }) => ({
              ...p.raw,
              index: p.index,
              name: p.name,
              consumers: p.consumers.map((c) => ({ model: c.model, proof_status: c.proof.status, proof: c.proof })),
              patch: plan.patch,
              apply_blocked: plan.ok ? undefined : plan.reason,
            })),
            apply: args.apply ? { applied, refused, impacts } : undefined,
            parity_commands: [...new Set(parity)],
          },
          null,
          2,
        ) + "\n",
      )
    } else {
      const lines: string[] = []
      lines.push(proposals.length ? `Factoring proposals (${proposals.length}):` : "No factoring proposals.")
      for (const { p, plan } of plans) {
        lines.push(...formatFactorProposal(p))
        if (!plan.ok) lines.push(`    cannot auto-apply: ${plan.reason}`)
        lines.push(plan.patch)
      }
      if (args.apply) {
        if (refused) lines.push(`NOT APPLIED: ${refused}`)
        else lines.push(`APPLIED: ${applied.join(", ")}`, "", ...out)
      }
      if (parity.length) {
        lines.push("", "Next — build the new model and consumers, then prove each consumer's data is unchanged:")
        for (const c of new Set(parity)) lines.push(`  ${c}`)
      }
      console.error(lines.join("\n"))
    }
    if (args.apply && !applied.length) process.exitCode = 1
  },
})

function fatal(msg: string): void {
  console.error(`Error: ${msg}`)
  process.exitCode = 1
}
// altimate_change end
