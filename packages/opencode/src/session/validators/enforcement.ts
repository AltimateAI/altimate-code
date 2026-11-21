import { createHash } from "node:crypto"
import { rm } from "node:fs/promises"
import path from "node:path"
import { Global } from "../../global"
import { Filesystem } from "../../util/filesystem"
import { Log } from "../../util/log"
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
      const blocks = options.strict
        ? result.strictFailure || !result.ok
        : !result.ok && result.classification !== "unverifiable"
      if (blocks) failures.push(check)
      if (!options.strict && (result.advisory || result.classification === "unverifiable")) {
        const note = result.advisory ?? "The validator could not complete this check."
        advisories.push(`[altimate-validator advisory: ${validator.name}] ${note}`)
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

interface AdvisoryState {
  pending: string[]
  shown: string[]
}

const log = Log.create({ service: "validator-advisories" })
// A transient write failure must not replay a delivered note on the next turn.
const unsaved = new Map<SessionID, AdvisoryState>()
const MAX_UNSAVED_SESSIONS = 128

export function advisoryFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function advisoryFile(sessionID: SessionID): string {
  return path.join(Global.Path.state, "validator-advisories", advisoryFingerprint(sessionID) + ".json")
}

// A local file avoids putting advisories in the conversation and share stream.
export async function loadAdvisories(sessionID: SessionID): Promise<AdvisoryState> {
  const recovery = unsaved.get(sessionID)
  if (recovery) {
    saveAdvisories(sessionID, recovery)
    return recovery
  }
  try {
    const value = await Filesystem.readJson<AdvisoryState>(advisoryFile(sessionID))
    if (
      Array.isArray(value?.pending) && value.pending.every((entry) => typeof entry === "string") &&
      Array.isArray(value?.shown) && value.shown.every((entry) => typeof entry === "string")
    ) return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("failed to read validator advisories")
  }
  return { pending: [], shown: [] }
}

export function saveAdvisories(sessionID: SessionID, state: AdvisoryState): void {
  try {
    Filesystem.writeJsonAtomic(advisoryFile(sessionID), state, 0o600)
    unsaved.delete(sessionID)
  } catch (error) {
    unsaved.delete(sessionID)
    unsaved.set(sessionID, state)
    if (unsaved.size > MAX_UNSAVED_SESSIONS) {
      unsaved.delete(unsaved.keys().next().value!)
    }
    log.warn("failed to save validator advisories", { error })
  }
}

export async function removeAdvisories(sessionID: SessionID): Promise<void> {
  unsaved.delete(sessionID)
  await rm(advisoryFile(sessionID), { force: true }).catch(() => log.warn("failed to remove validator advisories"))
}

export * as ValidatorEnforcement from "./enforcement"
