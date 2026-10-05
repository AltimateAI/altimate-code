// altimate_change - new file
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export interface NudgeState {
  shownProjectHashes: string[]
  totalCount: number
  dismissed: boolean
}

class InvalidNudgeState extends Error {}

const emptyState = (): NudgeState => ({ shownProjectHashes: [], totalCount: 0, dismissed: false })

async function stateFile(stateDir?: string): Promise<string> {
  // Importing this module for an off-mode session must not initialize global directories.
  const directory = stateDir ?? (await import("@/global")).Global.Path.state
  return path.join(directory, "learn-nudge.json")
}

async function readState(file: string): Promise<NudgeState> {
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState()
    throw error
  }
  let value: NudgeState
  try {
    value = JSON.parse(raw)
  } catch {
    throw new InvalidNudgeState("Invalid learning nudge state")
  }
  if (
    !value ||
    !Array.isArray(value.shownProjectHashes) ||
    value.shownProjectHashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) ||
    new Set(value.shownProjectHashes).size !== value.shownProjectHashes.length ||
    !Number.isSafeInteger(value.totalCount) ||
    value.totalCount < value.shownProjectHashes.length ||
    typeof value.dismissed !== "boolean"
  )
    throw new InvalidNudgeState("Invalid learning nudge state")
  // Never copy unknown fields (including message content or raw project paths) back to disk.
  return { shownProjectHashes: value.shownProjectHashes, totalCount: value.totalCount, dismissed: value.dismissed }
}

/** Read-only: missing state is empty; unreadable or corrupt state is never reset implicitly. */
export async function readNudgeState(stateDir?: string): Promise<NudgeState> {
  return readState(await stateFile(stateDir))
}

async function updateState(
  stateDir: string | undefined,
  update: (state: NudgeState) => boolean,
  repair = false,
): Promise<boolean> {
  const file = await stateFile(stateDir)
  const temporary = file + ".tmp"
  await fs.mkdir(path.dirname(file), { recursive: true })
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      handle = await fs.open(temporary, "wx", 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (attempt === 24) throw new Error("Learning nudge state is busy")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (!handle) throw new Error("Learning nudge state is busy")
  let ownsTemporary = true
  try {
    // This sibling is both the exclusive cross-process lock and the atomic staging file.
    // learn-nudge.json (plus this transient staging file) is the only learning write while
    // capture is off. No signal, correction text, session count, or project file is written.
    // An interrupted writer may leave it behind: fail closed rather than steal a live lock.
    const state = await readState(file).catch((error) => {
      if (repair && error instanceof InvalidNudgeState) return emptyState()
      throw error
    })
    if (!update(state)) return false
    await handle.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8")
    await handle.sync()
    await handle.close()
    await fs.rename(temporary, file)
    // Another process may create its own staging file immediately after the rename.
    ownsTemporary = false
    return true
  } finally {
    await handle.close().catch(() => {})
    if (ownsTemporary) await fs.unlink(temporary)
  }
}

/** Reserve the one-time notice before rendering it; any storage failure suppresses it. */
export async function claimNudge(project: string, stateDir?: string): Promise<boolean> {
  try {
    // The TUI supplies its stable project ID for repositories (shared by linked worktrees).
    // Non-git/global projects fall back to a canonical directory identity.
    const canonical = project.startsWith("project:")
      ? project
      : await fs.realpath(project).catch(() => path.resolve(project))
    const hash = createHash("sha256").update(canonical).digest("hex")
    return await updateState(stateDir, (state) => {
      if (state.dismissed || state.totalCount >= 3 || state.shownProjectHashes.includes(hash)) return false
      state.shownProjectHashes.push(hash)
      state.totalCount++
      return true
    })
  } catch {
    return false
  }
}

/** Both `learn enable` and `learn nudge off` permanently silence all future notices. */
export async function dismissNudge(stateDir?: string): Promise<void> {
  await updateState(
    stateDir,
    (state) => {
      state.dismissed = true
      return true
    },
    true,
  )
}
