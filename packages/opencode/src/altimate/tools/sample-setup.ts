import fs from "node:fs"
import path from "node:path"
import z from "zod"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Tool } from "../../tool/tool"
import { materializeSample } from "../onboarding/materialize"
import { DEFAULT_SAMPLE_NAME, resolveSampleSource, type SampleSourceLocation } from "../onboarding/sample-source-resolver"
import { detectDbtRuntime } from "../onboarding/tool-detection"
// altimate_change — onboarding funnel: sample_setup_completed
import * as OnboardingTelemetry from "../telemetry/onboarding"

/**
 * `sample_setup` — LLM-invoked tool that copies the shipped jaffle-shop
 * DuckDB sample onto the user's filesystem and returns a structured
 * summary the `/onboard-connect` template branches on.
 *
 * Contract with the template
 * (`packages/opencode/src/command/template/onboard-connect.txt`, sample
 * routing block):
 *
 *   Success: `{title, metadata: {targetPath, reused, suffix, note}, output}`
 *     - reused=true, note contains "Caller must prompt" → template
 *       prompts before overwriting (different sample version on disk)
 *     - reused=true, no such note → "already set up at <path>"
 *     - reused=false, suffix=0 → "Sample project created at <path>"
 *     - reused=false, suffix>0 → preferred name was taken, used a
 *       suffixed variant (`<name>-2`, `<name>-3`, …)
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
export const SampleSetupTool = Tool.define("sample_setup", {
  description:
    "Materialize the shipped jaffle-shop DuckDB sample dbt project onto the user's disk. " +
    "Called by the /onboard-connect activation menu when the user picks 'Try Altimate on a " +
    "sample dbt project'. Idempotent — a second call reuses the existing materialized " +
    "directory without re-copying. Never overwrites an unrelated user directory: if the " +
    "preferred path holds unknown content, materializes into a suffixed variant " +
    "(`<name>-2`, `<name>-3`, ...) instead.",
  parameters: z.object({
    preferred_target_name: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
        message:
          "must be a plain directory name (letters/digits/dot/dash/underscore only, no path separators, no leading dot)",
      })
      .optional()
      .describe(
        "Directory name (relative to the target parent) to materialize into. Defaults to " +
          "`altimate-sample-dbt`. Rarely overridden — the default matches what the activation " +
          "menu documents. Must be a single path segment: letters, digits, dot, dash, " +
          "underscore only. Not a full path. Do not include `/` or `..`.",
      ),
    allow_in_place_upgrade: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "When the target exists at a different sample version, overwrite in place instead of " +
          "returning `reused: true` with a prompt hint. Only set true after the user has " +
          "confirmed they want to upgrade AND does not care about local edits in the old copy.",
      ),
    install_alongside: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "When the target exists at a different sample version, materialize the new version " +
          "into `<name>-2` (or the next free suffix) instead of touching the old copy. Use " +
          "this after the user has picked the 'install alongside' option from the version-" +
          "conflict prompt. Mutually exclusive with allow_in_place_upgrade; alongside wins.",
      ),
  }),
  async execute(args, _ctx) {
    const sampleName = DEFAULT_SAMPLE_NAME
    // Resolve the sample source ONCE per invocation and pass it forward.
    // materializeSample() would otherwise call resolveSampleSource() again
    // internally; on the wrapper-bin-parent / dev-source-tree candidates
    // that means an extra fs.existsSync() sweep across the whole hunt
    // chain — cheap in absolute terms, but a redundant expense the tool
    // pays on every activation. Resolving once also guarantees that the
    // manifest read and the materialize copy come from the SAME source
    // directory (a mid-invocation env or filesystem change can't put them
    // out of sync).
    let sampleSource: SampleSourceLocation
    let sampleVersion: string
    try {
      const resolved = resolveSampleSource(sampleName)
      if (!resolved) {
        throw new Error(`resolveSampleSource returned undefined for '${sampleName}'`)
      }
      sampleSource = resolved
      sampleVersion = readSampleVersionAt(sampleSource.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const guidance =
        `Could not locate the shipped starter sample source. This usually means the CLI ` +
        `was installed without its wrapper package assets. Reinstall with: ` +
        `\`npm i -g @altimateai/altimate-code@latest\`\n\n` +
        `Underlying error: ${message}`
      return {
        title: "Starter sample unavailable",
        metadata: { success: false, error: message, targetPath: "", reused: false, suffix: 0, note: "" },
        output: `status: error\nreason: sample_source_missing\n\n${guidance}`,
      }
    }

    try {
      const result = await materializeSample({
        sampleName,
        preferredTargetName: args.preferred_target_name,
        // NOTE: targetParent is deliberately NOT plumbed from tool args — it
        // was removed from the LLM-facing schema to close a bypass of the
        // rejectUnsafeHome guard (a caller-controlled parent skipped the
        // check). Callers who need a specific parent use materializeSample
        // directly with allowUnsafeParent for tests.
        cliVersion: InstallationVersion,
        sampleVersion,
        allowInPlaceUpgrade: args.allow_in_place_upgrade,
        installAlongside: args.install_alongside,
        preResolvedSource: sampleSource,
      })
      // Probe dbt-runtime state so the template's "Build & query it" branch
      // can read it directly instead of shelling out to a duplicate probe.
      // Force-refresh in case the user pip-installed dbt-duckdb during the
      // session (cache from an earlier render would say hasDbtDuckdb=false).
      const dbt = await detectDbtRuntime({ force: true })
      const dbtLine = dbt.hasDbt
        ? `dbt: present (dbt-core ${dbt.dbtCoreVersion ?? "unknown"}, duckdb-adapter ${dbt.hasDbtDuckdb ? "present" : "missing"})`
        : `dbt: missing (dbt-core not on PATH)`

      // Self-describing status prefix — the model only sees `output`, never
      // `metadata` (packages/opencode/src/session/message-v2.ts:822). The
      // template branches on `status: ok` vs `status: error` in this text.
      const outputText =
        `status: ok\n` +
        `path: ${result.targetPath}\n` +
        `reused: ${result.reused}\n` +
        `suffix: ${result.suffix}\n` +
        `${dbtLine}\n` +
        `note: ${result.note}`
      // altimate_change start — onboarding funnel. `reused` is carried because the tool is
      // deliberately re-callable (reuse / reset / install-alongside / dbt re-probe), so this
      // fires per invocation, not once per sample. targetPath is never sent — it is a filesystem
      // path under the user's home.
      const sampleContents = countSampleContents(sampleSource.path)
      void OnboardingTelemetry.emit({
        type: "sample_setup_completed",
        success: true,
        models: sampleContents.models,
        tables: sampleContents.tables,
        reused: result.reused,
      })
      // altimate_change end
      return {
        title: result.reused ? `Reused starter sample at ${result.targetPath}` : `Materialized starter sample at ${result.targetPath}`,
        metadata: {
          success: true,
          targetPath: result.targetPath,
          reused: result.reused,
          suffix: result.suffix,
          note: result.note,
          dbtRuntime: dbt,
        },
        output: outputText,
      }
    } catch (err) {
      // materializeSample throws with actionable messages for the three
      // failure modes: unsafe HOME (rejectUnsafeHome), unwritable target
      // parent (checkParentWritable), or missing sample source. Wrap the
      // message with a status prefix so the template's failure branch can
      // reliably detect it from `output` alone — metadata never reaches
      // the model.
      const message = err instanceof Error ? err.message : String(err)
      // altimate_change — onboarding funnel: failed setup. The error message embeds filesystem
      // paths (unsafe HOME, unwritable parent), so it is not sent — only the boolean.
      void OnboardingTelemetry.emit({
        type: "sample_setup_completed",
        success: false,
        models: 0,
        tables: 0,
        reused: false,
      })
      return {
        title: "Starter materialization failed",
        metadata: { success: false, error: message, targetPath: "", reused: false, suffix: 0, note: "" },
        output: `status: error\nreason: materialize_failed\n\n${message}`,
      }
    }
  },
})

/**
 * Read the sample's `sample-manifest.json` from an ALREADY-RESOLVED source
 * directory and return its `version` field. Takes the resolved path (not the
 * sample name) so the caller can resolve once and share the result with
 * downstream materializeSample — see finding 25.
 *
 * The version stamps into the on-disk marker so a future run can detect
 * whether the materialized copy is current or lags a CLI upgrade.
 */
// altimate_change start — onboarding funnel: model/seed counts for sample_setup_completed.
//
// Counted from the shipped source tree rather than read from a constant or from dbt's
// target/manifest.json. A constant silently drifts the first time someone adds a model;
// target/manifest.json is ~17k lines and parsing it to count two things is a waste on a path
// the user is actively waiting on. Counting files can't drift and costs one shallow walk.
//
// Best-effort by construction: telemetry must never fail a sample setup, so any fs error
// yields 0 rather than propagating.
function countFilesWithExtension(dir: string, extension: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      total += countFilesWithExtension(path.join(dir, entry.name), extension)
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      total += 1
    }
  }
  return total
}

/** dbt models (`models/**\/*.sql`) and seed tables (`seeds/*.csv`) in the shipped sample. */
function countSampleContents(sampleSourcePath: string): { models: number; tables: number } {
  return {
    models: countFilesWithExtension(path.join(sampleSourcePath, "models"), ".sql"),
    tables: countFilesWithExtension(path.join(sampleSourcePath, "seeds"), ".csv"),
  }
}
// altimate_change end

function readSampleVersionAt(sampleSourcePath: string): string {
  const manifestPath = path.join(sampleSourcePath, "sample-manifest.json")
  const raw = fs.readFileSync(manifestPath, "utf8")
  const parsed = JSON.parse(raw) as { version?: unknown }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`sample-manifest.json at ${manifestPath} is missing a string \`version\` field`)
  }
  return parsed.version
}
