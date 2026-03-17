import type { DBTProjectIntegrationAdapter, CommandProcessResult } from "@altimateai/dbt-integration"

export async function build(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  const downstream = args.includes("--downstream")
  const result = await adapter.unsafeBuildModelImmediately({
    plusOperatorLeft: "",
    modelName: model,
    plusOperatorRight: downstream ? "+" : "",
  })
  return format(result)
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
  return format(result)
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
