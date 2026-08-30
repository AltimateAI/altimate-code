export const REQUIRED_CATALOG_PROVIDERS = ["anthropic", "openai", "google"] as const
export const MIN_CATALOG_PROVIDERS = 50

type CatalogSummary = {
  providerCount: number
  requiredModelCounts: Record<string, number>
  strict: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalStringProblem(value: unknown, where: string, allowEmpty = true): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") return `${where} is not a string`
  if (!allowEmpty && value.length === 0) return `${where} is empty`
  return undefined
}

function requiredStringProblem(value: unknown, where: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return `${where} is not a non-empty string`
  return undefined
}

function requiredBooleanProblem(value: unknown, where: string): string | undefined {
  if (typeof value !== "boolean") return `${where} is not a boolean`
  return undefined
}

function stringArrayProblem(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return `${where} is not a string array`
  return undefined
}

/** Describe the first runtime-relevant structural problem in a provider entry. */
function providerEntryProblem(id: string, entry: unknown): string | undefined {
  if (!isRecord(entry)) return `${id} (not an object)`
  if (typeof entry.id !== "string" || entry.id.length === 0) return `${id} (no non-empty string id)`
  if (entry.id !== id) return `${id} (id does not match catalog key)`

  const nameProblem = requiredStringProblem(entry.name, `${id}.name`)
  if (nameProblem) return nameProblem

  const envProblem = stringArrayProblem(entry.env, `${id}.env`)
  if (envProblem) return envProblem
  const apiProblem = optionalStringProblem(entry.api, `${id}.api`)
  if (apiProblem) return apiProblem
  const npmProblem = optionalStringProblem(entry.npm, `${id}.npm`, false)
  if (npmProblem) return npmProblem

  if (!("models" in entry)) return `${id} (no models)`
  if (!isRecord(entry.models)) return `${id} (models is not a map)`

  for (const [modelId, model] of Object.entries(entry.models)) {
    const where = `${id}/${modelId}`
    if (!isRecord(model)) return `${where} (not an object)`
    if (typeof model.id !== "string" || model.id.length === 0) return `${where} (no non-empty string id)`
    if (model.id !== modelId) return `${where} (id does not match catalog key)`

    for (const field of ["name", "release_date"] as const) {
      const problem = requiredStringProblem(model[field], `${where}.${field}`)
      if (problem) return problem
    }
    for (const field of ["attachment", "reasoning", "tool_call"] as const) {
      const problem = requiredBooleanProblem(model[field], `${where}.${field}`)
      if (problem) return problem
    }
    // models.dev currently omits `temperature` for some valid entries. Undefined
    // is consumed as a falsey capability, but a present non-boolean still violates
    // the runtime contract and must not be embedded.
    if (model.temperature !== undefined) {
      const temperatureProblem = requiredBooleanProblem(model.temperature, `${where}.temperature`)
      if (temperatureProblem) return temperatureProblem
    }

    if (model.provider !== undefined && model.provider !== null) {
      if (!isRecord(model.provider)) return `${where}.provider is not an object`
      const modelApiProblem = optionalStringProblem(model.provider.api, `${where}.provider.api`)
      if (modelApiProblem) return modelApiProblem
      const modelNpmProblem = optionalStringProblem(model.provider.npm, `${where}.provider.npm`, false)
      if (modelNpmProblem) return modelNpmProblem
    }

    if (!isRecord(model.limit)) return `${where} (limit is not an object)`
    if (typeof model.limit.context !== "number") return `${where} (limit.context is not a number)`
    if (typeof model.limit.output !== "number") return `${where} (limit.output is not a number)`
    if (model.limit.input !== undefined && model.limit.input !== null && typeof model.limit.input !== "number")
      return `${where} (limit.input is not a number)`

    if (model.modalities !== undefined && model.modalities !== null) {
      if (!isRecord(model.modalities)) return `${where}.modalities is not an object`
      const inputProblem = stringArrayProblem(model.modalities.input, `${where}.modalities.input`)
      if (inputProblem) return inputProblem
      const outputProblem = stringArrayProblem(model.modalities.output, `${where}.modalities.output`)
      if (outputProblem) return outputProblem
    }
  }
  return undefined
}

/** Return a log-safe description without URL userinfo, path, query or fragment. */
export function catalogDiagnosticOrigin(source: string, kind: "file" | "url"): string {
  if (kind === "file") return "local catalog file"
  try {
    const url = new URL(source)
    if (url.protocol !== "http:" && url.protocol !== "https:") return "custom catalog endpoint"
    return url.origin
  } catch {
    return "custom catalog endpoint"
  }
}

/** Reject a catalog that parses but cannot be consumed safely at runtime. */
export function assertUsableCatalog(text: string, diagnosticOrigin: string, strict: boolean): CatalogSummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`models.dev catalog from ${diagnosticOrigin} is not valid JSON`)
  }
  if (!isRecord(parsed)) throw new Error(`models.dev catalog from ${diagnosticOrigin} is not a provider object`)

  const catalog = new Map<string, unknown>(Object.entries(parsed))
  if (catalog.size === 0) throw new Error(`models.dev catalog from ${diagnosticOrigin} is empty`)

  const problems = [...catalog.entries()]
    .map(([id, entry]) => providerEntryProblem(id, entry))
    .filter((problem): problem is string => problem !== undefined)
  if (problems.length > 0)
    throw new Error(
      `models.dev catalog from ${diagnosticOrigin} has ${problems.length} malformed provider entries: ` +
        `${problems.slice(0, 5).join(", ")}${problems.length > 5 ? ", …" : ""}`,
    )

  const modelCount = (id: string): number => {
    const entry = catalog.get(id)
    if (!isRecord(entry) || !isRecord(entry.models)) return 0
    return Object.keys(entry.models).length
  }

  if (strict) {
    if (catalog.size < MIN_CATALOG_PROVIDERS)
      throw new Error(
        `models.dev catalog from ${diagnosticOrigin} has only ${catalog.size} providers, ` +
          `expected at least ${MIN_CATALOG_PROVIDERS}`,
      )
    const missing = REQUIRED_CATALOG_PROVIDERS.filter((provider) => !catalog.has(provider))
    if (missing.length > 0)
      throw new Error(
        `models.dev catalog from ${diagnosticOrigin} is missing required providers: ${missing.join(", ")}`,
      )
    const empty = REQUIRED_CATALOG_PROVIDERS.filter((provider) => modelCount(provider) === 0)
    if (empty.length > 0)
      throw new Error(`models.dev catalog from ${diagnosticOrigin} has no usable models for: ${empty.join(", ")}`)
  }

  return {
    providerCount: catalog.size,
    requiredModelCounts: Object.fromEntries(
      REQUIRED_CATALOG_PROVIDERS.map((provider) => [provider, modelCount(provider)]),
    ),
    strict,
  }
}

export function formatCatalogSummary(summary: CatalogSummary, diagnosticOrigin: string): string {
  if (!summary.strict)
    return `models.dev catalog from ${diagnosticOrigin}: ${summary.providerCount} providers (custom catalog, size floor not applied)`
  return (
    `models.dev catalog from ${diagnosticOrigin}: ${summary.providerCount} providers ` +
    `(${REQUIRED_CATALOG_PROVIDERS.map((provider) => `${provider}=${summary.requiredModelCounts[provider]}`).join(
      ", ",
    )})`
  )
}
