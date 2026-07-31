import { Context } from "effect"

// altimate_change start — brand the built-in allowed-origin regex to the fork's
// domain. This package (@opencode-ai/server) wasn't covered by the branding
// transform script that ran over packages/opencode; without this, requests
// from https://app.altimate.ai (our web app) are rejected as an untrusted CORS
// origin, including on error responses like 401 that still need CORS headers.
const opencodeOrigin = /^https:\/\/([a-z0-9-]+\.)*altimate\.ai$/
// altimate_change end

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@opencode/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (opencodeOrigin.test(input)) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
