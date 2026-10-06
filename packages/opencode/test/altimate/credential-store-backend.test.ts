/**
 * The warehouse credential store falls back to an OS store when keytar is not
 * installed (it never is in a released binary). Before that fallback every
 * credential was stripped from the saved connection, so a connection worked in
 * the session that added it and failed after a restart.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as CredentialStore from "../../src/altimate/native/connections/credential-store"
import * as Registry from "../../src/altimate/native/connections/registry"

function memoryBackend(opts: { failSet?: boolean } = {}) {
  const store = new Map<string, string>()
  return {
    store,
    backend: {
      name: "memory",
      async set(account: string, value: string) {
        if (opts.failSet) throw new Error("keychain locked")
        store.set(account, value)
      },
      async get(account: string) {
        return store.get(account) ?? null
      },
      async delete(account: string) {
        return store.delete(account)
      },
    },
  }
}

afterEach(() => CredentialStore.setSecretBackendForTests(undefined))

describe("credential store with an OS backend", () => {
  test("a saved password leaves the file and comes back on the next load", async () => {
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    const { sanitized, warnings } = await CredentialStore.saveConnection("pg", {
      type: "postgres",
      host: "h",
      user: "u",
      password: "s3cret",
    } as any)
    expect(warnings).toEqual([])
    expect(sanitized.password).toBeUndefined()
    expect(store.get("pg/password")).toBe("s3cret")

    // A later process reads the sanitized file and resolves the password back.
    const resolved = await CredentialStore.resolveConfig("pg", sanitized)
    expect(resolved.password).toBe("s3cret")
  })

  test("a store that refuses the write reports it rather than claiming success", async () => {
    const { backend } = memoryBackend({ failSet: true })
    CredentialStore.setSecretBackendForTests(backend)
    const { sanitized, warnings } = await CredentialStore.saveConnection("pg", {
      type: "postgres",
      password: "s3cret",
    } as any)
    expect(sanitized.password).toBeUndefined()
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("will fail after a restart")
    expect(warnings[0]).toContain("ALTIMATE_CODE_CONN_PG")
  })

  test("a read or delete that throws is treated as absent", async () => {
    CredentialStore.setSecretBackendForTests({
      name: "broken",
      set: async () => {},
      get: async () => {
        throw new Error("no libsecret")
      },
      delete: async () => {
        throw new Error("no libsecret")
      },
    })
    expect(await CredentialStore.getCredential("pg", "password")).toBeNull()
    expect(await CredentialStore.deleteCredential("pg", "password")).toBe(false)
  })

  test("the Bun.secrets adapter calls the API in its object form and maps its results", async () => {
    const calls: unknown[] = []
    const values = new Map<string, string>()
    const fake = {
      set: async (o: { service: string; name: string; value: string }) => {
        calls.push(["set", o])
        values.set(o.name, o.value)
      },
      get: async (o: { service: string; name: string }) => {
        calls.push(["get", o])
        return values.get(o.name) ?? null
      },
      delete: async (o: { service: string; name: string }) => {
        calls.push(["delete", o])
        return values.delete(o.name)
      },
    }
    const b = CredentialStore.loadBunSecrets(fake)!
    expect(b.name).toBe("Bun.secrets")
    await b.set("pg/password", "x")
    expect(await b.get("pg/password")).toBe("x")
    expect(await b.get("pg/missing")).toBeNull()
    expect(await b.delete("pg/password")).toBe(true)
    expect(await b.delete("pg/password")).toBe(false)
    expect(calls[0]).toEqual(["set", { service: "altimate-code", name: "pg/password", value: "x" }])
    expect(CredentialStore.loadBunSecrets({})).toBeNull()
  })

  test("with no backend the test preload keeps the real keychain untouched", async () => {
    // The preload sets the disable switch; re-probing must respect it.
    CredentialStore.setSecretBackendForTests(undefined)
    expect(process.env.ALTIMATE_CODE_DISABLE_OS_CREDENTIAL_STORE).toBe("1")
    expect(await CredentialStore.storeCredential("pg", "password", "x")).toBe(false)
  })
})

// Registry.add/remove write `~/.altimate-code/connections.json`; HOME is pointed at a temporary folder so these
// tests never touch the developer's real connections.
describe("saving and removing connections", () => {
  // Global.Path.home follows OPENCODE_TEST_HOME, which the test preload sets; os.homedir() is cached by Bun and
  // ignores a changed HOME, so the registry must not use it.
  let home: string
  const prior = process.env.OPENCODE_TEST_HOME
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cred-home-"))
    process.env.OPENCODE_TEST_HOME = home
  })
  afterEach(() => {
    if (prior === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = prior
    fs.rmSync(home, { recursive: true, force: true })
  })
  const saved = () => path.join(home, ".altimate-code", "connections.json")

  test("writes go to the test home, never the real one", async () => {
    CredentialStore.setSecretBackendForTests(memoryBackend().backend)
    const real = path.join(os.homedir(), ".altimate-code", "connections.json")
    const before = fs.existsSync(real) ? fs.readFileSync(real, "utf8") : null
    expect((await Registry.add("iso_check", { type: "postgres", host: "h", user: "u", password: "p" } as any)).success).toBe(true)
    expect(JSON.parse(fs.readFileSync(saved(), "utf8")).iso_check).toBeDefined()
    expect(fs.existsSync(real) ? fs.readFileSync(real, "utf8") : null).toBe(before)
  })

  test("re-saving under the same name drops secrets the new config no longer has", async () => {
    // Key-pair, then the same name switched to browser sign-in: the old key must not come back, because the
    // driver tries key-pair before any other method.
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    await Registry.add("sf", { type: "snowflake", account: "a", user: "u", private_key: "-----BEGIN PRIVATE KEY-----x" } as any)
    expect(store.has("sf/private_key")).toBe(true)
    await Registry.add("sf", { type: "snowflake", account: "a", user: "u", authenticator: "externalbrowser" } as any)
    expect(store.has("sf/private_key")).toBe(false)
  })

  test("old secrets are only removed once the new config is on disk", async () => {
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    await Registry.add("sf", { type: "snowflake", account: "a", user: "u", private_key: "-----BEGIN PRIVATE KEY-----x" } as any)
    fs.chmodSync(path.dirname(saved()), 0o500)
    fs.chmodSync(saved(), 0o400)
    try {
      const r = await Registry.add("sf", { type: "snowflake", account: "a", user: "u", authenticator: "externalbrowser" } as any)
      expect(r.success).toBe(false)
      // The old config is still the saved one, and still has its key.
      expect(store.has("sf/private_key")).toBe(true)
    } finally {
      fs.chmodSync(path.dirname(saved()), 0o700)
      fs.chmodSync(saved(), 0o600)
    }
  })

  test("a secret that could not be stored keeps its old value; secrets the new config dropped still go", async () => {
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    await Registry.add("pg", { type: "postgres", host: "h", user: "u", password: "old", ssl_key: "k" } as any)
    CredentialStore.setSecretBackendForTests({ ...backend, set: async () => { throw new Error("keychain locked") } })
    const r = await Registry.add("pg", { type: "postgres", host: "h", user: "u", password: "new" } as any)
    expect(r.warnings?.length).toBe(1)
    expect(store.get("pg/password")).toBe("old")
    expect(store.has("pg/ssl_key")).toBe(false)
  })

  test("a secret the store refuses to delete is reported, not silently kept", async () => {
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    await Registry.add("sf", { type: "snowflake", account: "a", user: "u", private_key: "-----BEGIN PRIVATE KEY-----x" } as any)
    CredentialStore.setSecretBackendForTests({ ...backend, delete: async () => false })
    const r = await Registry.add("sf", { type: "snowflake", account: "a", user: "u", authenticator: "externalbrowser" } as any)
    expect(r.warnings?.join("\n")).toContain("Could not remove 'private_key'")
    expect(store.has("sf/private_key")).toBe(true)
    const removed = await Registry.remove("sf")
    expect(removed.warnings?.join("\n")).toContain("Could not remove 'private_key'")
  })

  test("removing a connection removes its secrets from the OS store", async () => {
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    expect((await Registry.add("rm_me", { type: "postgres", host: "h", user: "u", password: "s3cret" } as any)).success).toBe(true)
    expect(store.get("rm_me/password")).toBe("s3cret")
    expect((await Registry.remove("rm_me")).success).toBe(true)
    expect([...store.keys()].filter((k) => k.startsWith("rm_me/"))).toEqual([])
  })

  test("a connection named like an object property is removed with its secrets", async () => {
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    await Registry.add("constructor", { type: "postgres", host: "h", user: "u", password: "s3cret" } as any)
    await Registry.remove("constructor")
    expect(store.has("constructor/password")).toBe(false)
  })

  test("a connection still defined by an env var keeps its secrets when the saved copy is removed", async () => {
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    await Registry.add("envkeep", { type: "postgres", host: "h", user: "u", password: "s3cret" } as any)
    process.env.ALTIMATE_CODE_CONN_ENVKEEP = JSON.stringify({ type: "postgres", host: "h", user: "u" })
    try {
      await Registry.remove("envkeep")
      expect(store.get("envkeep/password")).toBe("s3cret")
    } finally {
      delete process.env.ALTIMATE_CODE_CONN_ENVKEEP
    }
  })

  test("the fallback hint shows how to set a name a shell assignment cannot use", async () => {
    CredentialStore.setSecretBackendForTests(null)
    const { warnings } = await CredentialStore.saveConnection("prod-sf", { type: "snowflake", password: "p" } as any)
    expect(warnings[0]).toContain("env 'ALTIMATE_CODE_CONN_PROD-SF=")
  })
})
