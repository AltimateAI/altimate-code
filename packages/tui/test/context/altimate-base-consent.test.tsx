/** @jsxImportSource @opentui/solid */
// altimate_change start — proves the consent-gated Altimate Base registration operation cannot be
// reached through the PUBLIC SDK context (`@opencode-ai/tui/context/sdk`'s `useSDK()`), only
// through the dedicated `context/altimate-base-consent.tsx` module — which is not listed in
// package.json's `exports` map and so cannot be imported from outside this package. This closes
// the gap where any in-process consumer of `useSDK()`, including a plugin-rendered component,
// could call `sdk.altimateBaseRegistration()` directly and mint a Base install identifier without
// the disclosure dialog ever being shown.
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { AltimateBaseConsentProvider, useAltimateBaseConsent } from "../../src/context/altimate-base-consent"
import { createFetch, eventSource } from "../fixture/tui-sdk"

test("the registration operation is not reachable through the public SDK context", async () => {
  const calls: true[] = []
  const register = async () => {
    calls.push(true)
    return { ok: true as const }
  }

  let sdk: ReturnType<typeof useSDK> | undefined
  let consent: ReturnType<typeof useAltimateBaseConsent> | undefined

  function Probe() {
    sdk = useSDK()
    consent = useAltimateBaseConsent()
    return null
  }

  const app = await testRender(
    () => (
      <SDKProvider url="http://test" fetch={createFetch().fetch} events={eventSource()}>
        <AltimateBaseConsentProvider value={register}>
          <Probe />
        </AltimateBaseConsentProvider>
      </SDKProvider>
    ),
    { kittyKeyboard: true },
  )
  try {
    await app.renderOnce()

    // The public SDK context object carries no such property at all, forged or otherwise — a
    // plugin that only imports `@opencode-ai/tui/context/sdk` has no way to reach registration.
    expect(sdk).toBeDefined()
    expect("altimateBaseRegistration" in (sdk as object)).toBe(false)
    expect((sdk as Record<string, unknown>)["altimateBaseRegistration"]).toBeUndefined()

    // The dedicated context is how the legitimate consent-accept flow reaches the same operation.
    expect(consent).toBe(register)
    expect(calls).toHaveLength(0)
    await consent?.()
    expect(calls).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("useAltimateBaseConsent is undefined when no host injected a registration operation", async () => {
  let consent: ReturnType<typeof useAltimateBaseConsent> | undefined | "not-called" = "not-called"

  function Probe() {
    consent = useAltimateBaseConsent()
    return null
  }

  const app = await testRender(
    () => (
      <SDKProvider url="http://test" fetch={createFetch().fetch} events={eventSource()}>
        <Probe />
      </SDKProvider>
    ),
    { kittyKeyboard: true },
  )
  try {
    await app.renderOnce()
    expect(consent).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
// altimate_change end
