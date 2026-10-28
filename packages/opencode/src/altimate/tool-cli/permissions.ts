import { Effect } from "effect"
import type { Tool } from "../../tool/tool"

/** Permission kinds the data tools raise for reads; anything else is a write and needs `--allow-write`. */
export const READ_PERMISSIONS: ReadonlySet<string> = new Set([
  "sql_execute",
  "sql_execute_read",
  "schema_inspect",
  "answer_commit",
])

// Same statements the agent's `safetyDenials` rules refuse (agent/agent.ts); matched case-insensitively.
const BLOCKED_STATEMENT = /^\s*(drop\s+(database|schema)\b|truncate\b)/i

export function isBlockedStatement(pattern: string): boolean {
  return BLOCKED_STATEMENT.test(pattern)
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
    if (READ_PERMISSIONS.has(permission)) return Effect.void
    if (!allowWrite) return Effect.die(denied(permission, retry))
    if (patterns?.some(isBlockedStatement)) {
      return Effect.die(
        new Error(`Permission denied: ${permission}. DROP DATABASE, DROP SCHEMA and TRUNCATE are blocked for safety. This cannot be overridden.`),
      )
    }
    return Effect.void
  }
}
