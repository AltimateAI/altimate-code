// altimate_change start — literal deliverable / spec-name completion gate
/**
 * Literal-deliverable (spec-name) gate.
 *
 * A recurring, fully deterministic loss mode in evaluation traces: the work is
 * functionally reasonable but shipped under self-chosen names — a prefix
 * added, a plural dropped, a "v2" suffix, or an entirely different noun — and
 * the agent then self-verifies against its own renamed output and reports
 * success. The literal contract in the task document is never re-read.
 *
 * This gate re-reads it. It compares the deliverable names the task states
 * **literally** against the names the project actually defines, and refuses
 * to terminate when a required name is absent.
 *
 * Conservatism is the whole design:
 *   - Required names come only from `extractRequiredDeliverables`, which
 *     accepts a name solely from an explicit declaration marker, a
 *     deliverables section, or a requirement line — and only when it sits in
 *     an inline code span and is identifier- or path-shaped. There is no
 *     fuzzy matching and no inference.
 *   - When no required-names source is discoverable, `appliesTo` returns
 *     false and the session is never inspected. Silence, never a guess.
 *   - Produced names are the union of the filesystem inventory and every
 *     `manifest.json` name/alias, so an aliased relation cannot read as
 *     missing.
 *   - Comparison is exact (case-insensitive only). A near-miss name is
 *     reported as a possible substitute in the hint, never accepted as the
 *     deliverable.
 *
 * Deliberately out of scope: required *column* names. Asserting a column
 * exists means resolving `select *`, CTEs and upstream schemas — real SQL
 * analysis, not a filesystem inventory — so it is not attempted here rather
 * than attempted badly.
 */

import { promises as fs } from "fs"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"
import {
  findDbtProjectRoot,
  findTaskInstructionFiles,
  extractRequiredDeliverables,
  collectProducedNodeNames,
  modelsModifiedSince,
  modelNameFromPath,
  resolveWithinRoot,
  sanitizeForPrompt,
  type RequiredDeliverables,
} from "./validator-utils"

/** The task contract for this workspace, when one is discoverable. */
interface Contract {
  /** Path of the first document that contributed a deliverable, for display. */
  taskFile: string
  /** Every document that contributed at least one deliverable. */
  taskFiles: string[]
  required: RequiredDeliverables
}

/**
 * Read the workspace's literal deliverable contract, merged across EVERY
 * task/instruction document that names one.
 *
 * A workspace can carry more than one document with real obligations — a
 * `TASK.md` naming one model and a `REQUIREMENTS.md` naming another — and
 * stopping at the first one that parses silently drops every deliverable in
 * the rest. A session that satisfies only the first document's contract then
 * passes this gate while the remaining required models are entirely absent.
 */
async function readContract(cwd: string, dbtRoot: string): Promise<Contract | null> {
  const taskFiles: string[] = []
  const models: string[] = []
  const files: string[] = []
  const modificationModels: string[] = []
  const modelSet = new Set<string>()
  const fileSet = new Set<string>()
  const modificationSet = new Set<string>()
  let primarySource: RequiredDeliverables["source"] | null = null
  for (const task of await findTaskInstructionFiles(cwd, dbtRoot)) {
    const required = extractRequiredDeliverables(task.content)
    if (!required) continue
    taskFiles.push(task.path)
    if (primarySource === null) primarySource = required.source
    for (const m of required.models) if (!modelSet.has(m)) { modelSet.add(m); models.push(m) }
    for (const f of required.files) if (!fileSet.has(f)) { fileSet.add(f); files.push(f) }
    for (const m of required.modificationModels) {
      if (!modificationSet.has(m)) { modificationSet.add(m); modificationModels.push(m) }
    }
  }
  if (taskFiles.length === 0) return null
  return {
    taskFile: taskFiles[0]!,
    taskFiles,
    required: { models, files, modificationModels, source: primarySource! },
  }
}

/** True when `relative` exists under either the dbt project or the workspace. */
async function fileExists(dbtRoot: string, cwd: string, relative: string): Promise<boolean> {
  for (const root of new Set([dbtRoot, cwd])) {
    // Refuse to resolve outside `root` — see `resolveWithinRoot`. A required
    // path is task-document content and can contain `..` segments.
    const safePath = resolveWithinRoot(root, relative)
    if (!safePath) continue
    try {
      const stat = await fs.stat(safePath)
      if (stat.isFile()) return true
    } catch {
      // keep looking
    }
  }
  return false
}

export const DbtDeliverableNamesValidator: Validator = {
  name: "dbt-deliverable-names",
  description:
    "After the agent declares done, compares the deliverable names the task document states literally against the model, seed and snapshot names the project actually defines, and refuses to terminate when a required name is absent — catching renames and self-chosen substitutes.",

  async appliesTo(ctx: ValidatorContext): Promise<boolean> {
    const dbtRoot = await findDbtProjectRoot(ctx.workingDirectory)
    if (!dbtRoot) return false
    return (await readContract(ctx.workingDirectory, dbtRoot)) !== null
  },

  async check(ctx: ValidatorContext): Promise<ValidatorResult> {
    const startedAt = Date.now()
    const dbtRoot = await findDbtProjectRoot(ctx.workingDirectory)
    if (!dbtRoot) {
      return { ok: true, details: { skipped: "no dbt project", session_id: ctx.sessionID } }
    }
    const contract = await readContract(ctx.workingDirectory, dbtRoot)
    if (!contract) {
      return { ok: true, details: { skipped: "no literal contract", session_id: ctx.sessionID } }
    }

    const produced = await collectProducedNodeNames(dbtRoot)
    const missingModels = contract.required.models.filter((name) => !produced.has(name))
    const missingFiles: string[] = []
    for (const relative of contract.required.files) {
      if (!(await fileExists(dbtRoot, ctx.workingDirectory, relative))) missingFiles.push(relative)
    }

    const details = {
      task_file: contract.taskFile,
      task_files: contract.taskFiles,
      required_source: contract.required.source,
      required_models: contract.required.models,
      required_files: contract.required.files,
      produced_count: produced.size,
      missing_models: missingModels,
      missing_files: missingFiles,
      dbt_root: dbtRoot,
      session_id: ctx.sessionID,
      elapsed_ms: Date.now() - startedAt,
    }

    if (missingModels.length === 0 && missingFiles.length === 0) {
      return { ok: true, details }
    }

    // Names this session authored that the task did not ask for. These are the
    // likely substitutes behind a missing required name; reported as context,
    // never asserted as equivalent.
    const requiredSet = new Set(contract.required.models)
    const authored = await modelsModifiedSince(dbtRoot, ctx.sessionStartMs)
    const unrequested = Array.from(
      new Set(
        authored
          .map((p) => modelNameFromPath(p).toLowerCase())
          .filter((name) => name.length > 0 && !requiredSet.has(name)),
      ),
    )

    const reasonParts: string[] = []
    if (missingModels.length > 0) {
      reasonParts.push(
        `the task names ${missingModels.length} deliverable(s) this project does not define: ${missingModels.join(", ")}`,
      )
    }
    if (missingFiles.length > 0) {
      reasonParts.push(`required file(s) missing: ${missingFiles.join(", ")}`)
    }

    const hintLines: string[] = [
      `The task document (${contract.taskFile}) states these names literally. A model that does the right thing under a different name does not satisfy the task, and self-verification against the renamed output will not detect it.`,
    ]
    if (missingModels.length > 0) {
      hintLines.push(`  • Create or rename to exactly: ${missingModels.join(", ")}`)
    }
    if (missingFiles.length > 0) {
      hintLines.push(`  • Create at exactly these paths: ${missingFiles.join(", ")}`)
    }
    if (unrequested.length > 0) {
      // `unrequested` is derived from ACTUAL FILENAMES ON DISK, which — unlike
      // `missingModels`/`missingFiles` (constrained to identifier/path-shaped
      // code-span tokens by `extractRequiredDeliverables`) — can contain
      // arbitrary bytes, including newlines, on a POSIX filesystem. Spliced
      // verbatim into `fixHint`, a hostile or merely adversarial filename
      // breaks out of the bullet it is quoted in and lands at instruction
      // position in the synthetic retry turn `prompt.ts` builds from this.
      const safeUnrequested = unrequested.map((n) => sanitizeForPrompt(n, 80))
      hintLines.push(
        `  • Models you created this session that the task did not name: ${safeUnrequested.join(", ")}. If one of them is a renamed version of a required deliverable, rename the file (and any \`ref()\` to it) back to the required name.`,
      )
    }
    hintLines.push(
      "  • If a required deliverable is produced under an alias, set `alias` in its config so the required name is the relation name.",
    )

    return {
      ok: false,
      reason: `Deliverable-name mismatch: ${reasonParts.join("; ")}.`,
      fixHint: hintLines.join("\n"),
      details: { ...details, unrequested_models: unrequested },
    }
  },
}
// altimate_change end
