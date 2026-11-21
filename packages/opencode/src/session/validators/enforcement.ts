import { MessageTable } from "@opencode-ai/core/session/sql"
import { Database, sql } from "../../storage/db"
import type { MessageV2 } from "../message-v2"
import type { SessionID } from "../schema"
import type { Validator, ValidatorResult } from "./types"

interface Check {
  validator: Validator
  result: ValidatorResult
}

export function decide(
  checks: Check[],
  options: { enabled: boolean; strict: boolean; retryCount: number; maxRetries: number },
) {
  const failures: Check[] = []
  const advisories: string[] = []
  if (options.enabled) {
    for (const check of checks) {
      const { validator, result } = check
      if (!result.ok && (options.strict || result.classification !== "unverifiable")) failures.push(check)
      if (!options.strict && result.advisory) {
        advisories.push(`[altimate-validator advisory: ${validator.name}] ${result.advisory}`)
      }
    }
  }
  return {
    failures,
    advisories,
    retry: failures.length > 0 && options.retryCount < options.maxRetries,
    exhausted: failures.length > 0 && options.retryCount >= options.maxRetries,
  }
}

// Look up only the advisory record, independent of clean turns and history compaction.
export function latestAdvisoryMessage(sessionID: SessionID): MessageV2.Assistant | undefined {
  const row = Database.use((db) =>
    db.select({ id: MessageTable.id, data: MessageTable.data })
      .from(MessageTable)
      .where(sql`${MessageTable.session_id} = ${sessionID} and json_type(${MessageTable.data}, '$.metadata.validatorAdvisories') = 'array'`)
      .orderBy(sql`${MessageTable.time_created} desc, rowid desc`)
      .limit(1)
      .get(),
  )
  if (row?.data.role === "assistant") return { ...row.data, id: row.id, sessionID } as MessageV2.Assistant
}

export * as ValidatorEnforcement from "./enforcement"
