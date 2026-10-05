// altimate_change - new file
import fs from "node:fs/promises"
import * as SafeFS from "./safe-fs"
import path from "node:path"
import { DEFAULT_NAME } from "./playbook"
import { paths, writeAtomic } from "./store"
import { assertLearnLock, withLearnLock } from "./lock"

export interface BootstrapState {
  version: 1
  /** Last selected row in the newest-first session traversal. */
  cursor?: { created: number; id: string }
  /** A shared worktree root can be invoked from different session directories. */
  scope?: { projectID: string; directory: string }
  /** Extraction is durable before reflection; interrupted/budget-limited reflections resume here. */
  pendingSessions: string[]
  /** Store emitted signal identities only, never session content. */
  sessions: Record<string, { messageIDs: string[]; partIDs: string[] }>
}

export const bootstrapStateFile = (root: string, name = DEFAULT_NAME) => path.join(paths(root, name).learnDir, "bootstrap.json")

function validate(state: unknown): asserts state is BootstrapState {
  const validIDs = (value: unknown): value is string[] => Array.isArray(value) &&
    value.every((id) => typeof id === "string" && id.length > 0)
  if (!state || typeof state !== "object") throw new Error("Invalid learning bootstrap state")
  const value = state as BootstrapState
  if (value.version !== 1 || !validIDs(value.pendingSessions) ||
    !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions) ||
    Object.entries(value.sessions).some(([id, seen]) => !id || !seen || !validIDs(seen.messageIDs) || !validIDs(seen.partIDs)) ||
    (value.scope !== undefined && (!value.scope || typeof value.scope.projectID !== "string" || !value.scope.projectID ||
      typeof value.scope.directory !== "string" || !value.scope.directory)) ||
    (value.cursor !== undefined && (!value.cursor || !Number.isFinite(value.cursor.created) ||
      value.cursor.created < 0 || typeof value.cursor.id !== "string" || !value.cursor.id)))
    throw new Error("Invalid learning bootstrap state")
}

/** Scope and dry-run inspection must never create, repair or migrate local state. */
export async function readBootstrapState(root: string, name = DEFAULT_NAME): Promise<BootstrapState> {
  let raw: string
  try {
    raw = await fs.readFile(bootstrapStateFile(root, name), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, pendingSessions: [], sessions: {} }
    throw error
  }
  let state: unknown
  try { state = JSON.parse(raw) } catch { throw new Error("Invalid learning bootstrap state") }
  validate(state)
  return state
}

/** Keep updates under the shared learning lock so concurrent bootstrap invocations do not lose IDs. */
export async function updateBootstrapState(
  root: string,
  update: (state: BootstrapState) => void | Promise<void>,
  name = DEFAULT_NAME,
): Promise<BootstrapState> {
  return withLearnLock(root, async () => {
    const state = await readBootstrapState(root, name)
    await update(state)
    validate(state)
    const file = bootstrapStateFile(root, name)
    await assertLearnLock(root)
    await SafeFS.mkdir(root, path.dirname(file))
    await writeAtomic(root, file, JSON.stringify(state, null, 2) + "\n", 0o600)
    return state
  })
}
