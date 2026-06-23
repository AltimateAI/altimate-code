import type { DBTProjectIntegrationAdapter, CommandProcessResult } from "@altimateai/dbt-integration"
import { schemaVerify } from "./schema-verify"

export async function build(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  const downstream = args.includes("--downstream")
  if (!model) {
    if (downstream) return { error: "--downstream requires --model" }
    return project(adapter)
  }
  const result = await adapter.unsafeBuildModelImmediately({
    plusOperatorLeft: "",
    modelName: model,
    plusOperatorRight: downstream ? "+" : "",
  })
  const formatted = format(result)

  // Auto-run schema-verify after a successful single-model build. Surfacing
  // the verdict in the same tool result the agent just received is the
  // closest a CLI command can get to harness-level enforcement: the agent
  // cannot see a green build without also seeing the schema-verify diff.
  if (!("error" in formatted)) {
    return { ...formatted, schema_verify: await safeVerify(adapter, model) }
  }
  return formatted
}

export async function run(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  const downstream = args.includes("--downstream")
  const result = await adapter.unsafeRunModelImmediately({
    plusOperatorLeft: "",
    modelName: model,
    plusOperatorRight: downstream ? "+" : "",
  })
  return format(result)
}

export async function test(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  const result = await adapter.unsafeRunModelTestImmediately(model)
  return format(result)
}

export async function project(adapter: DBTProjectIntegrationAdapter) {
  const result = await adapter.unsafeBuildProjectImmediately()
  const formatted = format(result)
  if ("error" in formatted) return formatted

  // After a successful project-wide build, auto-run schema-verify on every
  // model that has columns declared in schema.yml. This catches the case
  // where the agent used `altimate-dbt build` (no --model) or built via
  // plain `dbt build` and never invoked the per-model verify path.
  // Only the mismatches and verify errors are reported back. `no-spec`
  // models are summarised as a count to keep the response compact.
  try {
    const parsed = await adapter.parseManifest()
    const nodes = parsed?.nodeMetaMap?.nodes ? Array.from(parsed.nodeMetaMap.nodes()) : []
    const verified: Array<{ model: string; verdict: string; columns_extra?: unknown; columns_missing?: unknown; columns_reordered?: unknown; type_mismatches?: unknown }> = []
    const errored: Array<{ model: string; error: string }> = []
    let nospec_count = 0
    for (const node of nodes) {
      // Only models, only those with declared columns. Sources/seeds/snapshots/tests skipped.
      const resType = (node as { resource_type?: string }).resource_type
      if (resType !== "model") continue
      const name = (node as { name?: string }).name
      if (!name) continue
      const cols = (node as { columns?: Record<string, unknown> }).columns ?? {}
      if (Object.keys(cols).length === 0) {
        nospec_count++
        continue
      }
      try {
        const v = await schemaVerify(adapter, ["--model", name])
        if ("error" in v) {
          errored.push({ model: name, error: String((v as { error: unknown }).error) })
        } else if ((v as { verdict: string }).verdict === "no-spec") {
          nospec_count++
        } else {
          verified.push(v as { model: string; verdict: string })
        }
      } catch (e) {
        errored.push({ model: name, error: e instanceof Error ? e.message : String(e) })
      }
    }
    const mismatches = verified.filter((r) => r.verdict === "mismatch")
    const matches = verified.filter((r) => r.verdict === "match")
    return {
      ...formatted,
      schema_verify_summary: {
        models_checked: verified.length + errored.length,
        match: matches.length,
        mismatch: mismatches.length,
        no_spec: nospec_count,
        errored: errored.length,
        mismatches,
        ...(errored.length > 0 && { errors: errored }),
      },
    }
  } catch (e) {
    return {
      ...formatted,
      schema_verify_summary: {
        error: `Bulk schema-verify failed: ${e instanceof Error ? e.message : String(e)}. Run \`altimate-dbt schema-verify --model <name>\` per model to inspect.`,
      },
    }
  }
}

async function safeVerify(adapter: DBTProjectIntegrationAdapter, model: string) {
  try {
    return await schemaVerify(adapter, ["--model", model])
  } catch (e) {
    return {
      error: `schema-verify failed: ${e instanceof Error ? e.message : String(e)}. Run \`altimate-dbt schema-verify --model ${model}\` manually to inspect.`,
    }
  }
}

// TODO: dbt writes info/progress logs to stderr even on success — checking stderr
// alone causes false failures. CommandProcessResult has no exit_code field, so we
// can't distinguish real errors yet. Revisit when the type is extended.
function format(result?: CommandProcessResult) {
  if (result?.stderr) return { error: result.stderr, stdout: result.stdout }
  return { stdout: result?.stdout ?? "" }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
