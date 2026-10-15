import path from "path"
import { rm } from "node:fs/promises"
import { createHash } from "crypto"
import { Global } from "../../global"
import { Filesystem } from "../../util/filesystem"
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
 * The result is cached at ``~/.altimate/telemetry-identity.json`` under a fingerprint of the
 * credential, so a process only hits the network when the credential changed. Every failure
 * resolves to ``undefined``: telemetry must never block or break on identity.
 */
export namespace TelemetryIdentity {
  export type Identity = { user_id: string; tenant: string }

  type Cached = Identity & { fingerprint: string }

  const REQUEST_TIMEOUT_MS = 10_000
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  export function cachePath(): string {
    return path.join(Global.Path.home, ".altimate", "telemetry-identity.json")
  }

  function fingerprint(c: { altimateUrl: string; altimateInstanceName: string; altimateApiKey: string }): string {
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

  /** The cached identity, if it belongs to the credential currently on disk. No network. */
  export async function cached(): Promise<Identity | undefined> {
    try {
      if (!(await AltimateApi.isConfigured())) return undefined
      const creds = await AltimateApi.getCredentials()
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
   */
  export async function resolve(opts: { refresh?: boolean } = {}): Promise<Identity | undefined> {
    try {
      if (!(await AltimateApi.isConfigured())) {
        await clear()
        return undefined
      }
      const creds = await AltimateApi.getCredentials()
      const fp = fingerprint(creds)
      if (!opts.refresh) {
        const hit = await readCache()
        if (hit && hit.fingerprint === fp) return { user_id: hit.user_id, tenant: hit.tenant }
      }
      const user = await fetchMe(creds)
      if (!user) return undefined
      const identity: Identity = { user_id: user, tenant: creds.altimateInstanceName }
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

  async function fetchMe(c: { altimateUrl: string; altimateInstanceName: string; altimateApiKey: string }) {
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
      if (!res.ok) return undefined
      const body = (await res.json()) as { uuid?: unknown }
      return typeof body?.uuid === "string" && UUID.test(body.uuid) ? body.uuid.toLowerCase() : undefined
    } finally {
      clearTimeout(timeout)
    }
  }
}
