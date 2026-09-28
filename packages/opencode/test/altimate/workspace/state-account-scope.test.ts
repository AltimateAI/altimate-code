// altimate_change - new file
//
// The binding cache is a local answer to "which workspace is this project
// bound to?", and that answer belongs to an account, not a tenant. Two people
// on one tenant share a machine and a checkout more often than two tenants do
// — a shared analytics box, a service account, or `/connect` with a
// colleague's key while pairing — and the workspace the cache names may be
// private to whoever wrote it.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const SANDBOX = path.join(os.tmpdir(), `altimate-state-account-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

const { recordApprovedBinding, readLocalBinding, clearLocalBinding, cachePath, credentialDigest } =
  await import("../../../src/altimate/workspace/state")
const { AltimateApi } = await import("../../../src/altimate/api/client")

const ROOT = path.join(SANDBOX, "project")
mkdirSync(ROOT, { recursive: true })

const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>

const TENANT = "acme"
const API_URL = "https://api.test"

/** Same tenant and host throughout — only the key changes, which is the case
 * a tenant-scoped cache cannot tell apart. */
function asAccount(apiKey: string) {
  ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
  ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
    ({ altimateInstanceName: TENANT, altimateUrl: API_URL, altimateApiKey: apiKey }) as Creds
}

const binding = (datamateId: number, datamateName: string) => ({
  datamateId,
  datamateName,
  repoRemote: "git@example.com:acme/app.git",
  projectPath: null,
  linkedAt: Date.now(),
})

beforeEach(() => {
  rmSync(cachePath(), { force: true })
})

afterEach(() => {
  ;(AltimateApi as unknown as { isConfigured: unknown }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: unknown }).getCredentials = originalGetCreds
})

afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe("binding cache is scoped to the account, not the tenant", () => {
  test("a second user on the same tenant does not inherit the first user's workspace", async () => {
    // The reported bug: A links this project to their private workspace, the
    // credentials are switched to B on the same tenant, and B's session read
    // A's cached binding — and loaded A's private workspace's skills — without
    // any visibility check of its own.
    asAccount("key-A")
    await recordApprovedBinding(ROOT, binding(7, "A's private workspace"), { seed: false })
    expect((await readLocalBinding(ROOT))?.datamateId).toBe(7)

    asAccount("key-B")

    expect(await readLocalBinding(ROOT)).toBeNull()
  })

  test("the first user still reads their own binding after the switch back", async () => {
    // Guards the one above: rejecting every read would satisfy it while making
    // the cache useless.
    asAccount("key-A")
    await recordApprovedBinding(ROOT, binding(7, "A's private workspace"), { seed: false })
    asAccount("key-B")
    expect(await readLocalBinding(ROOT)).toBeNull()

    asAccount("key-A")
    expect((await readLocalBinding(ROOT))?.datamateId).toBe(7)
  })

  test("each account keeps its own binding for the same project", async () => {
    asAccount("key-A")
    await recordApprovedBinding(ROOT, binding(7, "A's workspace"), { seed: false })
    asAccount("key-B")
    await recordApprovedBinding(ROOT, binding(9, "B's workspace"), { seed: false })

    expect((await readLocalBinding(ROOT))?.datamateId).toBe(9)
    asAccount("key-A")
    // B's write replaces the file, so A re-validates rather than reading B's
    // row. What must never happen is A being handed 9.
    expect((await readLocalBinding(ROOT))?.datamateId ?? null).not.toBe(9)
  })

  test("the version bump alone rejects an older file, not just the missing account", async () => {
    // A v1 file has no account, so the account comparison would reject it
    // anyway. This pins the version check itself: the format changed, and a
    // file claiming the old one is not read even if it carries a field that
    // happens to match.
    asAccount("key-A")
    writeFileSync(
      cachePath(),
      JSON.stringify({
        version: 1,
        tenant: TENANT,
        apiUrl: API_URL,
        account: credentialDigest(API_URL, TENANT, "key-A"),
        bindings: { [ROOT]: binding(7, "v1 with an account") },
      }),
    )

    expect(await readLocalBinding(ROOT)).toBeNull()
  })

  test("one user's unlink does not delete the other's binding", async () => {
    // Raised in review. The unlink path compared only tenant and host, so on a
    // shared tenant it treated the other user's file as its own and dropped
    // their row — the cache is per credential now, so it is not theirs to
    // touch.
    asAccount("key-B")
    await recordApprovedBinding(ROOT, binding(9, "B's workspace"), { seed: false })
    expect((await readLocalBinding(ROOT))?.datamateId).toBe(9)

    asAccount("key-A")
    await clearLocalBinding(ROOT)

    asAccount("key-B")
    expect((await readLocalBinding(ROOT))?.datamateId).toBe(9)
  })

  test("a cache file from before accounts were recorded is discarded", async () => {
    // v1 has no account, so it cannot be attributed to anyone. The cache is an
    // offline fallback, so the cost is one re-validation — and an entry nobody
    // can be shown to own is exactly what must not be trusted.
    asAccount("key-A")
    writeFileSync(
      cachePath(),
      JSON.stringify({
        version: 1,
        tenant: TENANT,
        apiUrl: API_URL,
        bindings: { [ROOT]: binding(7, "from an older client") },
      }),
    )

    expect(await readLocalBinding(ROOT)).toBeNull()
  })

  test("the digest identifies the whole credential, not just the key", async () => {
    // Host and tenant are part of it, so the same key issued against another
    // host is a different account.
    const a = credentialDigest(API_URL, TENANT, "key-A")
    expect(credentialDigest(API_URL, TENANT, "key-B")).not.toBe(a)
    expect(credentialDigest("https://other.test", TENANT, "key-A")).not.toBe(a)
    expect(credentialDigest(API_URL, "other-tenant", "key-A")).not.toBe(a)
    expect(a).not.toContain("key-A")
  })
})
