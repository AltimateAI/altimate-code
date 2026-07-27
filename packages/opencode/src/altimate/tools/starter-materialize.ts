import fs from "node:fs"
import path from "node:path"
import z from "zod"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Tool } from "../../tool/tool"
import { materializeSample } from "../onboarding/materialize"
import { DEFAULT_SAMPLE_NAME, resolveSampleSource } from "../onboarding/sample-source-resolver"

/**
 * `starter_materialize` — LLM-invoked tool that copies the shipped
 * jaffle-shop DuckDB starter sample onto the user's filesystem and
 * returns a structured summary the `/starter` template branches on.
 *
 * Contract with the template
 * (`packages/opencode/src/command/template/starter.txt`):
 *
 *   Success: `{title, metadata: {targetPath, reused, suffix, note}, output}`
 *     - reused=true  → template branch 1 ("already set up at ...")
 *     - reused=false, suffix=0 → branch 2 ("Sample project created at ...")
 *     - reused=false, suffix=number>0 OR suffix=string → branch 3
 *       (preferred name was taken, used a suffixed variant)
 *   Failure: `{title, metadata: {error}, output}` — `output` carries a
 *     verbatim actionable message ("Target parent directory X is not
 *     writable", "HOME=/root but this process is not running as root",
 *     etc.) that the template passes through unchanged.
 *
 * The LLM invokes this with no arguments (the template says so). All
 * schema parameters are optional and only exist for tests + advanced
 * callers who want to override the target path.
 *
 * The sample version is read from the shipped
 * `sample-projects/<name>/sample-manifest.json` — bumping the sample
 * automatically bumps the version stamped into the marker without a
 * code change here.
 */
export const StarterMaterializeTool = Tool.define("starter_materialize", {
  description:
    "Materialize the shipped jaffle-shop DuckDB starter sample onto the user's disk. " +
    "Called by the `/starter` slash command flow after the user picks 'Open sample project' " +
    "from the first-run activation dialog. Idempotent — a second call reuses the existing " +
    "materialized directory without re-copying. Never overwrites an unrelated user directory: " +
    "if the preferred path holds unknown content, materializes into a suffixed variant " +
    "(`<name>-2`, `<name>-3`, ...) instead.",
  parameters: z.object({
    preferred_target_name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Directory name (relative to the target parent) to materialize into. Defaults to " +
          "`altimate-sample-dbt`. Rarely overridden — the default matches what the /starter " +
          "template documents.",
      ),
    target_parent: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Parent directory that holds the materialized copy. Defaults to `os.homedir()` after " +
          "a safety check against unsafe HOME values (/root, /tmp/*, /). Pass explicitly only " +
          "if the user asked for a specific location.",
      ),
    allow_in_place_upgrade: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "When the target exists at a different sample version, overwrite in place instead of " +
          "returning `reused: true` with a prompt hint. Only set true after the user has " +
          "confirmed they want to upgrade.",
      ),
  }),
  async execute(args, _ctx) {
    const sampleName = DEFAULT_SAMPLE_NAME
    let sampleVersion: string
    try {
      sampleVersion = readSampleVersion(sampleName)
    } catch (err) {
      return {
        title: "Starter sample unavailable",
        metadata: { error: "sample_source_missing", targetPath: "", reused: false, suffix: 0, note: "" },
        output:
          `Could not locate the shipped starter sample source. This usually means the CLI ` +
          `was installed without its wrapper package assets. Reinstall with: ` +
          `\`npm i -g @altimateai/altimate-code@latest\`\n\n` +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    try {
      const result = await materializeSample({
        sampleName,
        preferredTargetName: args.preferred_target_name,
        targetParent: args.target_parent,
        cliVersion: InstallationVersion,
        sampleVersion,
        allowInPlaceUpgrade: args.allow_in_place_upgrade,
      })
      return {
        title: result.reused ? `Reused starter sample at ${result.targetPath}` : `Materialized starter sample at ${result.targetPath}`,
        metadata: {
          error: "",
          targetPath: result.targetPath,
          reused: result.reused,
          suffix: result.suffix,
          note: result.note,
        },
        output:
          `${result.targetPath}\n\n` +
          `reused: ${result.reused}\n` +
          `suffix: ${result.suffix}\n` +
          `note: ${result.note}`,
      }
    } catch (err) {
      // materializeSample throws with actionable messages for the three
      // failure modes: unsafe HOME (rejectUnsafeHome), unwritable target
      // parent (checkParentWritable), or missing sample source. Pass the
      // message through verbatim — the template says so.
      const message = err instanceof Error ? err.message : String(err)
      return {
        title: "Starter materialization failed",
        metadata: { error: "materialize_failed", targetPath: "", reused: false, suffix: 0, note: "" },
        output: message,
      }
    }
  },
})

/**
 * Read the sample's `sample-manifest.json` and return its `version` field.
 * The version stamps into the on-disk marker so a future run can detect
 * whether the materialized copy is current or lags a CLI upgrade.
 */
function readSampleVersion(sampleName: string): string {
  const location = resolveSampleSource(sampleName)
  if (!location) {
    throw new Error(`resolveSampleSource returned undefined for '${sampleName}'`)
  }
  const manifestPath = path.join(location.path, "sample-manifest.json")
  const raw = fs.readFileSync(manifestPath, "utf8")
  const parsed = JSON.parse(raw) as { version?: unknown }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`sample-manifest.json at ${manifestPath} is missing a string \`version\` field`)
  }
  return parsed.version
}
