// altimate_change - new file
import fs from "node:fs/promises"
import * as SafeFS from "./safe-fs"
import path from "node:path"
import { DEFAULT_NAME } from "./playbook"
import { paths, transaction, writeAtomic } from "./store"
import { redactSecrets } from "./digest"
import { assertLearnLock } from "./lock"
import type { UsageSummary } from "./usage"

export interface RecoveryLimits {
  recovery_max_reflections: number
  recovery_max_seconds: number
}

export const DEFAULT_RECOVERY_LIMITS: Readonly<RecoveryLimits> = {
  recovery_max_reflections: 3,
  recovery_max_seconds: 300,
}

export function resolveRecoveryLimits(config: Partial<RecoveryLimits> = {}, env: NodeJS.ProcessEnv = process.env): RecoveryLimits {
  const limits = { ...DEFAULT_RECOVERY_LIMITS }
  for (const key of Object.keys(limits) as (keyof RecoveryLimits)[]) {
    const variable = `ALTIMATE_LEARN_${key.toUpperCase()}`
    const override = env[variable]?.trim()
    const value = override ? Number(override) : (config[key] ?? limits[key])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`learn.${key} / ${variable} must be a nonnegative safe integer.`)
    limits[key] = value
  }
  return limits
}

export interface ScheduleState {
  lastReflection?: { at: string; sessionID: string; result: "success" | "failure"; summary: string; usage?: UsageSummary }
  recoveries: Record<string, { failures: number; retryAt: number }>
}

export const scheduleStateFile = (root: string, name = DEFAULT_NAME) => path.join(paths(root, name).learnDir, "schedule.json")

/** Reading status or checking backoff on an empty project never creates learning state. */
export async function readScheduleState(root: string, name = DEFAULT_NAME): Promise<ScheduleState> {
  let raw: string
  try {
    raw = await fs.readFile(scheduleStateFile(root, name), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { recoveries: {} }
    throw error
  }
  const state = JSON.parse(raw) as ScheduleState
  if (!state || !state.recoveries || typeof state.recoveries !== "object" || Array.isArray(state.recoveries) ||
    Object.values(state.recoveries).some((entry) => !entry || !Number.isSafeInteger(entry.failures) || entry.failures < 1 ||
      !Number.isFinite(entry.retryAt) || entry.retryAt < 0))
    throw new Error("Invalid learning scheduler state")
  if (state.lastReflection && (typeof state.lastReflection.at !== "string" ||
    typeof state.lastReflection.sessionID !== "string" || typeof state.lastReflection.summary !== "string" ||
    !["success", "failure"].includes(state.lastReflection.result)))
    throw new Error("Invalid last learning reflection")
  if (state.lastReflection?.usage && ["inputTokens", "outputTokens", "estimatedCost"].some((key) => {
    const value = state.lastReflection!.usage![key as keyof UsageSummary]
    return typeof value !== "number" || !Number.isFinite(value) || value < 0
  })) throw new Error("Invalid last learning reflection usage")
  return state
}

/** Backoff survives restarts: one minute, two minutes, ... capped at one day. */
export async function recordReflection(
  root: string,
  sessionID: string,
  result: "success" | "failure",
  summary: string,
  name = DEFAULT_NAME,
  now = Date.now(),
  usage?: UsageSummary,
): Promise<void> {
  await transaction(root, async () => {
    const state = await readScheduleState(root, name)
    state.lastReflection = {
      at: new Date(now).toISOString(), sessionID, result, summary: redactSecrets(summary).slice(0, 2000),
      ...(usage ? { usage } : {}),
    }
    if (result === "success") delete state.recoveries[sessionID]
    else {
      const failures = (Object.hasOwn(state.recoveries, sessionID) ? state.recoveries[sessionID].failures : 0) + 1
      Object.defineProperty(state.recoveries, sessionID, {
        value: { failures, retryAt: now + Math.min(86_400_000, 60_000 * 2 ** Math.min(failures - 1, 11)) },
        enumerable: true, configurable: true, writable: true,
      })
    }
    const file = scheduleStateFile(root, name)
    await assertLearnLock(root)
    await SafeFS.mkdir(root, path.dirname(file))
    await writeAtomic(root, file, JSON.stringify(state, null, 2) + "\n", 0o600)
  })
}
