/**
 * The warehouse credential store falls back to an OS store when keytar is not
 * installed (it never is in a released binary). Before that fallback every
 * credential was stripped from the saved connection, so a connection worked in
 * the session that added it and failed after a restart.
 */
import { afterEach, describe, expect, test } from "bun:test"
import * as CredentialStore from "../../src/altimate/native/connections/credential-store"

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

  test("with no backend the test preload keeps the real keychain untouched", async () => {
    // The preload sets the disable switch; re-probing must respect it.
    CredentialStore.setSecretBackendForTests(undefined)
    expect(process.env.ALTIMATE_CODE_DISABLE_OS_CREDENTIAL_STORE).toBe("1")
    expect(await CredentialStore.storeCredential("pg", "password", "x")).toBe(false)
  })
})
