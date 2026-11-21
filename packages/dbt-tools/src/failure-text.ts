import type { CommandProcessResult } from "@altimateai/dbt-integration"

/** What `--format text` prints on stderr for an error answer. */
export function failureLines(failed: Record<string, unknown>): string[] {
  const lines: string[] = []
  // The note comes first, as in the JSON answer: the error rests on that manifest.
  const stale = failed.stale_manifest
  if (stale && typeof stale === "object" && "message" in stale) lines.push(String(stale.message))
  lines.push(String(failed.error))
  if ("fix" in failed) lines.push(String(failed.fix))
  if (Array.isArray(failed.logs)) lines.push(failed.logs.join("\n"))
  return lines
}

export function formatCommandResult(result?: CommandProcessResult) {
  const stdout = result?.stdout ?? ""
  if (result?.exitCode && result.exitCode !== 0) {
    return { error: result.stderr || stdout || `dbt exited with code ${result.exitCode}`, stdout }
  }
  if (result?.exitCode !== 0 && result?.stderr) return { error: result.stderr, stdout }
  return { stdout }
}
