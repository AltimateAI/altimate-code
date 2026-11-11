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
