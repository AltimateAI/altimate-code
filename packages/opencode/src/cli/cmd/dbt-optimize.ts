// altimate_change start — dbt-optimize: verified rewrite proposals for one dbt
// model, with an apply path that refuses refuted rewrites and Jinja it cannot
// map back. Deterministic: engine calls only, no LLM, no warehouse.
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Dispatcher } from "../../altimate/native"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { findModel, loadManifest } from "./dbt-mart-helpers"
import { normalizePerfReport, normalizePerfSeverity } from "./dbt-perf-helpers"
import {
  buildPatchPlan,
  chooseProposal,
  findingsForModel,
  formatProposal,
  normalizeProposals,
  parityCommand,
} from "./dbt-optimize-helpers"

/**
 * `altimate dbt-optimize --model X` — perf findings for X, then the engine's
 * rewrite proposals for X, each with its static equivalence proof.
 *
 * `--apply` writes the chosen proposal back into the model file. It refuses a
 * refuted proposal, needs `--allow-unproven` for an undecidable one, and
 * refuses (printing the patch instead) whenever the compiled rewrite cannot be
 * mapped back onto the raw model's Jinja safely.
 */
export const DbtOptimizeCommand = cmd({
  command: "dbt-optimize",
  describe: "propose verified SQL rewrites for one dbt model, and optionally apply one (deterministic, no LLM)",
  builder: (yargs: Argv) =>
    yargs
      .option("model", { describe: "model name (or unique_id)", type: "string", demandOption: true })
      .option("cwd", { describe: "dbt project directory (default: current dir)", type: "string" })
      .option("manifest", {
        describe: "path to dbt manifest.json (default: <cwd>/target/manifest.json)",
        type: "string",
      })
      .option("apply", {
        describe: "write the chosen proposal into the model file (refuses refuted / unmappable proposals)",
        type: "boolean",
        default: false,
      })
      .option("proposal", { describe: "1-based proposal number to apply (default: first proven)", type: "number" })
      .option("allow-unproven", {
        describe: "allow --apply on an UNDECIDABLE proof (a parity run is then the only bar)",
        type: "boolean",
        default: false,
      })
      .option("parity-after", {
        describe: "relation the rebuilt model lands in, for the printed dbt-parity command",
        type: "string",
      })
      .option("run-results", {
        describe: "dbt run_results.json — measured model time, the cost gate's size signal (drops break-even rewrites)",
        type: "string",
      })
      .option("trino-profile", {
        describe: "trino-profile.json — the same size signal from a Trino build profile",
        type: "string",
      })
      .option("json", { describe: "emit the full result as JSON", type: "boolean", default: false }),

  handler: async (args: {
    model: string
    cwd?: string
    manifest?: string
    apply?: boolean
    proposal?: number
    "allow-unproven"?: boolean
    "parity-after"?: string
    "run-results"?: string
    "trino-profile"?: string
    json?: boolean
  }) => {
    const projectDir = path.resolve(args.cwd ?? process.cwd())
    const loaded = loadManifest(projectDir, args.manifest)
    if (!loaded.ok) return fatal(loaded.error)
    const model = findModel(loaded.manifest, args.model)
    if (!model) return fatal(`model not found (or ambiguous) in the manifest: ${args.model}`)

    // 1. Perf findings for the model — the context the proposals answer.
    const perf = await Dispatcher.call("altimate_core.dbt_perf", {
      project_dir: projectDir,
      manifest_json: readFileSync(loaded.path, "utf-8"),
    }).catch((e: unknown) => ({ success: false, data: {} as Record<string, unknown>, error: String(e) }))
    const findings = perf.success ? findingsForModel(normalizePerfReport(perf.data).findings, model) : []
    const perfError = perf.success ? undefined : perf.error

    // 2. Rewrite proposals.
    const res = await Dispatcher.call("altimate_core.dbt_rewrites", {
      project_dir: projectDir,
      model: model.name ?? args.model,
      // The structural diff is the reviewer's "what changed" summary.
      // Without run artifacts every plan-changing rewrite is `cost: unverified`.
      options_json: JSON.stringify({
        ast_diff: true,
        ...(args["run-results"] ? { run_results: path.resolve(args["run-results"]) } : {}),
        ...(args["trino-profile"] ? { trino_profile: path.resolve(args["trino-profile"]) } : {}),
      }),
    }).catch((e: unknown) => ({ success: false, data: {} as Record<string, unknown>, error: String(e) }))
    if (!res.success) return fatal(res.error ?? "altimate_core.dbt_rewrites failed")
    const proposals = normalizeProposals(res.data.proposals)

    // 3. Apply gate + patch.
    const allowUnproven = args["allow-unproven"] ?? false
    const decision = args.apply ? chooseProposal(proposals, { index: args.proposal, allowUnproven }) : undefined
    const filePath = path.join(projectDir, model.original_file_path ?? "")
    const raw = existsSync(filePath) ? readFileSync(filePath, "utf-8") : (model.raw_code ?? "")
    const plan =
      decision?.ok === true ? buildPatchPlan({ model, raw, proposal: decision.proposal }) : undefined
    let applied: string[] = []
    if (plan?.ok) {
      for (const e of plan.edits) {
        const abs = path.join(projectDir, e.file)
        if (!e.before && existsSync(abs)) {
          // A model-level proposal must not overwrite an existing model.
          return fatal(`refusing to overwrite existing file ${e.file}`)
        }
        mkdirSync(path.dirname(abs), { recursive: true })
        writeFileSync(abs, e.after)
      }
      applied = plan.edits.map((e) => e.file)
    }
    const nextCommand = parityCommand(model, args["parity-after"])

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            version: 1,
            model: model.name,
            file: model.original_file_path,
            findings,
            perf_error: perfError,
            proposals: proposals.map(({ proofNormalized, ...p }) => ({ ...p, proof_status: proofNormalized.status })),
            apply: args.apply
              ? {
                  chosen: decision?.ok ? decision.proposal.index : undefined,
                  refused: decision && !decision.ok ? decision.reason : plan && !plan.ok ? plan.reason : undefined,
                  applied,
                  warnings: [...(decision?.ok && decision.note ? [decision.note] : []), ...(plan?.ok ? plan.warnings : [])],
                  patch: plan?.patch,
                }
              : undefined,
            parity_command: nextCommand,
          },
          null,
          2,
        ) + "\n",
      )
    } else {
      const out: string[] = []
      out.push(`dbt-optimize ${model.name} (${model.original_file_path ?? "?"})`)
      out.push("")
      if (perfError) out.push(`Perf findings unavailable: ${perfError}`)
      else if (!findings.length) out.push("Perf findings: none for this model.")
      else {
        out.push(`Perf findings (${findings.length}):`)
        for (const f of findings)
          out.push(`  ${normalizePerfSeverity(f.severity).toUpperCase()} [${f.code ?? f.rule ?? "?"}] ${f.message ?? ""}`)
      }
      out.push("")
      if (!proposals.length) out.push("No rewrite proposals.")
      else {
        out.push(`Rewrite proposals (${proposals.length}):`)
        for (const p of proposals) out.push(...formatProposal(p))
      }
      if (args.apply) {
        out.push("")
        if (decision && !decision.ok) out.push(`NOT APPLIED: ${decision.reason}`)
        else if (plan && !plan.ok) {
          out.push(`NOT APPLIED: ${plan.reason}`)
          out.push("The rewrite, against the compiled SQL — apply by hand if it still makes sense:")
          out.push(plan.patch)
        } else if (plan?.ok) {
          out.push(`APPLIED proposal #${decision!.ok ? decision!.proposal.index : "?"} to: ${applied.join(", ")}`)
          if (decision?.ok && decision.note) out.push(`  note: ${decision.note}`)
          for (const w of plan.warnings) out.push(`  warning: ${w}`)
          out.push(plan.patch)
        }
      }
      out.push("")
      out.push("Next — rebuild the model, then prove the data did not change:")
      out.push(`  ${nextCommand}`)
      console.error(out.join("\n"))
    }
    if (args.apply && !(plan?.ok ?? false)) process.exitCode = 1
  },
})

function fatal(msg: string): void {
  console.error(`Error: ${msg}`)
  process.exitCode = 1
}
// altimate_change end
