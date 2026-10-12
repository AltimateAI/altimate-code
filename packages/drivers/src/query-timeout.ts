/**
 * Query execution deadline policy shared by every driver.
 *
 * Precedence (first that is set wins):
 *   1. `options.queryTimeoutMs`         per call
 *   2. `config.query_timeout_ms`        per connection
 *   3. `ALTIMATE_SQL_QUERY_TIMEOUT_MS`  per machine
 *   4. DEFAULT_QUERY_TIMEOUT_MS
 * A value of `0` (or `null` on the connection) means "no deadline" so
 * deliberately long warehouse jobs stay possible. Unusable values (negative,
 * NaN, non-numeric) are ignored and fall through to the next source.
 *
 * This is the interactive execution budget only. Connection, open and
 * server-selection budgets are separate and untouched.
 */

import type { ConnectionConfig, ExecuteOptions } from "./types"

export const DEFAULT_QUERY_TIMEOUT_MS = 120_000
export const QUERY_TIMEOUT_ENV = "ALTIMATE_SQL_QUERY_TIMEOUT_MS"

/** Largest delay `setTimeout` represents; larger values overflow to 1ms. */
export const MAX_TIMER_MS = 2_147_483_647

export type QueryTimeoutSource = "call" | "connection" | "env" | "default"

export interface QueryTimeout {
  /** Deadline in ms, or `undefined` when disabled. */
  ms: number | undefined
  source: QueryTimeoutSource
}

type Parsed = { disabled: true } | { ms: number } | undefined

function parse(value: unknown, allowNull: boolean): Parsed {
  if (value === null) return allowNull ? { disabled: true } : undefined
  if (value === undefined || value === "" || typeof value === "boolean") return undefined
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  if (n === 0) return { disabled: true }
  return { ms: Math.min(Math.round(n), MAX_TIMER_MS) }
}

export function resolveQueryTimeout(
  config: ConnectionConfig | undefined,
  options?: Pick<ExecuteOptions, "queryTimeoutMs">,
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): QueryTimeout {
  const sources: Array<[QueryTimeoutSource, Parsed]> = [
    ["call", parse(options?.queryTimeoutMs, false)],
    ["connection", parse(config?.["query_timeout_ms"], true)],
    ["env", parse(env[QUERY_TIMEOUT_ENV], false)],
  ]
  for (const [source, parsed] of sources) {
    if (!parsed) continue
    return { ms: "ms" in parsed ? parsed.ms : undefined, source }
  }
  return { ms: DEFAULT_QUERY_TIMEOUT_MS, source: "default" }
}

/** The tighter of two optional positive limits (`undefined` = unlimited). */
export function tighter(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}
