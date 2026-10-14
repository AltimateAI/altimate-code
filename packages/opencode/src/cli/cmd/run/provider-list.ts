// `run --model` checks the model against the server's provider list before it starts a session.
// A list call that failed used to read as an empty list, so a server error was reported as
// "Model not found" and looked like a typo in --model. This returns the list, or throws an error
// that says the call failed and why.

type ListResult<T> = {
  data?: { all: T[] }
  error?: unknown
  response?: Response
}

export function providerListOrThrow<T>(result: ListResult<T>, model: string): T[] {
  // Checked at runtime: a body that is not the expected JSON (an HTML page, say) still arrives as `data`.
  const all: unknown = (result.data as { all?: unknown } | undefined)?.all
  if (Array.isArray(all)) return all as T[]
  throw new Error(`Could not load the provider list to check --model ${model} (${describeFailure(result)})`)
}

function describeFailure(result: ListResult<unknown>): string {
  const status = result.response ? `HTTP ${result.response.status}` : "no response"
  const detail = errorDetail(result.error) ?? (result.response?.ok ? "unexpected response body" : undefined)
  return detail ? `${status}: ${detail.slice(0, 500)}` : status
}

function errorDetail(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error || undefined
  if (error && typeof error === "object" && Object.keys(error).length > 0) return JSON.stringify(error)
  return undefined
}
