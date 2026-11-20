// altimate_change - new file
/**
 * What the Databricks and Snowflake savings checks share: one time limit for the whole check, connecting
 * included, the session's stop, and how a query that runs past either is reported.
 */

import type { Connector } from "@altimateai/drivers/types"
import { isQueryTimeoutError } from "@altimateai/drivers/types"
import { untilStopped } from "@altimateai/drivers/stop"
import type { QueryContext } from "../query-execution"
import { RunBudget } from "../../run-budget"

// Claude Code runs a plugin's process for ten minutes at most: the check stops before that, so a query
// still running is cancelled on the warehouse here and not left behind when the process is killed.
export const SAVINGS_RUN_LIMIT_MS = 9 * 60_000

/** The limit as the tools and their messages state it. */
export const SAVINGS_RUN_LIMIT_MINUTES = SAVINGS_RUN_LIMIT_MS / 60_000

/** Work the check's time limit stopped, or never started. */
export class SavingsLimitError extends Error {}

/**
 * One check's run: it stops at its own limit, or earlier at the session's query cutoff (`altimate run
 * --time-budget`). Stopping the session cancels the running query and starts no other.
 */
export function savingsRun(context?: QueryContext) {
  const signal = context?.signal
  const ownLimitAt = Date.now() + SAVINGS_RUN_LIMIT_MS
  const sessionCutoff = context?.sessionID ? RunBudget.queryDeadline(context.sessionID) : undefined
  const stopsAt = Math.min(ownLimitAt, sessionCutoff ?? Infinity)
  const limitName = stopsAt < ownLimitAt ? "the run's time budget" : `the check's ${SAVINGS_RUN_LIMIT_MINUTES}-minute limit`

  /**
   * Starts `start` only while the session runs and time is left, then waits on it until either ends.
   * Connecting can wait on the network, a stopped warehouse or a sign-in, so it counts toward the limit.
   */
  async function beforeStop<T>(start: () => Promise<T>, what: string): Promise<T> {
    signal?.throwIfAborted()
    const left = stopsAt - Date.now()
    if (left <= 0) throw new SavingsLimitError(`${what} was not started: ${limitName} had already passed.`)
    const outcome = await untilStopped(start(), { deadlineMs: left, signal })
    if (outcome.stopped === "aborted") throw signal!.reason
    if (outcome.stopped) throw new SavingsLimitError(`${what} took longer than ${limitName}.`)
    return outcome.value
  }

  /** One query with what is left of the limit; the driver cancels it on the warehouse past that, or on a stop. */
  async function query(connector: Connector, what: string, sql: string, rowLimit: number, binds: unknown[]) {
    signal?.throwIfAborted()
    const left = stopsAt - Date.now()
    if (left <= 0) throw new SavingsLimitError(`The ${what} query was not started: it would run past ${limitName}.`)
    try {
      return await connector.execute(sql, rowLimit, binds, { cancelAfterMs: left, signal })
    } catch (e) {
      if (!isQueryTimeoutError(e)) throw e
      const { cancelled, unsent } = e as { cancelled?: boolean; unsent?: boolean }
      const outcome = unsent
        ? "before it was sent, so it did not run on the warehouse"
        : cancelled
          ? "and was cancelled on the warehouse"
          : "and may still be running on the warehouse"
      throw new SavingsLimitError(`The ${what} query ran past ${limitName} ${outcome}.`)
    }
  }

  return { signal, limitName, beforeStop, query }
}

/** The first line of an error, short enough for a `skipped` entry. */
export function reasonOf(e: unknown, length = 300): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, length)
}
