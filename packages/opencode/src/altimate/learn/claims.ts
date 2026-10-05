// altimate_change - new file
// A short learn transaction claims feedback; the lease remains while model calls run outside it.
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import * as SafeFS from "./safe-fs"
import os from "node:os"
import path from "node:path"
import { assertLearnLock, withLearnLock } from "./lock"
import { listSignals } from "./signals"
import { writeAtomic } from "./store"

export const CLAIM_TTL_MS = 5 * 60_000

interface Claim {
  batchID: string
  name: string
  signalIDs: string[]
  pid: number
  host: string
  token: string
  expires: number
}

export function batchID(name: string, signalIDs: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([name, [...new Set(signalIDs)].sort()])).digest("hex")
}

export const claimsDirectory = (root: string) => path.join(root, ".altimate-code", "learn", "claims")

async function readClaim(file: string): Promise<Claim | undefined> {
  const text = await fs.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return
  const claim = JSON.parse(text)
  if (typeof claim.batchID !== "string" || typeof claim.name !== "string" ||
    !Array.isArray(claim.signalIDs) || claim.signalIDs.some((id: unknown) => typeof id !== "string") ||
    !Number.isSafeInteger(claim.pid) || claim.pid < 1 || typeof claim.host !== "string" ||
    typeof claim.token !== "string" || !Number.isFinite(claim.expires))
    throw new Error("Invalid learning reflection claim; refusing an unprotected model call.")
  return claim
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

export interface ClaimLease {
  batchID: string
  /** Checks and renews ownership, including when called inside the final store transaction. */
  assert(): Promise<void>
  release(): Promise<void>
}

/** Each manager represents one process; injected identity/clock make lease races testable. */
export function createClaimManager(options: {
  pid?: number
  host?: string
  now?: () => number
  isAlive?: (pid: number) => boolean
  ttlMs?: number
} = {}) {
  const pid = options.pid ?? process.pid
  const host = options.host ?? os.hostname()
  const now = options.now ?? Date.now
  const alive = options.isAlive ?? isAlive
  const ttl = options.ttlMs ?? CLAIM_TTL_MS
  const active = new Set<string>()

  return {
    async acquire(root: string, name: string, signalIDs: readonly string[]): Promise<ClaimLease | undefined> {
      const key = await fs.realpath(root)
      if (active.has(key) || signalIDs.length === 0) return
      active.add(key)
      let leased = false
      try {
        const ids = [...new Set(signalIDs)].sort()
        const id = batchID(name, ids)
        const directory = claimsDirectory(key)
        const file = path.join(directory, `${id}.json`)
        const claim = await withLearnLock(key, async () => {
          // A contender may have read signals before another process committed its reflection.
          const open = new Set((await listSignals(key, {}, name)).map((signal) => signal.id))
          if (ids.some((signalID) => !open.has(signalID))) return
          const files = await fs.readdir(directory).catch((error) => {
            if (error.code === "ENOENT") return [] as string[]
            throw error
          })
          for (const entry of files.filter((entry) => entry.endsWith(".json"))) {
            const existingFile = path.join(directory, entry)
            const existing = await readClaim(existingFile)
            if (!existing) continue
            if (existing.expires <= now() || (existing.host === host && !alive(existing.pid))) {
              await assertLearnLock(key)
              await SafeFS.remove(key, existingFile)
              continue
            }
            // New signals can change the hash while the earlier batch is still running.
            if (existing.name === name && existing.signalIDs.some((signalID) => ids.includes(signalID))) return
          }
          const claim: Claim = { batchID: id, name, signalIDs: ids, pid, host, token: randomUUID(), expires: now() + ttl }
          await assertLearnLock(key)
          await SafeFS.mkdir(key, directory)
          await writeAtomic(key, file, JSON.stringify(claim), 0o600)
          return claim
        })
        if (!claim) return
        leased = true
        let released = false
        let lost: unknown
        let heartbeat: Promise<void> | undefined
        const check = () => withLearnLock(key, async () => {
          if (released || lost) throw lost ?? new Error("Learning reflection claim released.")
          const current = await readClaim(file)
          if (current?.token !== claim.token || current.expires <= now())
            throw new Error("Learning reflection claim expired or was replaced; signals remain open.")
          current.expires = now() + ttl
          await writeAtomic(key, file, JSON.stringify(current), 0o600)
        })
        const timer = setInterval(() => {
          if (heartbeat || released || lost) return
          heartbeat = check().catch((error) => { lost = error }).finally(() => { heartbeat = undefined })
        }, Math.max(1, Math.floor(ttl / 3)))
        timer.unref()
        return {
          batchID: id,
          assert: check,
          async release() {
            if (released) return
            clearInterval(timer)
            released = true
            try {
              await heartbeat
              await withLearnLock(key, async () => {
                if ((await readClaim(file))?.token !== claim.token) return
                await assertLearnLock(key)
                await SafeFS.remove(key, file)
              })
            } finally {
              active.delete(key)
            }
          },
        }
      } finally {
        if (!leased) active.delete(key)
      }
    },
  }
}

export const processClaims = createClaimManager()
