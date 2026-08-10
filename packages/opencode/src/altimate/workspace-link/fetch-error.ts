// altimate_change — shared error formatting for every fetch() this feature makes against the
// workspace backend (api-client.ts's WorkspaceLinkApi, workspace-backend-client.ts's
// WorkspaceBackendApi). Found via a live repro (checkpoint 8h bug report): with the backend
// unreachable, the raw runtime message ("Unable to connect. Is the computer able to access the
// url?" — or similarly worded, depending on the runtime) surfaced verbatim, with no URL and no
// indication of what to actually check. Every caller now gets the URL it tried and a direct
// "is the backend running?" prompt instead.
export function describeFetchError(url: string, err: unknown, timeoutMs?: number): string {
  if (err instanceof Error && err.name === "AbortError" && timeoutMs !== undefined) {
    return `Request to ${url} timed out after ${timeoutMs / 1000}s. Is the workspace backend running there?`
  }
  return `Could not reach the workspace backend at ${url}. Is it running? (${err instanceof Error ? err.message : String(err)})`
}
