// altimate_change start — /logout signs out of the provider behind the current model. This file
// decides what that means for the provider: which login to remove, and what to call it.
export const GATEWAY_PROVIDER_ID = "altimate-backend"
export const ALTIMATE_BASE_PROVIDER_ID = "altimate-free"

/** Subscription names for providers whose sign-in is a paid plan rather than a generic OAuth login. */
const SUBSCRIPTION_NAMES: Record<string, string> = {
  openai: "ChatGPT subscription",
  anthropic: "Claude subscription",
  "github-copilot": "Copilot subscription",
}

export type LogoutProvider = {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  auth?: "api" | "oauth" | "wellknown"
  env: readonly string[]
}

export type LogoutTarget =
  /** The Altimate LLM Gateway: its own sign-out also removes the MCP servers that carry its key. */
  | { kind: "gateway"; providerID: string; label: string }
  /** Altimate Base: a managed credential with its own store. */
  | { kind: "base"; providerID: string; label: string }
  /** A login saved by altimate-code (API key or sign-in), removed from the auth store. */
  | { kind: "saved"; providerID: string; label: string }
  /** Connected from outside altimate-code (environment variable, config, another tool): nothing to remove. */
  | { kind: "external"; providerID: string; label: string; hint: string }

export function logoutTarget(
  model: { providerID: string } | undefined,
  providers: readonly LogoutProvider[],
): LogoutTarget | undefined {
  if (!model) return
  const providerID = model.providerID
  if (providerID === GATEWAY_PROVIDER_ID) return { kind: "gateway", providerID, label: "Altimate LLM Gateway" }
  if (providerID === ALTIMATE_BASE_PROVIDER_ID) return { kind: "base", providerID, label: "Altimate Base" }
  const provider = providers.find((item) => item.id === providerID)
  if (!provider) return
  if (provider.auth) return { kind: "saved", providerID, label: `${provider.name} (${loginName(provider)})` }
  if (provider.source === "env") {
    const variable = provider.env.length === 1 ? provider.env[0] : "an environment variable"
    return {
      kind: "external",
      providerID,
      label: `${provider.name} is set by ${variable}`,
      hint: `${provider.name} is set by ${variable}. Unset it and restart to disconnect.`,
    }
  }
  if (provider.source === "config") {
    return {
      kind: "external",
      providerID,
      label: `${provider.name} is set in your config`,
      hint: `${provider.name} is set in your config. Remove it there to disconnect.`,
    }
  }
  return {
    kind: "external",
    providerID,
    label: `${provider.name} is connected outside Altimate Code`,
    hint: `${provider.name} is connected outside Altimate Code, so there is no login here to remove.`,
  }
}

function loginName(provider: LogoutProvider): string {
  if (provider.auth === "api") return "API key"
  if (provider.auth === "oauth") return SUBSCRIPTION_NAMES[provider.id] ?? "sign-in"
  return "sign-in"
}

/** The command title: the action for a login we can remove, the explanation for one we can't. */
export function logoutTitle(target: LogoutTarget | undefined): string {
  if (!target) return "Log out"
  if (target.kind === "external") return target.label
  return `Log out of ${target.label}`
}
// altimate_change end
