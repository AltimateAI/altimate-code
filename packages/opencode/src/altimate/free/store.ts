import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../global"

export interface Record {
  version: 1
  installSecret: string
  logoutNonce?: string
  apiKey?: string
  baseURL?: string
  expiresAt?: string
  rejected?: boolean
}

export class InvalidCredentialStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "AltimateBaseInvalidCredentialStoreError"
  }
}

export function credentialPath(): string {
  return path.join(Global.Path.data, "altimate-base.json")
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function parse(value: unknown): Record {
  if (!value || typeof value !== "object") throw new InvalidCredentialStoreError("Altimate Base credentials are invalid.")
  const input = value as { [key: string]: unknown }
  if (input.version !== 1 || typeof input.installSecret !== "string" || !input.installSecret) {
    throw new InvalidCredentialStoreError("Altimate Base credentials are invalid.")
  }
  for (const field of ["logoutNonce", "apiKey", "baseURL", "expiresAt"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      throw new InvalidCredentialStoreError("Altimate Base credentials are invalid.")
    }
  }
  if (input.rejected !== undefined && typeof input.rejected !== "boolean") {
    throw new InvalidCredentialStoreError("Altimate Base credentials are invalid.")
  }
  const apiKey = typeof input.apiKey === "string" ? input.apiKey : undefined
  const baseURL = typeof input.baseURL === "string" ? input.baseURL : undefined
  const expiresAt = typeof input.expiresAt === "string" ? input.expiresAt : undefined
  const logoutNonce = typeof input.logoutNonce === "string" ? input.logoutNonce : undefined
  return {
    version: 1,
    installSecret: input.installSecret,
    ...(logoutNonce ? { logoutNonce } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(input.rejected === true ? { rejected: true } : {}),
  }
}

export async function read(): Promise<Record | undefined> {
  let contents: string
  try {
    contents = await fs.readFile(credentialPath(), "utf8")
  } catch (error) {
    if (isEnoent(error)) return undefined
    throw error
  }
  try {
    return parse(JSON.parse(contents))
  } catch (error) {
    if (error instanceof InvalidCredentialStoreError) throw error
    throw new InvalidCredentialStoreError("Altimate Base credentials are invalid.", { cause: error })
  }
}

/**
 * Replace the credential record atomically. The temporary file is created with 0600 before any
 * secret bytes are written, then synced and renamed in the same directory.
 */
export async function write(record: Record): Promise<void> {
  const target = credentialPath()
  const directory = path.dirname(target)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  let handle: fs.FileHandle | undefined
  let ownsTemporary = false
  try {
    handle = await fs.open(temporary, "wx", 0o600)
    ownsTemporary = true
    await handle.writeFile(JSON.stringify(parse(record), null, 2) + "\n", "utf8")
    await handle.sync()
    await handle.chmod(0o600)
    await handle.close()
    handle = undefined
    await fs.rename(temporary, target)
    await fs.chmod(target, 0o600)

    // Persist the rename when the platform supports syncing a directory. Some Windows filesystems
    // reject opening directories; the file itself is already synced in that case.
    const parent = await fs.open(directory, "r").catch(() => undefined)
    if (parent) {
      await parent.sync().catch(() => {})
      await parent.close().catch(() => {})
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    if (ownsTemporary) await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function remove(): Promise<void> {
  await fs.rm(credentialPath(), { force: true })
}

export * as FreeTierStore from "./store"
