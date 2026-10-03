// altimate_change - new file
import fs from "node:fs/promises"
import path from "node:path"
import { DEFAULT_NAME } from "./playbook"
import { paths, writeAtomic } from "./store"
import { assertLearnLock, withLearnLock } from "./lock"
import type { ReviewCursor } from "./review-github"

export interface ReviewCheckpoint {
  /** Changing the requested date/filter scope starts traversal at the newest PR again. */
  scope: string
  cursor?: ReviewCursor
  resetAt?: string
  seenIDs: string[]
  pending: { number: number; mergedAt: string; messageIDs: string[] }[]
}

export interface ReviewState {
  version: 1
  repositories: Record<string, ReviewCheckpoint>
}

export const reviewStateFile = (root: string, name = DEFAULT_NAME) => path.join(paths(root, name).learnDir, "reviews.json")

function validate(state: unknown): asserts state is ReviewState {
  const value = state as ReviewState
  if (!value || value.version !== 1 || !value.repositories || typeof value.repositories !== "object" ||
    Array.isArray(value.repositories) || Object.entries(value.repositories).some(([key, entry]) =>
      !key || !entry || typeof entry.scope !== "string" ||
      !Array.isArray(entry.seenIDs) || entry.seenIDs.some((id) => typeof id !== "string" || !id) ||
      !Array.isArray(entry.pending) || entry.pending.some((pr) => !pr || !Number.isSafeInteger(pr.number) || pr.number < 1 || !Number.isFinite(Date.parse(pr.mergedAt)) ||
        !Array.isArray(pr.messageIDs) || pr.messageIDs.some((id) => typeof id !== "string" || !id)) ||
      (entry.resetAt !== undefined && !Number.isFinite(Date.parse(entry.resetAt))) ||
      (entry.cursor !== undefined && (!entry.cursor || !Number.isFinite(entry.cursor.since) ||
        (entry.cursor.after !== undefined && typeof entry.cursor.after !== "string") ||
        (entry.cursor.resetAt !== undefined && !Number.isFinite(Date.parse(entry.cursor.resetAt))) ||
        (entry.cursor.scanned !== undefined && (!Number.isSafeInteger(entry.cursor.scanned) || entry.cursor.scanned < 0)) ||
        (entry.cursor.completed !== undefined && (!entry.cursor.completed || typeof entry.cursor.completed !== "object" ||
          Array.isArray(entry.cursor.completed) || Object.entries(entry.cursor.completed).some(([number, updatedAt]) =>
            !/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number)) || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))))) ||
        (entry.cursor.truncated !== undefined && typeof entry.cursor.truncated !== "boolean") ||
        (entry.cursor.number !== undefined && (!Number.isSafeInteger(entry.cursor.number) || entry.cursor.number < 1))))))
    throw new Error("Invalid learning review checkpoint; restore reviews.json before importing reviews.")
}

/** Preview and cancellation must not create or repair learning state. */
export async function readReviewState(root: string, name = DEFAULT_NAME): Promise<ReviewState> {
  const raw = await fs.readFile(reviewStateFile(root, name), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (raw === undefined) return { version: 1, repositories: {} }
  let state: unknown
  try { state = JSON.parse(raw) } catch { throw new Error("Invalid learning review checkpoint JSON.") }
  validate(state)
  return state
}

export async function updateReviewState(root: string, update: (state: ReviewState) => void | Promise<void>, name = DEFAULT_NAME) {
  return withLearnLock(root, async () => {
    const state = await readReviewState(root, name)
    await update(state)
    validate(state)
    const file = reviewStateFile(root, name)
    await assertLearnLock(root)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeAtomic(root, file, JSON.stringify(state, null, 2) + "\n", 0o600)
    return state
  })
}
