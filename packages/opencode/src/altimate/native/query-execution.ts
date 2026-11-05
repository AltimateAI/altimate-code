import type { ConnectionConfig, ExecuteOptions } from "@altimateai/drivers/types"
import { QueryTimeoutError } from "@altimateai/drivers/types"
import { MAX_TIMER_MS, resolveQueryTimeout } from "@altimateai/drivers/query-timeout"
import { RunBudget } from "../run-budget"

export interface QueryContext {
  signal?: AbortSignal
  sessionID?: string
  /** MCP source reads request database protection even when SQL classifies as a read. */
  forceReadOnly?: boolean
}

/** Share the session cutoff across probes, extraction and scratch writes. */
export async function executeQuery<T>(
  config: ConnectionConfig | undefined,
  options: ExecuteOptions,
  context: QueryContext | undefined,
  work: (options: ExecuteOptions) => Promise<T>,
): Promise<T> {
  const parents = [...new Set([context?.signal, options.signal].filter((signal): signal is AbortSignal => !!signal))]
  for (const signal of parents) signal.throwIfAborted()
  const cutoff = context?.sessionID ? RunBudget.queryDeadline(context.sessionID) : undefined
  const remaining = cutoff === undefined ? undefined : Math.max(0, cutoff - Date.now())
  const configured = resolveQueryTimeout(config, options).ms
  const timeout = remaining === undefined ? configured : Math.min(configured ?? MAX_TIMER_MS, remaining)
  const expired = () => new QueryTimeoutError({ engine: config?.type ?? "database", timeoutMs: timeout!, cancelled: false })
  if (timeout === 0) throw expired()

  const controller = new AbortController()
  const abort = (event: Event) => controller.abort((event.target as AbortSignal).reason)
  for (const signal of parents) signal.addEventListener("abort", abort, { once: true })
  // Without a run cutoff local engines own execution time and queue admission.
  // With a cutoff the signal also removes queued work before it can execute late.
  const type = config?.type.toLowerCase()
  const local = type === "sqlite" || type === "duckdb"
  const outer = local && remaining === undefined ? undefined : timeout
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  try {
    const cancelled = new Promise<never>((_, reject) => {
      stop = () => reject(controller.signal.reason)
      controller.signal.addEventListener("abort", stop, { once: true })
    })
    if (outer !== undefined) timer = setTimeout(() => controller.abort(expired()), outer)
    return await Promise.race([
      work({ ...options, queryTimeoutMs: timeout, signal: controller.signal }),
      cancelled,
    ])
  } finally {
    clearTimeout(timer)
    if (stop) controller.signal.removeEventListener("abort", stop)
    for (const signal of parents) signal.removeEventListener("abort", abort)
  }
}

export * as QueryExecution from "./query-execution"
