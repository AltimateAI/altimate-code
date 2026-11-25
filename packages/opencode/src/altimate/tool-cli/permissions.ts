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

/**
 * Checks that only read but bill the warehouse they run on, which they can start if it is stopped. They are
 * never granted as reads. Nothing here can prompt, so a direct `tool run` is the user's own go-ahead; over
 * MCP the model makes the call, so they are refused unless the server was started with `--allow-write`.
 */
export const BILLABLE_RUN_PERMISSIONS: ReadonlySet<string> = new Set(["finops_databricks_savings", "finops_snowflake_savings"])

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
 * The `ask` handler for a CLI or MCP call. Nothing prompts: reads in READ_PERMISSIONS pass, billable runs
 * pass only on a direct CLI call, every other kind is denied unless writes were enabled, and blocked
 * destructive statements are refused either way.
 */
export function askFor(allowWrite: boolean, retry = "Re-run", caller: { cli?: boolean } = {}): Tool.Context["ask"] {
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
    if (BILLABLE_RUN_PERMISSIONS.has(permission) && !caller.cli && !allowWrite)
      return Effect.die(
        new Error(
          `Permission denied: ${permission}. It can start a stopped warehouse that then bills, and an MCP call cannot ask the user. ` +
            `Run it with \`altimate-code tool run ${permission}\` once the user agrees, or restart the server with --allow-write.`,
        ),
      )
    if (BILLABLE_RUN_PERMISSIONS.has(permission)) return Effect.void
    if (!allowWrite) return Effect.die(denied(permission, retry))
    return Effect.void
  }
}
