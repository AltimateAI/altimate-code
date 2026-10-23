// Shared, model-free workspace operations for external coding clients.
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { WorkspaceApi } from "./api-client"
import { accountDigest, resolveBindingOutcome } from "./state"
import { workspaceContents, render } from "./contents"
import * as SkillSync from "./skill-sync"
import * as MemorySync from "./memory-sync"
import { MemoryStore } from "@/memory/store"
import { MemoryBlockSchema, MEMORY_MAX_BLOCK_SIZE } from "@/memory/types"
import { AltimateApi } from "@/altimate/api/client"
import { withCredentials } from "@/altimate/api/credentials-context"

export class WorkspaceSetupError extends Error {
  constructor(
    public readonly status: "needs_auth" | "needs_workspace" | "disabled" | "unavailable",
    message: string,
  ) {
    super(message)
  }
}

async function credentials() {
  try {
    return await AltimateApi.getCredentials()
  } catch {
    throw new WorkspaceSetupError("needs_auth", "Sign in to Altimate to use workspace data.")
  }
}

/** Machine-readable first-use state; never return credential errors or secrets to a client. */
export async function setup(directory: string) {
  try {
    return { status: "ready" as const, ...(await context(directory)) }
  } catch (error) {
    const status = error instanceof WorkspaceSetupError ? error.status : "unavailable"
    const workspaces = status === "needs_workspace" ? await listWorkspaces().catch(() => []) : []
    return {
      status,
      workspaces,
      message:
        status === "needs_auth"
          ? "Sign in to Altimate to continue this workspace task."
          : status === "needs_workspace"
            ? "Choose the workspace for this project. Local data tools remain available."
            : status === "disabled"
              ? "Workspace access is disabled in Altimate settings."
              : "Workspace access could not be confirmed. Check your connection or sign in again.",
    }
  }
}

export async function identity(directory: string) {
  return withCredentials(await credentials(), () => scopedIdentity(directory))
}

async function scopedIdentity(directory: string) {
  if (!SkillSync.isEnabled()) throw new WorkspaceSetupError("disabled", "Workspaces are disabled on this machine.")
  const account = await accountDigest()
  if (!account) throw new WorkspaceSetupError("needs_auth", "Sign in to Altimate first.")
  const outcome = await resolveBindingOutcome(directory)
  if (outcome.status !== "bound" || outcome.stale) {
    throw new WorkspaceSetupError(
      outcome.status === "unbound" ? "needs_workspace" : "unavailable",
      outcome.status === "unbound"
        ? "This project is not linked. Choose a workspace to continue."
        : "The workspace could not be confirmed. Check your connection and try again.",
    )
  }
  if ((await accountDigest()) !== account) throw new Error("Altimate account changed. Reconnect MCP.")
  const binding = outcome.binding
  // A receipt, never credentials. Also binds an explicit save to this project.
  const token = createHash("sha256")
    .update(JSON.stringify([account, binding.datamateId, path.resolve(directory)]))
    .digest("hex")
  return { binding, token }
}

export async function assertIdentity(directory: string, token: string) {
  const current = await identity(directory)
  if (current.token !== token)
    throw new Error("Altimate account or workspace changed. Read workspace_context again before continuing.")
  return current
}

export async function listWorkspaces() {
  if (!SkillSync.isEnabled()) throw new WorkspaceSetupError("disabled", "Workspaces are disabled on this machine.")
  const result = await withCredentials(await credentials(), async () => {
    const account = await accountDigest()
    const credentials = await WorkspaceApi.captureCredentials()
    if (!account || !credentials) throw new Error("Sign in to Altimate first.")
    const workspaces = await WorkspaceApi.listDatamates(credentials)
    return { account, workspaces }
  })
  if ((await accountDigest()) !== result.account) throw new Error("Altimate account changed. Try again.")
  return result.workspaces.map(({ id, name }) => ({ id, name })).slice(0, 100)
}

export async function context(directory: string) {
  const result = await withCredentials(await credentials(), () => scopedContext(directory))
  await assertIdentity(directory, result.workspace.token)
  return result
}

async function scopedContext(directory: string) {
  const { binding, token } = await identity(directory)
  {
    const [contents, memory] = await Promise.all([
      workspaceContents(directory, binding.datamateId, { skills: 1000, summary: 3000 }),
      MemorySync.readOnly(directory),
    ])
    const blocks = memory.blocks.filter((block) => block.scope === "project")
    let remaining = 6000
    const memories = []
    for (const block of blocks) {
      const content = block.content.slice(0, Math.min(2048, remaining))
      if (!content) break
      memories.push({ id: block.id.slice(0, 256), content, origin: block.origin?.slice(0, 120) })
      remaining -= content.length
      if (memories.length === 10) break
    }
    let skills: string[] = []
    if ((await SkillSync.snapshotWorkspaceId(directory)) === binding.datamateId) {
      skills = (await fs.readdir(SkillSync.snapshotRoot(directory))).filter(validSkillName).slice(0, 40)
    }
    await assertIdentity(directory, token)
    return {
      workspace: { id: binding.datamateId, name: binding.datamateName.slice(0, 160), token },
      summary: render(contents),
      skills,
      memory: { status: memory.status, memories, clipped: blocks.length > memories.length || remaining === 0 },
    }
  }
}

function validSkillName(name: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)
}

/** Do not expose a stale account's snapshot, symlinks, or arbitrary local files. */
export async function readSkill(directory: string, name: string, token: string) {
  const content = await withCredentials(await credentials(), () => scopedReadSkill(directory, name, token))
  await assertIdentity(directory, token)
  return content
}

async function scopedReadSkill(directory: string, name: string, token: string) {
  const { binding } = await assertIdentity(directory, token)
  if (!validSkillName(name)) throw new Error("Use a skill name returned by workspace_context.")
  if ((await SkillSync.snapshotWorkspaceId(directory)) !== binding.datamateId) {
    throw new Error("Workspace skills are not current. Run altimate-code workspace refresh, then try again.")
  }
  const root = SkillSync.snapshotRoot(directory)
  const before = await fs.lstat(root)
  const folder = path.join(root, name)
  const file = path.join(folder, "SKILL.md")
  for (const target of [root, folder, file]) {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Workspace skill symlinks are not supported.")
  }
  const actualRoot = await fs.realpath(root)
  const actualFile = await fs.realpath(file)
  if (!actualFile.startsWith(actualRoot + path.sep)) throw new Error("Skill is outside the workspace snapshot.")
  const handle = await fs.open(file, "r")
  let content: string
  try {
    if ((await handle.stat()).size > 32_000)
      throw new Error("Skill is too large for this client; open it in Altimate Code.")
    content = await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
  if (
    (await fs.lstat(root)).ino !== before.ino ||
    (await SkillSync.snapshotWorkspaceId(directory)) !== binding.datamateId
  ) {
    throw new Error("Workspace skills changed while reading. Try again.")
  }
  await assertIdentity(directory, token)
  return content
}

/** User-invoked CLI action only; never automatically called from a model tool. */
export async function remember(directory: string, token: string, id: string, content: string) {
  return withCredentials(await credentials(), () => scopedRemember(directory, token, id, content))
}

async function scopedRemember(directory: string, token: string, id: string, content: string) {
  const { binding } = await assertIdentity(directory, token)
  if (!content.trim() || content.length > MEMORY_MAX_BLOCK_SIZE) {
    throw new Error(`Memory must contain 1–${MEMORY_MAX_BLOCK_SIZE} characters.`)
  }
  const now = new Date().toISOString()
  MemoryBlockSchema.shape.id.parse(id)
  const existing = await MemoryStore.read("project", id)
  const block = MemoryBlockSchema.parse({
    id,
    scope: "project",
    content,
    tags: existing?.tags ?? [],
    created: existing?.created ?? now,
    updated: now,
  })
  if ((await MemorySync.memoryEnabledForPoller(binding)) !== "enabled" || !MemorySync.isEnabled()) {
    throw new Error("Workspace memory is disabled or could not be confirmed; nothing was saved.")
  }
  await assertIdentity(directory, token)
  // Suppress the default fire-and-forget mirror: it resolves its own binding,
  // whereas this command must send only to the workspace the user just saw.
  await MemoryStore.write(block, { mirror: false, cleanup: false })
  try {
    await assertIdentity(directory, token)
    const sync = await MemorySync.backfill([block], binding, directory)
    await assertIdentity(directory, token)
    const cloudConfirmed =
      !sync.gated && sync.failed === 0 && sync.declined === 0 && sync.deferred === 0 && sync.ok === 1
    return {
      savedLocally: true,
      cloudConfirmed,
      id,
      workspaceId: binding.datamateId,
      message: cloudConfirmed
        ? "Saved in this project and published to the workspace."
        : "Saved locally; workspace publication is not confirmed. Check altimate-code workspace status.",
    }
  } catch {
    return {
      savedLocally: true,
      cloudConfirmed: false,
      id,
      workspaceId: binding.datamateId,
      message:
        "Saved locally; workspace publication could not be confirmed. Check the account and workspace before syncing.",
    }
  }
}
