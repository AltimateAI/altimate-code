import path from "path"
import { Instance } from "../../project/instance"
import { assertExternalDirectoryLegacy } from "../../tool/external-directory"

/**
 * Gate a schema_path (or any file-path argument) through the external_directory
 * permission, resolving relative paths against the PROJECT directory (mirrors
 * read.ts — never the process cwd). Returns the resolved path so the caller
 * reads exactly what was gated. Passes empty/undefined through untouched.
 *
 * Path-taking analysis tools must all use this: without it, a read-scoped
 * agent steered by untrusted project content could feed absolute sibling or
 * private paths to the engine and exfiltrate schema/DDL without a prompt.
 */
export async function guardSchemaPath(ctx: unknown, p: string | undefined): Promise<string | undefined> {
  if (!p) return p
  const resolved = path.isAbsolute(p) ? p : path.resolve(Instance.directory, p)
  await assertExternalDirectoryLegacy(ctx as any, resolved, { kind: "file" })
  return resolved
}
