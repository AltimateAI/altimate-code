import { Effect } from "effect"
import type { Tool } from "../../tool/tool"
import { classifyAndCheck } from "../tools/sql-classify"
import * as Registry from "../native/connections/registry"

/** Permission kinds the data tools raise for reads; anything else is a write and needs `--allow-write`. */
export const READ_PERMISSIONS: ReadonlySet<string> = new Set([
  "sql_execute",
  "sql_execute_read",
  "schema_inspect",
  "answer_commit",
])

// Same statements the agent's `safetyDenials` rules refuse (agent/agent.ts), found by the SQL
// classifier past comments and in later statements. Callers pass the warehouse so its dialect's
// quoting and comments apply; without one the classifier's generic lexing is used.
export function isBlockedStatement(pattern: string, dialect?: string): boolean {
  return classifyAndCheck(pattern, dialect).blocked
}

function dialectOf(metadata: unknown): string | undefined {
  const warehouse = (metadata as { warehouse?: unknown } | undefined)?.warehouse
  return typeof warehouse === "string" && warehouse
    ? (Registry.canonicalType(Registry.getConfig(warehouse)?.type) ?? undefined)
    : undefined
}

export function denied(permission: string, retry = "Re-run"): Error {
  return new Error(`Permission denied: ${permission}. ${retry} with --allow-write to enable writes.`)
}

/**
 * The `ask` handler for a CLI call. Nothing prompts: reads in READ_PERMISSIONS pass, every other
 * kind is denied unless writes were enabled, and blocked destructive statements are refused either way.
 */
export function askFor(allowWrite: boolean, retry = "Re-run"): Tool.Context["ask"] {
  return ({ permission, patterns, metadata }) => {
    const dialect = dialectOf(metadata)
    // sql_execute has already checked its whole SQL; its pattern is a 200-character preview, which a cut
    // inside a literal would make read differently.
    const checked = (metadata as { hardDenyChecked?: unknown } | undefined)?.hardDenyChecked === true
    if (!checked && patterns?.some((pattern) => isBlockedStatement(pattern, dialect))) {
      return Effect.die(
        new Error(`Permission denied: ${permission}. DROP DATABASE, DROP SCHEMA and TRUNCATE are blocked for safety. This cannot be overridden.`),
      )
    }
    if (READ_PERMISSIONS.has(permission)) return Effect.void
    if (!allowWrite) return Effect.die(denied(permission, retry))
    return Effect.void
  }
}
