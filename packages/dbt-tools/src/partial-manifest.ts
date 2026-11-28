import path from "path"
import type { ParsedManifest, PartialManifest } from "@altimateai/dbt-integration"

// Each adapter's last parse errors, kept while the manifest dbt Fusion wrote for it is missing what failed to parse.
const partial = new WeakMap<object, PartialManifest>()

/** Takes each manifest an adapter parsed: a later parse with no errors clears the mark. */
export function recordPartialManifest(adapter: object, parsed: ParsedManifest): void {
  if (parsed.partial?.errors.length) partial.set(adapter, parsed.partial)
  else partial.delete(adapter)
}

/** Files named in the note's sentence; the rest are counted. */
const NAMED_FILES = 5

/**
 * What an answer built from the adapter's manifest adds, or undefined when its last parse had no errors.
 * Paths inside `projectRoot` are given relative to it.
 */
export function partialManifestNote(adapter: object, projectRoot?: string) {
  const mark = partial.get(adapter)
  if (!mark) return undefined
  const shown = (file: string) => {
    if (!projectRoot) return file
    const inside = path.relative(projectRoot, file)
    const outside = !inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)
    return outside ? file : inside.split(path.sep).join("/")
  }
  const errors = mark.errors.map((e) => ({ file_path: shown(e.filePath), message: e.message }))
  const files = [...new Set(errors.map((e) => e.file_path))]
  const named = files.slice(0, NAMED_FILES)
  const more = files.length - named.length
  const list =
    more > 0
      ? `${named.join(", ")} and ${more} more file${more === 1 ? "" : "s"}`
      : named.length > 1
        ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`
        : named[0]
  return {
    message: `This graph is missing parts because ${list} failed to parse.`,
    errors,
  }
}
