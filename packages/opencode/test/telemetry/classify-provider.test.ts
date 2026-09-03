// v0.9.5 review — Tech Lead P1.
//
// classifyProvider (packages/opencode/src/altimate/telemetry/index.ts) sits on the
// `provider_selected` telemetry path. It is the point where a caller-supplied provider
// id becomes an enum value on our wire, so its allowlist is load-bearing:
//
//   - CURATED_PROVIDER_ENUM must be a null-prototype record. A plain `{}` inherits
//     Object.prototype, and `record["constructor"]` / ["toString"] / ["valueOf"]
//     resolve to inherited functions — those functions are truthy, so with a plain
//     object the branch `if (curated) return { provider: curated, ... }` would
//     ship the string form of a JS built-in as a "provider" name (or worse, whatever
//     the caller-supplied id was, since normalizeCustomProviderID upstream permits
//     lowercase letters). The null-prototype defense makes those lookups return
//     undefined, forcing the "not curated" path.
//
//   - Only ids in KNOWN_PROVIDER_IDS should carry a raw provider_id on the wire.
//     Everything else falls through to `{ provider: "other" }` with NO id attached —
//     that's what keeps a customer-named custom provider from leaking to telemetry.
//
//   - Altimate Base is a curated, publicly-known provider. Big Pickle remains an
//     explicitly-selectable upstream model but no longer owns a product funnel category.
//
// This file locks each of those three behaviors down.

import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"

describe("Telemetry.classifyProvider — allowlist + prototype defense", () => {
  describe("curated providers", () => {
    test.each([
      ["altimate-backend", "altimate_gateway"],
      ["altimate-free", "altimate_base"],
      ["anthropic", "anthropic"],
      ["openai", "openai"],
      ["google", "google"],
    ])("providerID %j → provider %j, keeps raw id", (providerID, expected) => {
      const result = Telemetry.classifyProvider(providerID)
      expect(result).toEqual({ provider: expected, provider_id: providerID })
    })
  })

  describe("prototype-pollution defense", () => {
    // The three inherited-property names most likely to appear as a "provider id"
    // in the wild (they're plain lowercase identifiers, so they slip past
    // normalizeCustomProviderID). Without the Object.create(null) barrier,
    // `CURATED_PROVIDER_ENUM["constructor"]` returns the JS constructor Function,
    // which is truthy — and the branch would ship it as a curated provider.
    test.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
      "prototype key %j must NOT be treated as a curated match",
      (key) => {
        const result = Telemetry.classifyProvider(key)
        // The guarantee: a prototype key must not resolve to any curated enum.
        // `toBe("other")` implies it is none of the curated provider values,
        // so no separate `not.toContain` guard is needed.
        expect(result.provider).toBe("other")
      },
    )
  })

  describe("known-but-not-curated providers", () => {
    test.each([
      "opencode",
      "github-copilot",
      "azure",
      "amazon-bedrock",
      "openrouter",
      "mistral",
      "groq",
      "deepseek",
      "xai",
      "snowflake-cortex",
      "databricks",
      "ollama",
      "lmstudio",
    ])("providerID %j → provider 'other', keeps raw id (safe to publish)", (providerID) => {
      const result = Telemetry.classifyProvider(providerID)
      expect(result).toEqual({ provider: "other", provider_id: providerID })
    })
  })

  describe("unknown / customer-named providers", () => {
    test.each(["acme-corp", "my-internal-gateway", "team-eng-shared-llm", ""])(
      "providerID %j → provider 'other', DROPS raw id (no PII leak)",
      (providerID) => {
        const result = Telemetry.classifyProvider(providerID)
        expect(result.provider).toBe("other")
        expect(result.provider_id).toBeUndefined()
      },
    )
  })

  describe("legacy Big Pickle selection", () => {
    test("is available as an upstream model but is no longer a curated product choice", () => {
      expect(Telemetry.classifyProvider("opencode", "big-pickle")).toEqual({
        provider: "other",
        provider_id: "opencode",
      })
    })
  })
})
