import fs from "fs"
import path from "path"
import { rm } from "node:fs/promises"
import { createHash } from "crypto"
import { Global } from "../../global"
import { Filesystem } from "../../util/filesystem"
import { Auth } from "../../auth"
import { AltimateApi } from "@/altimate/api/client"
import { Log } from "@/altimate/util/log"

const log = Log.create({ service: "telemetry-identity" })

/**
 * Who this machine is signed in as, for telemetry.
 *
 * Web events in PostHog are keyed by the backend user uuid; CLI events were keyed by the
 * machine only, so nothing joined a CLI session to the account that created or linked the
 * workspace it uses. This resolves the backend user once per credential (``GET /users/me``,
 * the same call the workspace client makes) and hands telemetry a ``user_id`` and ``tenant``
 * to stamp on every event. No email, hashed or not, leaves the client.
 *
 * The credential is the one the Altimate provider uses: ``~/.altimate/altimate.json`` first,
 * else the ``altimate-backend`` entry of the auth store (a key entered in the TUI). The result
 * is cached at ``~/.altimate/telemetry-identity.json`` under a fingerprint of the credential, so
 * a process only hits the network when the credential changed. Every failure resolves to
 * ``undefined``: telemetry must never block or break on identity.
 */
export type Identity = { user_id: string; tenant: string }

type Credential = { altimateUrl: string; altimateInstanceName: string; altimateApiKey: string }
type Cached = Identity & { fingerprint: string }

const REQUEST_TIMEOUT_MS = 10_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AUTH_STORE_KEY = "altimate-backend"

export function cachePath(): string {
  return path.join(Global.Path.home, ".altimate", "telemetry-identity.json")
}

/** True when a credential is in use (file or auth store), whatever its validity. */
export async function hasCredential(): Promise<boolean> {
  return (await loadCredential()) !== undefined
}

/** The credential the Altimate provider would use, or undefined when signed out. */
export async function loadCredential(): Promise<Credential | undefined> {
  try {
    if (await AltimateApi.isConfigured()) {
      const c = await AltimateApi.getCredentials()
      return {
        altimateUrl: c.altimateUrl,
        altimateInstanceName: c.altimateInstanceName,
        altimateApiKey: c.altimateApiKey,
      }
    }
    const auth = await Auth.get(AUTH_STORE_KEY)
    if (auth?.type === "api") {
      const parsed = AltimateApi.parseAltimateKey(auth.key)
      // Same normalisation as getCredentials(): a trailing slash would yield "//users/me".
      return parsed ? { ...parsed, altimateUrl: parsed.altimateUrl.replace(/\/+$/, "") } : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * A cheap stamp of the two credential files (mtime and size), so a flush can notice that a
 * sign-in, sign-out or key change happened on disk, in this thread or another, without
 * reading or parsing anything.
 */
export function credentialStamp(): string {
  const stamp = (p: string) => {
    try {
      const s = fs.statSync(p)
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return "absent"
    }
  }
  return `${stamp(AltimateApi.credentialsPath())}|${stamp(Auth.filepath())}`
}

function fingerprint(c: Credential): string {
  return createHash("sha256")
    .update(`${c.altimateUrl}\n${c.altimateInstanceName}\n${c.altimateApiKey}`)
    .digest("hex")
    .slice(0, 16)
}

async function readCache(): Promise<Cached | undefined> {
  try {
    const p = cachePath()
    if (!(await Filesystem.exists(p))) return undefined
    const raw = JSON.parse(await Filesystem.readText(p)) as Partial<Cached>
    if (typeof raw.fingerprint !== "string" || typeof raw.user_id !== "string" || typeof raw.tenant !== "string")
      return undefined
    if (!UUID.test(raw.user_id)) return undefined
    return { fingerprint: raw.fingerprint, user_id: raw.user_id, tenant: raw.tenant }
  } catch {
    return undefined
  }
}

/** The cached identity, if it belongs to the credential currently in use. No network. */
export async function cached(): Promise<Identity | undefined> {
  try {
    const creds = await loadCredential()
    if (!creds) return undefined
    const hit = await readCache()
    if (!hit || hit.fingerprint !== fingerprint(creds)) return undefined
    return { user_id: hit.user_id, tenant: hit.tenant }
  } catch {
    return undefined
  }
}

/**
 * Resolve the signed-in user. Uses the cache when the credential has not changed; otherwise
 * asks the backend and caches the answer. ``refresh`` forces the request (after a sign-in).
 * A backend rejection (401 or 403) drops the cache for that credential; a transient failure
 * keeps it. The answer is written and returned only if the same credential is still in use.
 */
export async function resolve(opts: { refresh?: boolean } = {}): Promise<Identity | undefined> {
  try {
    const creds = await loadCredential()
    if (!creds) {
      await clear()
      return undefined
    }
    const fp = fingerprint(creds)
    if (!opts.refresh) {
      const hit = await readCache()
      if (hit && hit.fingerprint === fp) return { user_id: hit.user_id, tenant: hit.tenant }
    }
    const answer = await fetchMe(creds)
    if (answer.kind === "rejected") {
      const hit = await readCache()
      if (hit && hit.fingerprint === fp) await clear()
      return undefined
    }
    if (answer.kind !== "ok") return undefined
    const now = await loadCredential()
    if (!now || fingerprint(now) !== fp) return undefined
    const identity: Identity = { user_id: answer.uuid, tenant: creds.altimateInstanceName }
    try {
      await Filesystem.writeJson(cachePath(), { ...identity, fingerprint: fp } satisfies Cached, 0o600)
    } catch (err) {
      log.warn("telemetry identity cache not written", { err: String(err) })
    }
    return identity
  } catch (err) {
    log.warn("telemetry identity unresolved", { err: String(err) })
    return undefined
  }
}

/** Forget the cached identity (sign-out). */
export async function clear(): Promise<void> {
  try {
    await rm(cachePath(), { force: true })
  } catch {
    // nothing to forget
  }
}

type Answer = { kind: "ok"; uuid: string } | { kind: "rejected" } | { kind: "error" }

async function fetchMe(c: Credential): Promise<Answer> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${c.altimateUrl}/users/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${c.altimateApiKey}`,
        "x-tenant": c.altimateInstanceName,
        ...AltimateApi.clientHeaders(),
      },
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) return { kind: "rejected" }
    if (!res.ok) return { kind: "error" }
    const body = (await res.json()) as { uuid?: unknown }
    return typeof body?.uuid === "string" && UUID.test(body.uuid)
      ? { kind: "ok", uuid: body.uuid.toLowerCase() }
      : { kind: "error" }
  } catch {
    return { kind: "error" }
  } finally {
    clearTimeout(timeout)
  }
}

export * as TelemetryIdentity from "./identity"
