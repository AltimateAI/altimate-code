import path from "path"
import fs from "fs"
import { Instance } from "../../project/instance"
import { assertExternalDirectoryLegacy } from "../../tool/external-directory"

/**
 * Gate a file/directory path argument through the external_directory
 * permission, resolving relative paths against the PROJECT directory (mirrors
 * read.ts — never the process cwd). Returns the resolved path so the caller
 * reads exactly what was gated.
 *
 * Path-taking analysis tools must all use this single helper (dbt readers,
 * impact_analysis, and the schema_path-taking core wrappers): without it, a
 * read-scoped agent steered by untrusted project content could feed absolute
 * sibling or private paths to the engine and exfiltrate schema/DDL without a
 * prompt.
 *
 * Outside an Instance context (direct invocation in unit tests, standalone
 * scripts) there is no project boundary or permission session to consult —
 * the path is returned resolved against cwd and ungated, preserving the
 * pre-existing context-free behavior. Real agent sessions always run inside
 * Instance.provide, so the gate is always active where it matters.
 */
export async function guardExternalFile(
  ctx: unknown,
  p: string | undefined,
  kind: "file" | "directory" = "file",
): Promise<string | undefined> {
  if (!p) return p
  let base: string
  try {
    base = Instance.directory
  } catch {
    return path.resolve(p)
  }
  let resolved = path.isAbsolute(p) ? p : path.resolve(base, p)
  // Canonicalize symlinks BEFORE the gate: `path.resolve` leaves an in-project
  // symlink lexically inside the instance, so the containment check would not
  // prompt while the native loader (realpathSync) reads the external target.
  // Gate — and return — the real path so the read hits exactly what was gated.
  // realpathSync throws if the leaf doesn't exist yet (manifests may be
  // pre-build), so fall back to canonicalizing the nearest existing ancestor.
  try {
    resolved = fs.realpathSync(resolved)
  } catch {
    try {
      resolved = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved))
    } catch {
      /* neither leaf nor parent exists — gate the lexical path as-is */
    }
  }
  await assertExternalDirectoryLegacy(ctx as any, resolved, { kind })
  return resolved
}

/** Back-compat alias used by the schema_path-taking core wrappers. */
export async function guardSchemaPath(ctx: unknown, p: string | undefined): Promise<string | undefined> {
  return guardExternalFile(ctx, p, "file")
}

/**
 * True for permission-lifecycle errors (user rejection/correction, configured
 * denial). Tool catch blocks that wrap a guard call MUST rethrow these — the
 * session processor only applies blocked/corrected-call semantics when the
 * error escapes the tool; converting it into an ordinary error result lets
 * the agent retry a call the user explicitly refused.
 */
export function isPermissionError(e: unknown): boolean {
  const name = e instanceof Error ? e.constructor.name : ""
  return name === "RejectedError" || name === "CorrectedError" || name === "DeniedError"
}
