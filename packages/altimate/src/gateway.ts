import { Integration, Model, Plugin, Provider } from "@opencode/plugin"
import { Schema } from "effect"
import { homedir } from "node:os"
import path from "node:path"

const Credentials = Schema.Struct({
  altimateUrl: Schema.String,
  altimateInstanceName: Schema.String,
  altimateApiKey: Schema.String,
})
const BaseCredentials = Schema.Struct({
  version: Schema.Literal(1),
  installSecret: Schema.String,
  apiKey: Schema.optional(Schema.String),
  baseURL: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
  rejected: Schema.optional(Schema.Boolean),
})
const defaultURL = "https://api.myaltimate.com"

export function parseAltimateKey(value: string) {
  const parts = value.trim().split("::")
  if (parts.length < 2) throw new Error("Use instance::api-key or api-url::instance::api-key")
  return validateCredentials({
    altimateUrl: parts.length === 2 ? defaultURL : parts[0].trim(),
    altimateInstanceName: parts[parts.length === 2 ? 0 : 1].trim(),
    altimateApiKey: parts
      .slice(parts.length === 2 ? 1 : 2)
      .join("::")
      .trim(),
  })
}

export function gateway(
  options: {
    credentialsPath?: string
    baseCredentialsPath?: string
    env?: NodeJS.ProcessEnv
  } = {},
) {
  return Plugin.define({
    id: "altimate-gateway",
    async setup(ctx) {
      const env = options.env ?? process.env
      const home = env.OPENCODE_TEST_HOME ?? homedir()
      const tenantFile = options.credentialsPath ?? path.join(home, ".altimate", "altimate.json")
      const baseFile =
        options.baseCredentialsPath ??
        path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "altimate-code", "altimate-base.json")
      const tenantID = Provider.ID.make("altimate-backend")
      const baseID = Provider.ID.make("altimate-free")
      const tenantIntegration = Integration.ID.make(tenantID)
      const baseIntegration = Integration.ID.make(baseID)

      async function tenantCredentials() {
        // Preserve v1's file-first precedence and ${env:NAME} substitution.
        if (await Bun.file(tenantFile).exists()) {
          const raw = Schema.decodeUnknownSync(Credentials)(await Bun.file(tenantFile).json())
          return validateCredentials(
            Object.fromEntries(
              Object.entries(raw).map(([key, value]) => [
                key,
                value.replace(/\$\{env:([^}]+)\}/g, (_, name: string) => {
                  if (env[name] === undefined) throw new Error(`Environment variable ${name} not found`)
                  return env[name]
                }),
              ]),
            ),
          )
        }
        if (env.ALTIMATE_API_KEY && env.ALTIMATE_INSTANCE) {
          return validateCredentials({
            altimateUrl: env.ALTIMATE_GATEWAY_URL ?? env.ALTIMATE_API_URL ?? defaultURL,
            altimateInstanceName: env.ALTIMATE_INSTANCE,
            altimateApiKey: env.ALTIMATE_API_KEY,
          })
        }
        const connection = await ctx.integration.connection.active(tenantIntegration)
        const credential = connection && (await ctx.integration.connection.resolve(connection))
        if (credential?.type === "key") return parseAltimateKey(credential.key)
        return undefined
      }

      async function baseCredentials() {
        if (!(await Bun.file(baseFile).exists())) return undefined
        const stored = Schema.decodeUnknownSync(BaseCredentials)(await Bun.file(baseFile).json())
        const configured = env.ALTIMATE_BASE_GATEWAY_URL?.trim() || env.ALTIMATE_FREE_GATEWAY_URL?.trim()
        if (!configured || !stored.baseURL || !stored.apiKey || stored.rejected) return undefined
        const url = new URL(configured)
        if (url.protocol !== "https:" || url.username || url.password || /[?#]/.test(configured))
          throw new Error("ALTIMATE_BASE_GATEWAY_URL must be an HTTPS URL without credentials, query, or fragment")
        if (stored.baseURL !== url.toString().replace(/\/+$/, "")) return undefined
        if (stored.expiresAt && !(Date.parse(stored.expiresAt) > Date.now())) return undefined
        return { baseURL: `${stored.baseURL}/v1`, apiKey: stored.apiKey }
      }

      // Resolve file/env inputs before registering; connection-backed keys are resolved per request.
      // A stale legacy file must disable its provider, not the rest of Altimate.
      const tenant = await tenantCredentials().catch(() => null)
      const base = await baseCredentials().catch(() => undefined)
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(tenantID),
            name: "Altimate AI",
            integrationID: tenantIntegration,
            activation: tenant === null ? "disabled" : tenant ? "enabled" : "auto",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: `${tenant?.altimateUrl ?? defaultURL}/agents/v1`, apiKey: "altimate-managed" },
          },
          models: [
            {
              ...Model.Info.default(tenantID, Model.ID.make("altimate-default")),
              name: "Altimate LLM Gateway",
              family: Model.Family.make("openai"),
              limit: { context: 200_000, output: 128_000 },
            },
          ],
        })
        editor.add({
          info: {
            ...Provider.Info.empty(baseID),
            name: "Altimate",
            integrationID: baseIntegration,
            activation: base ? "enabled" : "disabled",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: {
              ...(base ? { baseURL: base.baseURL } : {}),
              apiKey: "altimate-base-managed",
              headerTimeout:
                Number.isFinite(Number(env.ALTIMATE_BASE_HEADER_TIMEOUT_MS)) &&
                Number(env.ALTIMATE_BASE_HEADER_TIMEOUT_MS) >= 1_000
                  ? Math.floor(Number(env.ALTIMATE_BASE_HEADER_TIMEOUT_MS))
                  : 300_000,
            },
          },
          models: [
            {
              ...Model.Info.default(baseID, Model.ID.make("altimate-base")),
              name: "Altimate Base",
              family: Model.Family.make("altimate"),
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 131_072, output: 65_536 },
            },
          ],
        })
      })
      // Altimate default: prefer the tenant gateway, then Altimate Base. A model is only listed when its provider
      // has credentials, so a missing key leaves the host's own default untouched and never breaks startup.
      // Registered before the config plugin, so an explicit user `model` still wins.
      await ctx.model.transform((editor) => {
        const preferred = [
          [tenantID, Model.ID.make("altimate-default")],
          [baseID, Model.ID.make("altimate-base")],
        ] as const
        const available = preferred.find(([providerID, modelID]) => editor.get(providerID, modelID)?.enabled)
        if (available) editor.default.set(String(available[0]), String(available[1]))
        // OpenCode's anonymous free tier rejects this build's user agent, so do not offer it. A key, a connection or
        // a configured provider apiKey replaces the "public" marker and keeps the provider listed.
        const opencode = editor.provider.get(Provider.ID.make("opencode"))
        if (opencode?.provider.settings?.apiKey !== "public") return
        for (const model of editor.list(opencode.provider.id))
          editor.update(String(model.providerID), String(model.id), (draft) => {
            draft.enabled = false
          })
      })
      await ctx.integration.transform((editor) => {
        editor.method.update({
          integrationID: tenantIntegration,
          method: {
            type: "key",
            label: "Paste instance::api-key or api-url::instance::api-key",
          },
        })
      })
      await ctx.session.hook(
        "model.request",
        async (event) => {
          const credentials = await tenantCredentials()
          if (!credentials) throw new Error("Altimate gateway credentials are unavailable")
          event.baseURL = `${credentials.altimateUrl}/agents/v1`
          event.headers["x-tenant"] = credentials.altimateInstanceName
          event.headers.Authorization = `Bearer ${credentials.altimateApiKey}`
        },
        { providerID: tenantID },
      )
      // v2.0.29's AI SDK route.with is a no-op. Rewrite the actual chat request
      // too, so a key connected after SDK initialization uses its stored API root.
      await ctx.session.hook(
        "http.request",
        async (event) => {
          const credentials = await tenantCredentials()
          if (!credentials) throw new Error("Altimate gateway credentials are unavailable")
          event.request = new Request(`${credentials.altimateUrl}/agents/v1/chat/completions`, event.request)
          event.request.headers.set("x-tenant", credentials.altimateInstanceName)
          event.request.headers.set("Authorization", `Bearer ${credentials.altimateApiKey}`)
        },
        { providerID: tenantID },
      )
      await ctx.session.hook(
        "model.request",
        async (event) => {
          const credentials = await baseCredentials()
          if (!credentials) throw new Error("Altimate Base credentials are unavailable or expired")
          event.baseURL = credentials.baseURL
          event.headers.Authorization = `Bearer ${credentials.apiKey}`
        },
        { providerID: baseID },
      )
      await ctx.session.hook(
        "http.request",
        async (event) => {
          const credentials = await baseCredentials()
          if (!credentials) throw new Error("Altimate Base credentials are unavailable or expired")
          event.request = new Request(`${credentials.baseURL}/chat/completions`, event.request)
          event.request.headers.set("Authorization", `Bearer ${credentials.apiKey}`)
        },
        { providerID: baseID },
      )
    },
  })
}

function validateCredentials(input: unknown) {
  const value = Schema.decodeUnknownSync(Credentials)(input)
  if (!/^https?:\/\//.test(value.altimateUrl)) throw new Error("Altimate API URL must use HTTP or HTTPS")
  if (!/^[a-z_][a-z0-9_-]*$/.test(value.altimateInstanceName)) throw new Error("Invalid Altimate instance name")
  if (!value.altimateApiKey) throw new Error("Altimate API key must not be empty")
  return { ...value, altimateUrl: value.altimateUrl.replace(/\/+$/, "") }
}

export const Gateway = gateway()
