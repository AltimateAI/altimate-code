import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, createPrivateKey } from "node:crypto"
import { normalizePrivateKeyPem, toPkcs8Pem } from "../src/snowflake-key"

const PASS = "test-pass-phrase"

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const fingerprint = (pem: string) =>
  createPrivateKey(pem).export({ type: "pkcs8", format: "der" }).toString("base64")
const expected = fingerprint(rsa.privateKey.export({ type: "pkcs8", format: "pem" }) as string)

const pkcs8 = rsa.privateKey.export({ type: "pkcs8", format: "pem" }) as string
const pkcs1 = rsa.privateKey.export({ type: "pkcs1", format: "pem" }) as string
const pkcs8Enc = rsa.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: PASS }) as string
const pkcs1Enc = rsa.privateKey.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: PASS }) as string

const spaced = (pem: string) => pem.trim().replace(/\r?\n/g, " ")
const escaped = (pem: string) => pem.trim().replace(/\n/g, "\\n")

describe("toPkcs8Pem", () => {
  const plain: Record<string, string> = { pkcs8, pkcs1 }
  for (const [name, pem] of Object.entries(plain)) {
    const variants: Record<string, string> = {
      multiline: pem,
      crlf: pem.replace(/\n/g, "\r\n"),
      "space-separated": spaced(pem),
      "escaped newlines": escaped(pem),
      quoted: `"${escaped(pem)}"`,
      "single quoted multiline": `'${pem}'`,
    }
    for (const [variant, text] of Object.entries(variants)) {
      test(`unencrypted ${name} (${variant})`, () => {
        expect(fingerprint(toPkcs8Pem(text))).toBe(expected)
      })
    }
  }

  const encrypted: Record<string, string> = { "encrypted pkcs8": pkcs8Enc, "legacy encrypted pkcs1": pkcs1Enc }
  for (const [name, pem] of Object.entries(encrypted)) {
    const variants: Record<string, string> = {
      multiline: pem,
      crlf: pem.replace(/\n/g, "\r\n"),
      "space-separated": spaced(pem),
      "escaped newlines": escaped(pem),
    }
    for (const [variant, text] of Object.entries(variants)) {
      test(`${name} with passphrase (${variant})`, () => {
        const out = toPkcs8Pem(text, PASS)
        expect(out).toContain("-----BEGIN PRIVATE KEY-----")
        expect(fingerprint(out)).toBe(expected)
      })
    }

    test(`${name} without passphrase gives an actionable error`, () => {
      expect(() => toPkcs8Pem(pem)).toThrow(/encrypted; set the passphrase/)
      expect(() => toPkcs8Pem(spaced(pem), "")).toThrow(/encrypted; set the passphrase/)
    })

    test(`${name} with wrong passphrase leaks no key material`, () => {
      let msg = ""
      try {
        toPkcs8Pem(pem, "wrong")
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toMatch(/passphrase .* incorrect/)
      expect(msg).not.toMatch(/DECODER|bad decrypt|wrong/)
      const bodyLines = pem.split("\n").filter((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l))
      expect(bodyLines.length).toBeGreaterThan(0)
      for (const line of bodyLines) expect(msg).not.toContain(line)
    })
  }

  test("unencrypted key with an unneeded passphrase still works", () => {
    expect(fingerprint(toPkcs8Pem(pkcs8, PASS))).toBe(expected)
  })

  test("non-PEM text is rejected without echoing it", () => {
    expect(() => toPkcs8Pem("super-secret-token")).toThrow(/not recognized/)
    try {
      toPkcs8Pem("super-secret-token")
    } catch (e) {
      expect((e as Error).message).not.toContain("super-secret-token")
    }
  })

  test("corrupted body gives a parse error without key material", () => {
    const bad = "-----BEGIN PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUA==\n-----END PRIVATE KEY-----"
    expect(() => toPkcs8Pem(bad)).toThrow(/could not be parsed/)
  })

  test("a private key after other PEM blocks is found", () => {
    const pub = rsa.publicKey.export({ type: "spki", format: "pem" }) as string
    expect(fingerprint(toPkcs8Pem(`${pub}\n${pkcs8}`))).toBe(expected)
    expect(fingerprint(toPkcs8Pem(spaced(`${pub}\n${pkcs8}`)))).toBe(expected)
    expect(fingerprint(toPkcs8Pem(`${pub}\n${pkcs8Enc}`, PASS))).toBe(expected)
  })

  test("public key PEM is not accepted as a private key", () => {
    const pub = rsa.publicKey.export({ type: "spki", format: "pem" }) as string
    expect(() => toPkcs8Pem(pub)).toThrow(/not recognized/)
  })
})

describe("normalizePrivateKeyPem", () => {
  test("rebuilds 64-char lines between markers", () => {
    const out = normalizePrivateKeyPem(spaced(pkcs8))!.pem.trim().split("\n")
    expect(out[0]).toBe("-----BEGIN PRIVATE KEY-----")
    expect(out[out.length - 1]).toBe("-----END PRIVATE KEY-----")
    for (const l of out.slice(1, -2)) expect(l.length).toBe(64)
  })

  test("keeps legacy headers on their own lines followed by a blank line", () => {
    const out = normalizePrivateKeyPem(spaced(pkcs1Enc))!
    expect(out.legacyEncrypted).toBe(true)
    expect(out.pem).toMatch(/Proc-Type: 4,ENCRYPTED\nDEK-Info: [^\n]+\n\n/)
  })
})

describe("snowflake connect() key-pair wiring", () => {
  const { connect } = require("../src/snowflake") as typeof import("../src/snowflake")
  function fakeSdk() {
    const created: any[] = []
    return {
      created,
      sdk: {
        configure() {},
        createConnection(options: any) {
          created.push(options)
          return { connect: (cb: (e: Error | null) => void) => cb(null), isUp: () => true, execute() {}, destroy: (cb: any) => cb(null) }
        },
      },
    }
  }
  const base = { type: "snowflake", account: "acme-xy123", user: "u" } as any

  const cases: Array<[string, string, string | undefined]> = [
    ["space-separated pkcs8", spaced(pkcs8), undefined],
    ["escaped pkcs1", escaped(pkcs1), undefined],
    ["encrypted pkcs8, spaces", spaced(pkcs8Enc), PASS],
    ["legacy encrypted pkcs1, spaces", spaced(pkcs1Enc), PASS],
  ]
  for (const [name, key, pass] of cases) {
    test(`passes an unencrypted PKCS#8 key to the SDK: ${name}`, async () => {
      const { sdk, created } = fakeSdk()
      const c = await connect({ ...base, private_key: key, private_key_passphrase: pass }, sdk as any)
      await c.connect()
      expect(created[0].authenticator).toBe("SNOWFLAKE_JWT")
      expect(fingerprint(created[0].privateKey)).toBe(expected)
      expect(created[0].privateKey).toContain("-----BEGIN PRIVATE KEY-----")
    })
  }

  test("encrypted key without a passphrase is a clear error", async () => {
    const { sdk } = fakeSdk()
    const c = await connect({ ...base, private_key: pkcs8Enc }, sdk as any)
    await expect(c.connect()).rejects.toThrow(/encrypted; set the passphrase/)
  })
})
