// altimate_change start — the Altimate Base consent-gated registration operation, kept OUT of the
// public SDK context (`./sdk`, exported from the package as `@opencode-ai/tui/context/sdk`). Any
// in-process consumer of that public hook — including a plugin-rendered component that only
// imports the published surface — must not be able to call this and mint a Base install identifier
// / enable request logging without the disclosure dialog ever being shown and accepted.
//
// This module is deliberately NOT listed in `package.json`'s `exports` map, so
// `@opencode-ai/tui/context/altimate-base-consent` cannot be resolved from outside this package —
// Node's exports field rejects any subpath it does not list, even by an external caller who knows
// the file's on-disk path. Only in-package modules can import it directly: `app.tsx` (which
// receives the host-injected operation and provides it here) and the two legitimate readers, the
// consent dialog (which actually calls it, only after the user accepts) and the provider picker
// (which only checks whether it exists, to decide whether to advertise Base setup at all).
import { createContext, useContext, type ParentProps } from "solid-js"

export type AltimateBaseRegistration = () => Promise<
  | { ok: true }
  | {
      ok: false
      result: "rate_limited" | "unavailable" | "network" | "error"
      message: string
    }
>

const AltimateBaseConsentContext = createContext<AltimateBaseRegistration | undefined>()

export function AltimateBaseConsentProvider(props: ParentProps<{ value?: AltimateBaseRegistration }>) {
  return (
    <AltimateBaseConsentContext.Provider value={props.value}>{props.children}</AltimateBaseConsentContext.Provider>
  )
}

/**
 * Returns the host-injected registration operation, or `undefined` when the host did not supply
 * one (or this is called outside the provider). No "must be used within a provider" guard, unlike
 * most contexts here: many hosts (tests, embedders, headless callers) never mount
 * `AltimateBaseConsentProvider` at all, and the absence of Base setup is a normal, silent case —
 * every call site already handles `undefined` by hiding or refusing Base setup.
 */
export function useAltimateBaseConsent(): AltimateBaseRegistration | undefined {
  return useContext(AltimateBaseConsentContext)
}
// altimate_change end
