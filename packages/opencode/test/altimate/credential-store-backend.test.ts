/**
 * The warehouse credential store falls back to an OS store when keytar is not
 * installed (it never is in a released binary). Before that fallback every
 * credential was stripped from the saved connection, so a connection worked in
 * the session that added it and failed after a restart.
 */
import { afterEach, describe, expect, test } from "bun:test"
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

  test("re-saving a connection under the same name drops secrets the new config no longer has", async () => {
    // Key-pair first, then the same name switched to browser sign-in: the old key must not come back,
    // because the driver tries key-pair before any other method.
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    await CredentialStore.saveConnection("sf", { type: "snowflake", account: "a", user: "u", private_key: "-----BEGIN PRIVATE KEY-----x" } as any)
    expect(store.has("sf/private_key")).toBe(true)

    const { sanitized } = await CredentialStore.saveConnection("sf", { type: "snowflake", account: "a", user: "u", authenticator: "externalbrowser" } as any)
    expect(store.has("sf/private_key")).toBe(false)
    expect((await CredentialStore.resolveConfig("sf", sanitized)).private_key).toBeUndefined()
  })

  test("a re-save whose new secret could not be stored keeps the old ones", async () => {
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    await CredentialStore.saveConnection("pg", { type: "postgres", password: "old", ssl_key: "k" } as any)
    CredentialStore.setSecretBackendForTests({ ...backend, set: async () => { throw new Error("keychain locked") } })
    const { warnings } = await CredentialStore.saveConnection("pg", { type: "postgres", password: "new" } as any)
    expect(warnings.length).toBe(1)
    expect(store.get("pg/password")).toBe("old")
    expect(store.get("pg/ssl_key")).toBe("k")
  })

  test("removing a connection removes its secrets from the OS store", async () => {
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    const name = `rm_${Date.now()}`
    expect((await Registry.add(name, { type: "postgres", host: "h", user: "u", password: "s3cret" } as any)).success).toBe(true)
    expect(store.get(`${name}/password`)).toBe("s3cret")
    expect((await Registry.remove(name)).success).toBe(true)
    expect([...store.keys()].filter((k) => k.startsWith(`${name}/`))).toEqual([])
  })

  test("a connection still defined by an env var keeps its secrets when the saved copy is removed", async () => {
    const { store, backend } = memoryBackend()
    CredentialStore.setSecretBackendForTests(backend)
    const name = `envkeep_${Date.now()}`
    await Registry.add(name, { type: "postgres", host: "h", user: "u", password: "s3cret" } as any)
    process.env[`ALTIMATE_CODE_CONN_${name.toUpperCase()}`] = JSON.stringify({ type: "postgres", host: "h", user: "u" })
    try {
      await Registry.remove(name)
      expect(store.get(`${name}/password`)).toBe("s3cret")
    } finally {
      delete process.env[`ALTIMATE_CODE_CONN_${name.toUpperCase()}`]
    }
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
