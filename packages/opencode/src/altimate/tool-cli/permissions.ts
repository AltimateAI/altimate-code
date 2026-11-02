import { Effect } from "effect"
import type { Tool } from "../../tool/tool"
import { classifyAndCheck } from "../tools/sql-classify"

/** Permission kinds the data tools raise for reads; anything else is a write and needs `--allow-write`. */
export const READ_PERMISSIONS: ReadonlySet<string> = new Set([
  "sql_execute",
  "sql_execute_read",
  "schema_inspect",
  "answer_commit",
])

// Same statements the agent's `safetyDenials` rules refuse (agent/agent.ts), found by the SQL classifier
// so leading comments and later statements of a multi-statement pattern are seen too.
export function isBlockedStatement(pattern: string): boolean {
  return classifyAndCheck(pattern).blocked
}

export function denied(permission: string, retry = "Re-run"): Error {
  return new Error(`Permission denied: ${permission}. ${retry} with --allow-write to enable writes.`)
}

/**
 * The `ask` handler for a CLI call. Nothing prompts: reads in READ_PERMISSIONS pass, every other
 * kind is denied unless writes were enabled, and blocked destructive statements are refused either way.
 */
export function askFor(allowWrite: boolean, retry = "Re-run"): Tool.Context["ask"] {
  return ({ permission, patterns }) => {
    if (patterns?.some(isBlockedStatement)) {
      return Effect.die(
        new Error(`Permission denied: ${permission}. DROP DATABASE, DROP SCHEMA and TRUNCATE are blocked for safety. This cannot be overridden.`),
      )
    }
    if (READ_PERMISSIONS.has(permission)) return Effect.void
    if (!allowWrite) return Effect.die(denied(permission, retry))
    return Effect.void
  }
}
