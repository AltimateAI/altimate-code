import z from "zod"
import { Schema } from "effect"
// altimate_change start — Effect Context.Service facade deps (added to existing namespace)
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
// altimate_change end
import os from "os"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../bun"
import { Hash } from "../util/hash"
import { Plugin } from "../plugin"
import { NamedError } from "@opencode-ai/core/util/error"
import { ModelsDev } from "./models"
import { Auth } from "../auth"
import { Env } from "../env"
// altimate_change start — bridge Effect InstanceRef into legacy Instance ALS for Provider.Service methods
import { InstanceRef } from "../effect/instance-ref"
// altimate_change end
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { Global } from "../global"
import path from "path"
import { Filesystem } from "../util/filesystem"
import { AltimateApi } from "../altimate/api/client"
// altimate_change start — free-tier gateway credentials for the altimate-free loader
import { FreeTier } from "../altimate/free/client"
// altimate_change end

// Direct imports for bundled providers
import { createAmazonBedrock, type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
// altimate_change start — Bedrock Mantle is a bundled subpath, not an installable package name
import { createBedrockMantle } from "@ai-sdk/amazon-bedrock/mantle"
// altimate_change end
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter, type LanguageModelV3 as LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "@opencode-ai/core/github-copilot/copilot-provider"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createGitLab, VERSION as GITLAB_PROVIDER_VERSION } from "gitlab-ai-provider"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { GoogleAuth } from "google-auth-library"
import { ProviderTransform } from "./transform"
// altimate_change start — provider fetch timeout errors use typed ProviderError classes
import { ProviderError } from "./error"
// altimate_change end
import { Installation } from "../installation"
import { ModelID, ProviderID } from "./schema"
// altimate_change start — snowflake cortex account validation
import { VALID_ACCOUNT_RE } from "../altimate/plugin/snowflake"
// altimate_change end
// altimate_change start — databricks host validation
import { isValidDatabricksHost } from "../altimate/plugin/databricks"
// altimate_change end

// altimate_change start — raise SSE chunk-timeout watchdog 2min→5min (#844) for slow warehouse/LLM streams
const DEFAULT_CHUNK_TIMEOUT = 300_000
// altimate_change end
// altimate_change start — OpenAI-compatible HTTP header timeout support
const OPENAI_HEADER_TIMEOUT_DEFAULT = 10_000
const HEADER_TIMEOUT = Symbol.for("opencode.provider.header-timeout")
// altimate_change end

export namespace Provider {
  const log = Log.create({ service: "provider" })

  function shouldUseCopilotResponsesApi(modelID: string): boolean {
    const match = /^gpt-(\d+)/.exec(modelID)
    if (!match) return false
    return Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")
  }

  function wrapSSE(res: Response, ms: number, ctl: AbortController) {
    if (typeof ms !== "number" || ms <= 0) return res
    if (!res.body) return res
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

    const reader = res.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const id = setTimeout(() => {
            // altimate_change start — surface stalled SSE reads as ProviderError.ResponseStreamError
            const err = new ProviderError.ResponseStreamError("SSE read timed out")
            // altimate_change end
            ctl.abort(err)
            void reader.cancel(err)
            reject(err)
          }, ms)

          reader.read().then(
            (part) => {
              clearTimeout(id)
              resolve(part)
            },
            (err) => {
              clearTimeout(id)
              reject(err)
            },
          )
        })

        if (part.done) {
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      },
      async cancel(reason) {
        ctl.abort(reason)
        await reader.cancel(reason)
      },
    })

    return new Response(body, {
      headers: new Headers(res.headers),
      status: res.status,
      statusText: res.statusText,
    })
  }

  // altimate_change start — abort fetches when response headers do not arrive in time
  function timeoutController(ms: number) {
    const ctl = new AbortController()
    const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError(ms)), ms)
    return {
      signal: ctl.signal,
      clear: () => clearTimeout(id),
    }
  }
  // altimate_change end

  const BUNDLED_PROVIDERS: Record<string, (options: any) => any> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    // altimate_change start — Bedrock Mantle bundled provider subpath
    "@ai-sdk/amazon-bedrock/mantle": createBedrockMantle,
    // altimate_change end
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    "@ai-sdk/vercel": createVercel,
    "@gitlab/gitlab-ai-provider": createGitLab,
    // @ts-ignore (TODO: kill this code so we dont have to maintain it)
    "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible,
  }

  // altimate_change start — loaders may need the resolved model to choose SDK APIs
  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>, model?: Model) => Promise<any>
  // altimate_change end
  type CustomVarsLoader = (options: Record<string, any>) => Record<string, string>
  type CustomLoader = (provider: Info) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    vars?: CustomVarsLoader
    options?: Record<string, any>
  }>

  function useLanguageModel(sdk: any) {
    return sdk.responses === undefined && sdk.chat === undefined
  }

  // altimate_change start — select Responses for Mantle OpenAI models, chat for OSS safeguard
  function selectBedrockMantleLanguageModel(sdk: any, modelID: string) {
    if (modelID === "openai.gpt-oss-safeguard-20b" || modelID === "openai.gpt-oss-safeguard-120b") {
      return sdk.chat?.(modelID) ?? sdk.languageModel(modelID)
    }
    return sdk.responses?.(modelID) ?? sdk.languageModel(modelID)
  }
  // altimate_change end

  // altimate_change start — DigitalOcean fallback provider catalog when the auth plugin is not registered
  const DIGITALOCEAN_INFERENCE_BASE = "https://inference.do-ai.run/v1"
  type DigitalOceanRouterEntry = {
    name: string
    uuid?: string
    description?: string
  }

  function digitalOceanBaseModel(): Model {
    return {
      id: ModelID.make("llama-3.3-70b-instruct"),
      providerID: ProviderID.make("digitalocean"),
      api: {
        id: "llama-3.3-70b-instruct",
        url: DIGITALOCEAN_INFERENCE_BASE,
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Llama 3.3 70B Instruct",
      family: "llama",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128_000, output: 8_192 },
      status: "active",
      options: {},
      headers: {},
      release_date: "",
      variants: {},
    }
  }

  function digitalOceanRouterModel(router: DigitalOceanRouterEntry): Model {
    const id = `router:${router.name}`
    return {
      id: ModelID.make(id),
      providerID: ProviderID.make("digitalocean"),
      api: { id, url: DIGITALOCEAN_INFERENCE_BASE, npm: "@ai-sdk/openai-compatible" },
      name: router.name,
      family: "digitalocean-inference-routers",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128_000, output: 8_192 },
      status: "active",
      options: {},
      headers: {},
      release_date: "",
      variants: {},
    }
  }

  function digitalOceanProviderInfo(): Info {
    return {
      id: ProviderID.make("digitalocean"),
      name: "DigitalOcean",
      source: "custom",
      env: ["DIGITALOCEAN_ACCESS_TOKEN"],
      options: { baseURL: DIGITALOCEAN_INFERENCE_BASE },
      models: {
        "llama-3.3-70b-instruct": digitalOceanBaseModel(),
      },
    }
  }

  function parseDigitalOceanRouters(metadata: Record<string, string> | undefined): DigitalOceanRouterEntry[] {
    const raw = metadata?.routers
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((router) =>
        router && typeof router.name === "string"
          ? [{ name: router.name, uuid: router.uuid, description: router.description }]
          : [],
      )
    } catch {
      return []
    }
  }
  // altimate_change end

  const CUSTOM_LOADERS: Record<string, CustomLoader> = {
    async anthropic() {
      return {
        autoload: false,
        options: {
          headers: {
            "anthropic-beta":
              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }
    },
    async opencode(input) {
      const hasKey = await (async () => {
        const env = Env.all()
        if (input.env.some((item) => env[item])) return true
        if (await Auth.get(input.id)) return true
        const config = await Config.get()
        if (config.provider?.["opencode"]?.options?.apiKey) return true
        return false
      })()

      if (!hasKey) {
        for (const [key, value] of Object.entries(input.models)) {
          if (value.cost.input === 0) continue
          delete input.models[key]
        }
      }

      return {
        autoload: Object.keys(input.models).length > 0,
        options: hasKey ? {} : { apiKey: "public" },
      }
    },
    // altimate_change start — Altimate backend provider: ~/.altimate/altimate.json first, auth store (TUI-configured) as fallback
    "altimate-backend": async () => {
      // Path 1: ~/.altimate/altimate.json (primary — manual file or env-var substitution, never overwritten)
      const isConfigured = await AltimateApi.isConfigured()
      if (isConfigured) {
        try {
          const creds = await AltimateApi.getCredentials()
          return {
            autoload: true,
            options: {
              baseURL: `${creds.altimateUrl.replace(/\/+$/, "")}/agents/v1`,
              apiKey: creds.altimateApiKey,
              headers: {
                "x-tenant": creds.altimateInstanceName,
              },
            },
          }
        } catch {
          // Suppress stale auth so the generic Auth.all() merge doesn't leave an invalid provider
          await Auth.remove(ProviderID.make("altimate-backend")).catch(() => {})
          return { autoload: false }
        }
      }
      // Path 2: auth store (populated by TUI entry, file not yet written)
      const auth = await Auth.get(ProviderID.make("altimate-backend"))
      if (auth?.type === "api") {
        const parsed = AltimateApi.parseAltimateKey(auth.key)
        if (parsed) {
          return {
            autoload: true,
            options: {
              baseURL: `${parsed.altimateUrl.replace(/\/+$/, "")}/agents/v1`,
              apiKey: parsed.altimateApiKey,
              headers: {
                "x-tenant": parsed.altimateInstanceName,
              },
            },
          }
        }
        // Invalid key format — remove stale auth entry
        await Auth.remove(ProviderID.make("altimate-backend")).catch(() => {})
      }
      return { autoload: false }
    },
    // altimate_change end
    // altimate_change start — free-tier gateway provider: READ-ONLY. Registration is
    // consent-gated in the TUI disclosure dialog, so this never mints an identifier or
    // makes a network call for an unregistered install. Returning autoload:false leaves the
    // provider available for the picker's NEEDS-SETUP list.
    "altimate-free": async () => {
      const creds = await FreeTier.credentialsForLoad().catch(() => undefined)
      if (!creds) return { autoload: false }
      return {
        autoload: true,
        options: {
          baseURL: `${creds.baseURL}/v1`,
          apiKey: creds.apiKey,
          // Keys are short-lived, and the SDK captures the one it was built with. The wrapper
          // re-reads the stored credential per request and rotates on a 401.
          fetch: FreeTier.authorizedFetch,
        },
      }
    },
    // altimate_change end
    openai: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        // altimate_change start — OpenAI API auth gets the v1.17.9 header-timeout default
        options: { headerTimeout: OPENAI_HEADER_TIMEOUT_DEFAULT },
        // altimate_change end
      }
    },
    "github-copilot": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    "github-copilot-enterprise": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    azure: async (provider) => {
      const resource = iife(() => {
        const name = provider.options?.resourceName
        if (typeof name === "string" && name.trim() !== "") return name
        return Env.get("AZURE_RESOURCE_NAME")
      })

      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {},
        vars(_options) {
          return {
            ...(resource && { AZURE_RESOURCE_NAME: resource }),
          }
        },
      }
    },
    "azure-cognitive-services": async () => {
      const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    },
    "amazon-bedrock": async () => {
      const config = await Config.get()
      const providerConfig = config.provider?.["amazon-bedrock"]
      // altimate_change start — config apiKey is a valid Bedrock/Mantle credential
      const configApiKey = providerConfig?.options?.apiKey
      // altimate_change end

      const auth = await Auth.get("amazon-bedrock")

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = Env.get("AWS_REGION")
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = Env.get("AWS_PROFILE")
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")

      // TODO: Using process.env directly because Env.set only updates a process.env shallow copy,
      // until the scope of the Env API is clarified (test only or runtime?)
      const awsBearerToken = iife(() => {
        const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK
        if (envToken) return envToken
        if (auth?.type === "api") {
          process.env.AWS_BEARER_TOKEN_BEDROCK = auth.key
          return auth.key
        }
        return undefined
      })

      const awsWebIdentityTokenFile = Env.get("AWS_WEB_IDENTITY_TOKEN_FILE")

      const containerCreds = Boolean(
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      )

      if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile && !containerCreds && !configApiKey)
        return { autoload: false }

      const providerOptions: AmazonBedrockProviderSettings = {
        region: defaultRegion,
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken && !configApiKey) {
        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        vars(options) {
          return {
            AWS_REGION: String(options.region ?? defaultRegion),
          }
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>, model?: Model) {
          if (model?.api.npm === "@ai-sdk/amazon-bedrock/mantle") return selectBedrockMantleLanguageModel(sdk, modelID)

          // Skip region prefixing if model already has a cross-region inference profile prefix
          // Models from models.dev may already include prefixes like us., eu., global., etc.
          const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
          if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from opencode.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    },
    openrouter: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://altimate.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
    vercel: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://altimate.ai/",
            "x-title": "opencode",
          },
        },
      }
    },
    "google-vertex": async (provider) => {
      const project =
        provider.options?.project ??
        Env.get("GOOGLE_CLOUD_PROJECT") ??
        Env.get("GCP_PROJECT") ??
        Env.get("GCLOUD_PROJECT")

      const location = String(
        provider.options?.location ??
          Env.get("GOOGLE_VERTEX_LOCATION") ??
          Env.get("GOOGLE_CLOUD_LOCATION") ??
          Env.get("VERTEX_LOCATION") ??
          "us-central1",
      )

      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        vars(_options: Record<string, any>) {
          const endpoint = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
          return {
            ...(project && { GOOGLE_VERTEX_PROJECT: project }),
            GOOGLE_VERTEX_LOCATION: location,
            GOOGLE_VERTEX_ENDPOINT: endpoint,
          }
        },
        options: {
          project,
          location,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const auth = new GoogleAuth()
            const client = await auth.getApplicationDefault()
            const token = await client.credential.getAccessToken()

            const headers = new Headers(init?.headers)
            headers.set("Authorization", `Bearer ${token.token}`)

            return fetch(input, { ...init, headers })
          },
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "google-vertex-anthropic": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "sap-ai-core": async () => {
      const auth = await Auth.get("sap-ai-core")
      // TODO: Using process.env directly because Env.set only updates a shallow copy (not process.env),
      // until the scope of the Env API is clarified (test only or runtime?)
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = process.env.AICORE_SERVICE_KEY
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          process.env.AICORE_SERVICE_KEY = auth.key
          return auth.key
        }
        return undefined
      })
      const deploymentId = process.env.AICORE_DEPLOYMENT_ID
      const resourceGroup = process.env.AICORE_RESOURCE_GROUP

      return {
        autoload: !!envServiceKey,
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          return sdk(modelID)
        },
      }
    },
    zenmux: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://altimate.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
    gitlab: async (input) => {
      const instanceUrl = Env.get("GITLAB_INSTANCE_URL") || "https://gitlab.com"

      const auth = await Auth.get(input.id)
      const apiKey = await (async () => {
        if (auth?.type === "oauth") return auth.access
        if (auth?.type === "api") return auth.key
        return Env.get("GITLAB_TOKEN")
      })()

      const config = await Config.get()
      const providerConfig = config.provider?.["gitlab"]

      const aiGatewayHeaders = {
        // altimate_change start — upstream_fix: UA brand
        "User-Agent": `altimate-code/${Installation.VERSION} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
        // altimate_change end
        "anthropic-beta": "context-1m-2025-08-07",
        ...(providerConfig?.options?.aiGatewayHeaders || {}),
      }

      return {
        autoload: !!apiKey,
        options: {
          instanceUrl,
          apiKey,
          aiGatewayHeaders,
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...(providerConfig?.options?.featureFlags || {}),
          },
        },
        async getModel(sdk: ReturnType<typeof createGitLab>, modelID: string) {
          return sdk.agenticChat(modelID, {
            aiGatewayHeaders,
            featureFlags: {
              duo_agent_platform_agentic_chat: true,
              duo_agent_platform: true,
              ...(providerConfig?.options?.featureFlags || {}),
            },
          })
        },
      }
    },
    "cloudflare-workers-ai": async (input) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      if (!accountId) return { autoload: false }

      const apiKey = await iife(async () => {
        const envToken = Env.get("CLOUDFLARE_API_KEY")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })

      return {
        autoload: !!apiKey,
        options: {
          apiKey,
        },
        async getModel(sdk: any, modelID: string) {
          return sdk.languageModel(modelID)
        },
        vars(_options) {
          return {
            CLOUDFLARE_ACCOUNT_ID: accountId,
          }
        },
      }
    },
    "cloudflare-ai-gateway": async (input) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      const gateway = Env.get("CLOUDFLARE_GATEWAY_ID")

      if (!accountId || !gateway) return { autoload: false }

      // Get API token from env or auth - required for authenticated gateways
      const apiToken = await (async () => {
        const envToken = Env.get("CLOUDFLARE_API_TOKEN") || Env.get("CF_AIG_TOKEN")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })()

      if (!apiToken) {
        // altimate_change start — branding: altimate auth
        throw new Error(
          "CLOUDFLARE_API_TOKEN (or CF_AIG_TOKEN) is required for Cloudflare AI Gateway. " +
            "Set it via environment variable or run `altimate auth cloudflare-ai-gateway`.",
        )
        // altimate_change end
      }

      // Use official ai-gateway-provider package (v2.x for AI SDK v5 compatibility)
      const { createAiGateway } = await import("ai-gateway-provider")
      const { createUnified } = await import("ai-gateway-provider/providers/unified")

      const metadata = iife(() => {
        if (input.options?.metadata) return input.options.metadata
        try {
          return JSON.parse(input.options?.headers?.["cf-aig-metadata"])
        } catch {
          return undefined
        }
      })
      const opts = {
        metadata,
        cacheTtl: input.options?.cacheTtl,
        cacheKey: input.options?.cacheKey,
        skipCache: input.options?.skipCache,
        collectLog: input.options?.collectLog,
      }

      const aigateway = createAiGateway({
        accountId,
        gateway,
        apiKey: apiToken,
        ...(Object.values(opts).some((v) => v !== undefined) ? { options: opts } : {}),
      })
      // altimate_change start — upstream_fix: pass Cloudflare API token through to unified provider calls
      const unified = createUnified({ apiKey: apiToken })
      // altimate_change end

      return {
        autoload: true,
        async getModel(_sdk: any, modelID: string, _options?: Record<string, any>) {
          // Model IDs use Unified API format: provider/model (e.g., "anthropic/claude-sonnet-4-5")
          return aigateway(unified(modelID))
        },
        options: {},
      }
    },
    cerebras: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "opencode",
          },
        },
      }
    },
    kilo: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://altimate.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
    // altimate_change start — snowflake cortex provider loader
    "snowflake-cortex": async () => {
      const auth = await Auth.get("snowflake-cortex")
      if (auth?.type !== "oauth") return { autoload: false }
      const account = auth.accountId ?? Env.get("SNOWFLAKE_ACCOUNT")
      if (!account || !VALID_ACCOUNT_RE.test(account)) return { autoload: false }
      return {
        autoload: true,
        options: {
          baseURL: `https://${account}.snowflakecomputing.com/api/v2/cortex/v1`,
        },
      }
    },
    // altimate_change end
    // altimate_change start — databricks provider loader
    databricks: async () => {
      const auth = await Auth.get("databricks")
      if (auth?.type !== "oauth") {
        // Fall back to env-based config
        const host = Env.get("DATABRICKS_HOST")
        const token = Env.get("DATABRICKS_TOKEN")
        if (!host || !token) return { autoload: false }
        // altimate_change start — validate DATABRICKS_HOST env to prevent SSRF/CRLF injection
        if (!isValidDatabricksHost(host)) return { autoload: false }
        // altimate_change end
        return {
          autoload: true,
          options: {
            baseURL: `https://${host}/serving-endpoints`,
            apiKey: token,
          },
        }
      }
      const host = auth.accountId ?? Env.get("DATABRICKS_HOST")
      // altimate_change start — validate host (auth file or env fallback) to prevent SSRF
      if (!host || !isValidDatabricksHost(host)) return { autoload: false }
      // altimate_change end
      return {
        autoload: true,
        options: {
          baseURL: `https://${host}/serving-endpoints`,
        },
      }
    },
    // altimate_change end
    // altimate_change start — DigitalOcean env/auth loader with cached inference routers
    digitalocean: async (input) => {
      const env = Env.all()
      const auth = await Auth.get(input.id)
      const routers = auth?.type === "api" ? parseDigitalOceanRouters(auth.metadata) : []
      for (const router of routers) {
        const model = digitalOceanRouterModel(router)
        if (!input.models[model.id]) input.models[model.id] = model
      }

      const apiKey = env["DIGITALOCEAN_ACCESS_TOKEN"] ?? (auth?.type === "api" ? auth.key : undefined)
      return {
        autoload: Boolean(apiKey || routers.length),
        options: {
          baseURL: DIGITALOCEAN_INFERENCE_BASE,
          ...(apiKey ? { apiKey } : {}),
        },
      }
    },
    // altimate_change end
  }

  export const Model = z
    .object({
      id: ModelID.zod,
      providerID: ProviderID.zod,
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning", "reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: ProviderID.zod,
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: ModelID.make(model.id),
      providerID: ProviderID.make(provider.id),
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: model.provider?.api ?? provider.api!,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        experimentalOver200K: model.cost?.context_over_200k
          ? {
              cache: {
                read: model.cost.context_over_200k.cache_read ?? 0,
                write: model.cost.context_over_200k.cache_write ?? 0,
              },
              input: model.cost.context_over_200k.input,
              output: model.cost.context_over_200k.output,
            }
          : undefined,
      },
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
      variants: {},
    }

    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: ProviderID.make(provider.id),
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
    }
  }

  const state = Instance.state(async () => {
    using _ = log.time("state")
    const config = await Config.get()
    const modelsDev = await ModelsDev.get()
    const database = mapValues(modelsDev, fromModelsDevProvider)

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null

    function isProviderAllowed(providerID: ProviderID): boolean {
      if (enabled && !enabled.has(providerID)) return false
      if (disabled.has(providerID)) return false
      return true
    }

    const providers: { [providerID: string]: Info } = {}
    const languages = new Map<string, LanguageModelV2>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const varsLoaders: {
      [providerID: string]: CustomVarsLoader
    } = {}
    const sdk = new Map<string, SDK>()

    log.info("init")

    // altimate_change start — free-tier config is dropped AT INGESTION, not at each consumer.
    //
    // A project-local `opencode.json` is attacker-controlled: any repository the user opens ships
    // one. For `altimate-free` that config would steer a stored credential — where it is sent
    // (`options.baseURL`, `headers`), which MODULE receives it (`npm`, `model.provider.npm`, which
    // `getSDK()` imports, so arbitrary code execution), and which model it is spent on (`models`,
    // `variants`).
    //
    // This reopened twice, each time through a field nobody had denied yet: round 1 closed
    // `options.baseURL`, and it came back through `npm`. Guarding consumers one at a time loses
    // that race by construction — while writing this fix a THIRD consumer turned up (the
    // variants/blacklist merge below) that both earlier guards had missed, and the adversarial
    // test caught it only because it asserts the whole class rather than the reported field.
    //
    // So the denial happens here, once, where config is read. Everything downstream inherits it,
    // including consumers that do not exist yet. `configFor` covers the one place that indexes
    // `config.provider` directly instead of iterating this list.
    //
    // Nothing legitimate is lost: the endpoint, model and module all come from the gateway at
    // registration, and local development points at a different gateway via
    // ALTIMATE_FREE_GATEWAY_URL — process environment, which a checked-in file cannot set.
    const configProviderEntries = Object.entries(config.provider ?? {})
    const configProviders = configProviderEntries.filter(([id]) => id !== FreeTier.PROVIDER_ID)
    if (configProviders.length !== configProviderEntries.length)
      log.warn("ignoring config for the free tier provider", { providerID: FreeTier.PROVIDER_ID })
    const configFor = (providerID: string) =>
      providerID === FreeTier.PROVIDER_ID ? undefined : config.provider?.[providerID]
    // altimate_change end

    // Add GitHub Copilot Enterprise provider that inherits from GitHub Copilot
    if (database["github-copilot"]) {
      const githubCopilot = database["github-copilot"]
      database["github-copilot-enterprise"] = {
        ...githubCopilot,
        id: ProviderID.githubCopilotEnterprise,
        name: "GitHub Copilot Enterprise",
        models: mapValues(githubCopilot.models, (model) => ({
          ...model,
          providerID: ProviderID.githubCopilotEnterprise,
        })),
      }
    }

    // altimate_change start — keep DigitalOcean provider tests independent of plugin registry wiring
    if (!database["digitalocean"]) {
      database["digitalocean"] = digitalOceanProviderInfo()
    }
    // altimate_change end

    // altimate_change start — snowflake cortex provider models
    function makeSnowflakeModel(
      id: string,
      name: string,
      limits: { context: number; output: number },
      caps?: { reasoning?: boolean; attachment?: boolean; toolcall?: boolean },
    ): Model {
      const m: Model = {
        id: ModelID.make(id),
        providerID: ProviderID.snowflakeCortex,
        api: {
          id,
          url: "",
          npm: "@ai-sdk/openai-compatible",
        },
        name,
        capabilities: {
          temperature: true,
          reasoning: caps?.reasoning ?? false,
          attachment: caps?.attachment ?? false,
          toolcall: caps?.toolcall ?? true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: limits.context, output: limits.output },
        status: "active" as const,
        options: {},
        headers: {},
        release_date: "2024-01-01",
        variants: {},
      }
      m.variants = mapValues(ProviderTransform.variants(m), (v) => v)
      return m
    }

    // Snowflake Cortex models are hardcoded rather than auto-discovered.
    // Cortex's models endpoint (`GET /api/v2/cortex/v1/models`) has
    // non-standard semantics — it requires a JSON body on GET, which breaks
    // standard OpenAI-compatible clients. Until that gets a probe-able shim,
    // the source of truth for "what's selectable" is this map. New models
    // surfaced on Snowflake's regional availability docs should be added here
    // (or registered via `altimate-code.json` per the
    // `docs/docs/configure/providers.md` escape-hatch section).
    database["snowflake-cortex"] = {
      id: ProviderID.snowflakeCortex,
      source: "custom",
      name: "Snowflake Cortex",
      env: [],
      options: {},
      models: {
        // Catalog verified live against a Cortex account on 2026-07-20 (each ID
        // probed via /chat/completions). Removed IDs returned "unknown model"
        // (delisted: claude-3-7-sonnet, claude-3-5-sonnet, openai-gpt-5-chat,
        // openai-gpt-oss-120b, llama4-scout, snowflake-llama-3.1-405b,
        // mixtral-8x7b, gemini-3.1-pro) or an explicit "deprecated on
        // July 8, 2026" error (deepseek-r1, mistral-large, llama3.1-405b,
        // snowflake-llama-3.3-70b).
        // Claude models — tool calling supported
        "claude-sonnet-5": makeSnowflakeModel("claude-sonnet-5", "Claude Sonnet 5", {
          context: 1000000,
          output: 64000,
        }),
        "claude-opus-4-8": makeSnowflakeModel("claude-opus-4-8", "Claude Opus 4.8", { context: 1000000, output: 128000 }),
        "claude-opus-4-7": makeSnowflakeModel("claude-opus-4-7", "Claude Opus 4.7", { context: 1000000, output: 128000 }),
        "claude-sonnet-4-6": makeSnowflakeModel("claude-sonnet-4-6", "Claude Sonnet 4.6", {
          context: 200000,
          output: 64000,
        }),
        "claude-opus-4-6": makeSnowflakeModel("claude-opus-4-6", "Claude Opus 4.6", { context: 200000, output: 32000 }),
        "claude-sonnet-4-5": makeSnowflakeModel("claude-sonnet-4-5", "Claude Sonnet 4.5", {
          context: 200000,
          output: 64000,
        }),
        "claude-opus-4-5": makeSnowflakeModel("claude-opus-4-5", "Claude Opus 4.5", { context: 200000, output: 32000 }),
        "claude-haiku-4-5": makeSnowflakeModel("claude-haiku-4-5", "Claude Haiku 4.5", {
          context: 200000,
          output: 16000,
        }),
        "claude-4-sonnet": makeSnowflakeModel("claude-4-sonnet", "Claude 4 Sonnet", { context: 200000, output: 64000 }),
        // claude-4-opus: documented but gated (403 "account not allowed" on tested accounts)
        // claude-fable-5: ID recognized (maps to claude-fable-5-global) but
        // "unavailable" on tested accounts — likely gated; add once it opens up.
        // OpenAI models — tool calling supported
        "openai-gpt-4.1": makeSnowflakeModel("openai-gpt-4.1", "OpenAI GPT-4.1", { context: 1047576, output: 32768 }),
        // openai-gpt-5.4 (plain): responds live but not yet in Snowflake's
        // restrictions table; gpt-5 family defaults as best-effort.
        "openai-gpt-5.4": makeSnowflakeModel("openai-gpt-5.4", "OpenAI GPT-5.4", {
          context: 272000,
          output: 8192,
        }),
        "openai-gpt-5.4-mini": makeSnowflakeModel("openai-gpt-5.4-mini", "OpenAI GPT-5.4 Mini", {
          context: 400000,
          output: 128000,
        }),
        "openai-gpt-5.4-nano": makeSnowflakeModel("openai-gpt-5.4-nano", "OpenAI GPT-5.4 Nano", {
          context: 400000,
          output: 128000,
        }),
        // openai-gpt-5.2 / 5.1: not in Snowflake's per-model restrictions table;
        // gpt-5 family defaults as best-effort until docs publish exact limits.
        "openai-gpt-5.2": makeSnowflakeModel("openai-gpt-5.2", "OpenAI GPT-5.2", {
          context: 272000,
          output: 8192,
        }),
        "openai-gpt-5.1": makeSnowflakeModel("openai-gpt-5.1", "OpenAI GPT-5.1", {
          context: 272000,
          output: 8192,
        }),
        "openai-gpt-5": makeSnowflakeModel("openai-gpt-5", "OpenAI GPT-5", { context: 1047576, output: 32768 }),
        "openai-gpt-5-mini": makeSnowflakeModel("openai-gpt-5-mini", "OpenAI GPT-5 Mini", {
          context: 1047576,
          output: 32768,
        }),
        "openai-gpt-5-nano": makeSnowflakeModel("openai-gpt-5-nano", "OpenAI GPT-5 Nano", {
          context: 1047576,
          output: 32768,
        }),
        // Meta Llama — no tool calling
        "llama4-maverick": makeSnowflakeModel(
          "llama4-maverick",
          "Llama 4 Maverick",
          { context: 1048576, output: 4096 },
          { toolcall: false },
        ),
        // llama3.3-70b: region-gated ("enable cross region inference" error on
        // out-of-region accounts) but still a live catalog entry — keep.
        "llama3.3-70b": makeSnowflakeModel(
          "llama3.3-70b",
          "Llama 3.3 70B",
          { context: 128000, output: 8192 },
          { toolcall: false },
        ),
        "llama3.1-70b": makeSnowflakeModel(
          "llama3.1-70b",
          "Llama 3.1 70B",
          { context: 128000, output: 4096 },
          { toolcall: false },
        ),
        "llama3.1-8b": makeSnowflakeModel(
          "llama3.1-8b",
          "Llama 3.1 8B",
          { context: 128000, output: 4096 },
          { toolcall: false },
        ),
        // Mistral — no tool calling
        "mistral-large2": makeSnowflakeModel(
          "mistral-large2",
          "Mistral Large 2",
          { context: 131000, output: 4096 },
          { toolcall: false },
        ),
        "mistral-7b": makeSnowflakeModel(
          "mistral-7b",
          "Mistral 7B",
          { context: 32000, output: 4096 },
          { toolcall: false },
        ),
      },
    }
    // altimate_change end

    // altimate_change start — databricks provider models
    function makeDatabricksModel(
      id: string,
      name: string,
      limits: { context: number; output: number },
      caps?: { reasoning?: boolean; attachment?: boolean; toolcall?: boolean; image?: boolean },
    ): Model {
      const m: Model = {
        id: ModelID.make(id),
        providerID: ProviderID.databricks,
        api: {
          id,
          url: "",
          npm: "@ai-sdk/openai-compatible",
        },
        name,
        capabilities: {
          temperature: true,
          reasoning: caps?.reasoning ?? false,
          attachment: caps?.attachment ?? false,
          toolcall: caps?.toolcall ?? true,
          input: { text: true, audio: false, image: caps?.image ?? false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: limits.context, output: limits.output },
        status: "active" as const,
        options: {},
        headers: {},
        release_date: "2024-01-01",
        variants: {},
      }
      m.variants = mapValues(ProviderTransform.variants(m), (v) => v)
      return m
    }

    database["databricks"] = {
      id: ProviderID.databricks,
      source: "custom",
      name: "Databricks",
      env: ["DATABRICKS_TOKEN"],
      options: {},
      models: {
        // Meta Llama models — tool calling supported
        "databricks-meta-llama-3-1-405b-instruct": makeDatabricksModel(
          "databricks-meta-llama-3-1-405b-instruct",
          "Meta Llama 3.1 405B Instruct",
          { context: 128000, output: 4096 },
        ),
        "databricks-meta-llama-3-1-70b-instruct": makeDatabricksModel(
          "databricks-meta-llama-3-1-70b-instruct",
          "Meta Llama 3.1 70B Instruct",
          { context: 128000, output: 4096 },
        ),
        "databricks-meta-llama-3-1-8b-instruct": makeDatabricksModel(
          "databricks-meta-llama-3-1-8b-instruct",
          "Meta Llama 3.1 8B Instruct",
          { context: 128000, output: 4096 },
        ),
        // Claude models via Databricks AI Gateway
        "databricks-claude-sonnet-4-6": makeDatabricksModel("databricks-claude-sonnet-4-6", "Claude Sonnet 4.6", {
          context: 200000,
          output: 64000,
        }),
        "databricks-claude-opus-4-6": makeDatabricksModel("databricks-claude-opus-4-6", "Claude Opus 4.6", {
          context: 200000,
          output: 32000,
        }),
        // GPT models via Databricks AI Gateway
        "databricks-gpt-5-4": makeDatabricksModel("databricks-gpt-5-4", "GPT-5-4", { context: 128000, output: 16384 }),
        "databricks-gpt-5-mini": makeDatabricksModel("databricks-gpt-5-mini", "GPT-5 Mini", {
          context: 128000,
          output: 16384,
        }),
        // Gemini models via Databricks AI Gateway
        "databricks-gemini-3-1-pro": makeDatabricksModel("databricks-gemini-3-1-pro", "Gemini 3.1 Pro", {
          context: 1000000,
          output: 8192,
        }),
        // DBRX — Databricks native model
        "databricks-dbrx-instruct": makeDatabricksModel("databricks-dbrx-instruct", "DBRX Instruct", {
          context: 32768,
          output: 4096,
        }),
        // Mixtral via Databricks
        "databricks-mixtral-8x7b-instruct": makeDatabricksModel(
          "databricks-mixtral-8x7b-instruct",
          "Mixtral 8x7B Instruct",
          { context: 32768, output: 4096 },
          { toolcall: false },
        ),
      },
    }
    // altimate_change end

    // altimate_change start — register altimate-backend as an OpenAI-compatible provider
    if (!database["altimate-backend"]) {
      const backendModels: Record<string, Model> = {
        // ID "altimate-default" is kept for backward compatibility — existing
        // users have it persisted in their model.json favorites/recents and in
        // opencode.json `model:` entries. Display name ("Altimate LLM Gateway")
        // is what the TUI actually shows, so branding stays correct.
        "altimate-default": {
          id: ModelID.make("altimate-default"),
          providerID: ProviderID.make("altimate-backend"),
          name: "Altimate LLM Gateway",
          family: "openai",
          api: { id: "altimate-default", url: "", npm: "@ai-sdk/openai-compatible" },
          status: "active",
          headers: {},
          options: {},
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200000, output: 128000 },
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          release_date: "2025-01-01",
          variants: {},
        },
      }
      database["altimate-backend"] = {
        id: ProviderID.make("altimate-backend"),
        // altimate_change start — rebranded display name: "Altimate" → "Altimate AI"
        name: "Altimate AI",
        // altimate_change end
        source: "custom",
        env: [],
        options: {},
        models: backendModels,
      }
    }
    // altimate_change end

    // altimate_change start — register altimate-free, the $0 hosted Gemini Flash tier.
    // Cost is zero everywhere: the model is funded by us, so a non-zero entry would show
    // users a spend figure for tokens they are not billed for.
    //
    // UNCONDITIONAL, deliberately. This used to be `if (!database["altimate-free"])`, which let
    // a ModelsDev/registry record of that name win and define the provider instead — supplying
    // `npm` (the module getSDK() imports and hands the stored free key to), the API url, headers,
    // options, models or env. Same credential-exfiltration class as the project-config route,
    // arriving from the other input: the bundled snapshot has no such record today, but this data
    // is refreshed from the network at runtime, so "no collision today" is not a property we
    // control. Ours is the pinned record and it always wins.
    {
      const freeModels: Record<string, Model> = {
        [FreeTier.MODEL_ID]: {
          id: ModelID.make(FreeTier.MODEL_ID),
          providerID: ProviderID.make(FreeTier.PROVIDER_ID),
          name: "Gemini Flash (Free)",
          family: "openai",
          api: { id: FreeTier.MODEL_ID, url: "", npm: "@ai-sdk/openai-compatible" },
          status: "active",
          headers: {},
          options: {},
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 1_048_576, output: 16_384 },
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          release_date: "2026-08-06",
          variants: {},
        },
      }
      database["altimate-free"] = {
        id: ProviderID.make(FreeTier.PROVIDER_ID),
        name: "Altimate Free",
        source: "custom",
        env: [],
        options: {},
        models: freeModels,
      }
    }
    // altimate_change end

    function mergeProvider(providerID: ProviderID, provider: Partial<Info>) {
      const existing = providers[providerID]
      if (existing) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerID]
      if (!match) return
      // @ts-expect-error
      providers[providerID] = mergeDeep(match, provider)
    }

    // extend database from config
    for (const [providerID, provider] of configProviders) {
      // altimate_change start — the free tier is not configurable, and this is the FIRST place
      // that has to enforce it. The guard further down (the "load config" loop) runs after the
      // loaders and only covers env/name/options; this loop builds the whole database entry, so
      // everything below was reachable from a project-local config file:
      //
      //   provider.npm / model.provider.npm   the MODULE getSDK() imports and hands the stored
      //                                       API key to — arbitrary code execution plus
      //                                       credential disclosure, no URL involved
      //   api url / headers / options         where the key and the prompt are sent
      //   models / variants                   which model id the credential is spent on
      //
      // Round 1 closed the baseURL route and round 2 closed nothing here, so the same
      // vulnerability reopened through `npm`. Denying named fields one at a time loses that race
      // by construction: the correct unit is the provider id, and the answer is that NO config
      // input reaches this entry at all. The record is built solely from the gateway's
      // registration response (see the loader above).
      //
      // Nothing legitimate is lost. The endpoint and model come from the gateway at
      // registration; local development points at a different gateway with
      // ALTIMATE_FREE_GATEWAY_URL, which is process environment and cannot be set by a
      // checked-in file.
      if (providerID === FreeTier.PROVIDER_ID) {
        log.warn("ignoring config override for the free tier provider", { providerID, stage: "database" })
        continue
      }
      // altimate_change end
      const existing = database[providerID]
      const parsed: Info = {
        id: ProviderID.make(providerID),
        name: provider.name ?? existing?.name ?? providerID,
        env: provider.env ?? existing?.env ?? [],
        options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
        source: "config",
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existingModel = parsed.models[model.id ?? modelID]
        const name = iife(() => {
          if (model.name) return model.name
          if (model.id && model.id !== modelID) return modelID
          return existingModel?.name ?? modelID
        })
        const parsedModel: Model = {
          id: ModelID.make(modelID),
          api: {
            id: model.id ?? existingModel?.api.id ?? modelID,
            npm:
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelsDev[providerID]?.npm ??
              "@ai-sdk/openai-compatible",
            url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID: ProviderID.make(providerID),
          capabilities: {
            temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
            reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
            attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
            toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
            input: {
              text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
              audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
              image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
              video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
              pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
            },
            output: {
              text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
              audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
              image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
              video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
              pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
            },
            interleaved: model.interleaved ?? false,
          },
          cost: {
            input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
            output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
            cache: {
              read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
              write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
            },
          },
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          limit: {
            context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
            output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
          },
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          family: model.family ?? existingModel?.family ?? "",
          release_date: model.release_date ?? existingModel?.release_date ?? "",
          variants: {},
        }
        const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
        parsedModel.variants = mapValues(
          pickBy(merged, (v) => !v.disabled),
          (v) => omit(v, ["disabled"]),
        )
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }

    // load env
    const env = Env.all()
    // altimate_change start — skip github-models/github-copilot auto-enable from machine-scoped GITHUB_TOKEN
    // In GitHub Codespaces and GitHub Actions, GITHUB_TOKEN is a machine-scoped
    // token for repo operations, not for model inference. Auto-enabling these
    // providers leads to immediate rate limiting ("Too Many Requests") and long
    // retry loops. We detect these environments and skip auto-enable unless the
    // user has explicitly set a different token.
    //
    // Environment detection (official GitHub docs):
    //   Codespaces: CODESPACES=true, CODESPACE_NAME set
    //   Actions:    GITHUB_ACTIONS=true, CI=true
    //
    // Machine-scoped tokens to ignore: GITHUB_TOKEN and GH_TOKEN (gh CLI alias)
    const isMachineEnv = env["CODESPACES"] === "true" || env["GITHUB_ACTIONS"] === "true"
    const machineTokenNames = new Set(["GITHUB_TOKEN", "GH_TOKEN"])
    const skipGithubProviders = new Set(["github-models", "github-copilot", "github-copilot-enterprise"])
    // altimate_change end
    for (const [id, provider] of Object.entries(database)) {
      const providerID = ProviderID.make(id)
      if (disabled.has(providerID)) continue
      const apiKey = provider.env.map((item) => env[item]).find(Boolean)
      if (!apiKey) continue
      // altimate_change start — skip GitHub providers when only machine-scoped tokens exist
      if (isMachineEnv && skipGithubProviders.has(id)) {
        // Check if ALL env vars for this provider are machine-scoped tokens
        const matchedEnvVars = provider.env.filter((item) => env[item])
        const allMachineScoped = matchedEnvVars.every((item) => machineTokenNames.has(item))
        if (allMachineScoped) {
          log.info("skipping provider in machine environment (token is not for model inference)", {
            providerID,
            environment: env["CODESPACES"] ? "codespace" : "github-actions",
          })
          continue
        }
      }
      // altimate_change end
      mergeProvider(providerID, {
        source: "env",
        key: provider.env.length === 1 ? apiKey : undefined,
      })
    }

    // load apikeys
    for (const [id, provider] of Object.entries(await Auth.all())) {
      const providerID = ProviderID.make(id)
      if (disabled.has(providerID)) continue
      if (provider.type === "api") {
        // altimate_change start — an empty key is not a credential, and for the free tier it is
        // a specific, expected state: the install secret is persisted BEFORE registration so a
        // lost response can be retried against the same gateway principal, which leaves
        // `{ key: "", metadata: { install_secret } }` behind whenever registration fails.
        //
        // Merging that here created `providers["altimate-free"]`, and once the entry exists the
        // CUSTOM_LOADERS block below merges it regardless of `autoload`, because its condition
        // is `result.autoload || providers[providerID]`. The loader's "no, I am not registered"
        // answer could no longer remove it, so a user whose registration got a 503 saw the free
        // provider listed as connected after the next restart — and selecting it would send an
        // empty bearer token.
        if (!provider.key) continue
        // altimate_change end
        mergeProvider(providerID, {
          source: "api",
          key: provider.key,
        })
      }
    }

    for (const plugin of await Plugin.list()) {
      if (!plugin.auth) continue
      const providerID = ProviderID.make(plugin.auth.provider)
      if (disabled.has(providerID)) continue

      // For github-copilot plugin, check if auth exists for either github-copilot or github-copilot-enterprise
      let hasAuth = false
      const auth = await Auth.get(providerID)
      if (auth) hasAuth = true

      // Special handling for github-copilot: also check for enterprise auth
      if (providerID === ProviderID.githubCopilot && !hasAuth) {
        const enterpriseAuth = await Auth.get("github-copilot-enterprise")
        if (enterpriseAuth) hasAuth = true
      }

      if (!hasAuth) continue
      if (!plugin.auth.loader) continue

      // Load for the main provider if auth exists
      if (auth) {
        const options = await plugin.auth.loader(() => Auth.get(providerID) as any, database[plugin.auth.provider])
        const opts = options ?? {}
        const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
        mergeProvider(providerID, patch)
      }

      // If this is github-copilot plugin, also register for github-copilot-enterprise if auth exists
      if (providerID === ProviderID.githubCopilot) {
        const enterpriseProviderID = ProviderID.githubCopilotEnterprise
        if (!disabled.has(enterpriseProviderID)) {
          const enterpriseAuth = await Auth.get(enterpriseProviderID)
          if (enterpriseAuth) {
            const enterpriseOptions = await plugin.auth.loader(
              () => Auth.get(enterpriseProviderID) as any,
              database[enterpriseProviderID],
            )
            const opts = enterpriseOptions ?? {}
            const patch: Partial<Info> = providers[enterpriseProviderID]
              ? { options: opts }
              : { source: "custom", options: opts }
            mergeProvider(enterpriseProviderID, patch)
          }
        }
      }
    }

    for (const [id, fn] of Object.entries(CUSTOM_LOADERS)) {
      const providerID = ProviderID.make(id)
      if (disabled.has(providerID)) continue
      const data = database[providerID]
      if (!data) {
        log.error("Provider does not exist in model list " + providerID)
        continue
      }
      const result = await fn(data)
      if (result && (result.autoload || providers[providerID])) {
        if (result.getModel) modelLoaders[providerID] = result.getModel
        if (result.vars) varsLoaders[providerID] = result.vars
        const opts = result.options ?? {}
        const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
        mergeProvider(providerID, patch)
      }
    }

    // load config
    for (const [id, provider] of configProviders) {
      const providerID = ProviderID.make(id)
      // altimate_change start — the free tier is not configurable, and this merge is why.
      // It runs AFTER the loaders, so a `provider["altimate-free"].options.baseURL` in a config
      // file overrides the endpoint the credential was issued for — and a config file can be
      // project-local, i.e. supplied by any repository the user opens. The stored key, the
      // prompt and the session id would then be sent to whatever origin that repo chose.
      // Nothing legitimate needs this: the endpoint comes from the gateway at registration, and
      // local development points at another gateway with ALTIMATE_FREE_GATEWAY_URL, which a
      // checked-in file cannot set.
      if (id === FreeTier.PROVIDER_ID) {
        log.warn("ignoring config override for the free tier provider", { providerID })
        continue
      }
      // altimate_change end
      const partial: Partial<Info> = { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (provider.options) partial.options = provider.options
      mergeProvider(providerID, partial)
    }

    for (const [id, provider] of Object.entries(providers)) {
      const providerID = ProviderID.make(id)
      if (!isProviderAllowed(providerID)) {
        delete providers[providerID]
        continue
      }

      // altimate_change start — configFor, not config.provider: the free tier is denied at
      // ingestion and this is the one consumer that indexes the map directly. Covers blacklist,
      // whitelist and the per-model variants merge below.
      const configProvider = configFor(providerID)
      // altimate_change end

      for (const [modelID, model] of Object.entries(provider.models)) {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (
          modelID === "gpt-5-chat-latest" ||
          (providerID === ProviderID.openrouter && modelID === "openai/gpt-5-chat")
        )
          delete provider.models[modelID]
        if (model.status === "alpha" && !Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
        if (model.status === "deprecated") delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        )
          delete provider.models[modelID]

        model.variants = mapValues(ProviderTransform.variants(model), (v) => v)

        // Filter out disabled variants from config
        const configVariants = configProvider?.models?.[modelID]?.variants
        if (configVariants && model.variants) {
          const merged = mergeDeep(model.variants, configVariants)
          model.variants = mapValues(
            pickBy(merged, (v) => !v.disabled),
            (v) => omit(v, ["disabled"]),
          )
        }
      }

      if (Object.keys(provider.models).length === 0) {
        delete providers[providerID]
        continue
      }

      log.info("found", { providerID })
    }

    return {
      models: languages,
      providers,
      // altimate_change start — expose full provider database (including unauthenticated custom providers)
      database,
      // altimate_change end
      sdk,
      modelLoaders,
      varsLoaders,
    }
  })

  export async function list() {
    return state().then((state) => state.providers)
  }

  // altimate_change start — expose full provider database (including unauthenticated custom providers)
  export async function all() {
    return state().then((state) => state.database)
  }
  // altimate_change end

  async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
      const options = { ...provider.options }

      if (model.providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
        delete options.fetch
      }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      const baseURL = iife(() => {
        let url =
          typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
        if (!url) return

        // some models/providers have variable urls, ex: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1"
        // We track this in models.dev, and then when we are resolving the baseURL
        // we need to string replace that literal: "${AZURE_RESOURCE_NAME}"
        const loader = s.varsLoaders[model.providerID]
        if (loader) {
          const vars = loader(options)
          for (const [key, value] of Object.entries(vars)) {
            const field = "${" + key + "}"
            url = url.replaceAll(field, value)
          }
        }

        url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
          const val = Env.get(String(key))
          return val ?? item
        })
        return url
      })

      if (baseURL !== undefined) options["baseURL"] = baseURL
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }

      const key = Hash.fast(JSON.stringify({ providerID: model.providerID, npm: model.api.npm, options }))
      const existing = s.sdk.get(key)
      if (existing) return existing

      const customFetch = options["fetch"]
      const chunkTimeout = options["chunkTimeout"] || DEFAULT_CHUNK_TIMEOUT
      const headerTimeout = options["headerTimeout"]
      delete options["chunkTimeout"]
      delete options["headerTimeout"]

      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        // Preserve custom fetch if it exists, wrap it with timeout logic
        const fetchFn = customFetch ?? fetch
        const opts = init ?? {}
        const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
        // altimate_change start — header timeout aborts only until response headers arrive
        const headerTimeoutMs =
          headerTimeout === false || customFetch?.[HEADER_TIMEOUT] === false ? undefined : headerTimeout
        const headerTimeoutCtl =
          typeof headerTimeoutMs === "number" && headerTimeoutMs > 0 ? timeoutController(headerTimeoutMs) : undefined
        // altimate_change end
        const signals: AbortSignal[] = []

        if (opts.signal) signals.push(opts.signal)
        if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
        if (headerTimeoutCtl) signals.push(headerTimeoutCtl.signal)
        if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
          signals.push(AbortSignal.timeout(options["timeout"]))

        const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
        if (combined) opts.signal = combined

        // Strip openai itemId metadata following what codex does
        // Codex uses #[serde(skip_serializing)] on id fields for all item types:
        // Message, Reasoning, FunctionCall, LocalShellCall, CustomToolCall, WebSearchCall
        // IDs are only re-attached for Azure with store=true
        if (
          (model.api.npm === "@ai-sdk/openai" ||
            model.api.npm === "@ai-sdk/azure" ||
            model.api.npm === "@ai-sdk/amazon-bedrock/mantle") &&
          opts.body &&
          opts.method === "POST"
        ) {
          const body = JSON.parse(opts.body as string)
          const isAzure = model.providerID.includes("azure")
          const keepIds = isAzure && body.store === true
          if (!keepIds && Array.isArray(body.input)) {
            for (const item of body.input) {
              if ("id" in item) {
                delete item.id
              }
            }
            opts.body = JSON.stringify(body)
          }
        }

        const res = await (async () =>
          fetchFn(input, {
            ...opts,
            // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
            timeout: false,
          }))().finally(() => headerTimeoutCtl?.clear())

        if (!chunkAbortCtl) return res
        return wrapSSE(res, chunkTimeout, chunkAbortCtl)
      }

      const bundledFn = BUNDLED_PROVIDERS[model.api.npm]
      if (bundledFn) {
        log.info("using bundled provider", { providerID: model.providerID, pkg: model.api.npm })
        const loaded = bundledFn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded as SDK
      }

      let installedPath: string
      if (!model.api.npm.startsWith("file://")) {
        installedPath = await BunProc.install(model.api.npm, "latest")
      } else {
        log.info("loading local provider", { pkg: model.api.npm })
        installedPath = model.api.npm
      }

      const mod = await import(installedPath)

      const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
      const loaded = fn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, loaded)
      return loaded as SDK
    } catch (e) {
      throw new InitError({ providerID: model.providerID }, { cause: e })
    }
  }

  export async function getProvider(providerID: ProviderID) {
    return state().then((s) => s.providers[providerID])
  }

  export async function getModel(providerID: ProviderID, modelID: ModelID) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return info
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const key = `${model.providerID}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerID]
    const sdk = await getSDK(model)

    try {
      const language = s.modelLoaders[model.providerID]
        ? await s.modelLoaders[model.providerID](sdk, model.api.id, { ...provider.options, ...model.options }, model)
        : sdk.languageModel(model.api.id)
      s.models.set(key, language)
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerID: model.providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  export async function closest(providerID: ProviderID, query: string[]) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item))
          return {
            providerID,
            modelID,
          }
      }
    }
  }

  export async function getSmallModel(providerID: ProviderID) {
    const cfg = await Config.get()

    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      return getModel(parsed.providerID, parsed.modelID)
    }

    const provider = await state().then((state) => state.providers[providerID])
    if (provider) {
      let priority = [
        "claude-haiku-4-5",
        "claude-haiku-4.5",
        "3-5-haiku",
        "3.5-haiku",
        "gemini-3-flash",
        "gemini-2.5-flash",
        "gpt-5-nano",
      ]
      if (providerID.startsWith("opencode")) {
        priority = ["gpt-5-nano"]
      }
      if (providerID.startsWith("github-copilot")) {
        // prioritize free models for github copilot
        priority = ["gpt-5-mini", "claude-haiku-4.5", ...priority]
      }
      for (const item of priority) {
        if (providerID === ProviderID.amazonBedrock) {
          const crossRegionPrefixes = ["global.", "us.", "eu."]
          const candidates = Object.keys(provider.models).filter((m) => m.includes(item))

          // Model selection priority:
          // 1. global. prefix (works everywhere)
          // 2. User's region prefix (us., eu.)
          // 3. Unprefixed model
          const globalMatch = candidates.find((m) => m.startsWith("global."))
          if (globalMatch) return getModel(providerID, ModelID.make(globalMatch))

          const region = provider.options?.region
          if (region) {
            const regionPrefix = region.split("-")[0]
            if (regionPrefix === "us" || regionPrefix === "eu") {
              const regionalMatch = candidates.find((m) => m.startsWith(`${regionPrefix}.`))
              if (regionalMatch) return getModel(providerID, ModelID.make(regionalMatch))
            }
          }

          const unprefixed = candidates.find((m) => !crossRegionPrefixes.some((p) => m.startsWith(p)))
          if (unprefixed) return getModel(providerID, ModelID.make(unprefixed))
        } else {
          for (const model of Object.keys(provider.models)) {
            if (model.includes(item)) return getModel(providerID, ModelID.make(model))
          }
        }
      }
    }

    return undefined
  }

  const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
  export function sort<T extends { id: string }>(models: T[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export async function defaultModel() {
    const cfg = await Config.get()
    if (cfg.model) return parseModel(cfg.model)

    const providers = await list()
    const recent = (await Filesystem.readJson<{ recent?: { providerID: ProviderID; modelID: ModelID }[] }>(
      path.join(Global.Path.state, "model.json"),
    )
      .then((x) => (Array.isArray(x.recent) ? x.recent : []))
      .catch(() => [])) as { providerID: ProviderID; modelID: ModelID }[]
    for (const entry of recent) {
      const provider = providers[entry.providerID]
      if (!provider) continue
      if (!provider.models[entry.modelID]) continue
      return { providerID: entry.providerID, modelID: entry.modelID }
    }

    // altimate_change start — default to altimate-backend when configured and no model chosen yet
    const altimateProviderID = ProviderID.make("altimate-backend")
    const altimateProvider = providers[altimateProviderID]
    if (
      altimateProvider &&
      altimateProvider.models[ModelID.make("altimate-default")] &&
      (!cfg.provider || Object.keys(cfg.provider).includes(String(altimateProviderID)))
    ) {
      // altimate_change start — log when altimate-backend auto-selected
      log.info("defaulting to altimate-backend/altimate-default (no model configured)")
      // altimate_change end
      return {
        providerID: altimateProviderID,
        modelID: ModelID.make("altimate-default"),
      }
    }
    // altimate_change end

    // altimate_change start — pick from the SANITIZED config view, same as everywhere else.
    // This predicate reads `cfg.provider` raw, and it is the one place free-tier config still had
    // an effect: a repo shipping nothing but a `provider["altimate-free"]` entry — ignored for
    // npm/url/headers/models — still narrowed this list to that one id and made the free provider
    // the automatic default, routing the user's prompts through it without them choosing it.
    // Excluding it here restores the intent: a config entry for the free tier does nothing at all.
    //
    // An empty list after the exclusion means "no usable provider config", which must behave the
    // same as no `provider` block at all — otherwise this find returns nothing and the caller
    // throws "no providers found". The free provider can still be chosen when it is simply the
    // only one present; what it can no longer do is be SELECTED BY config.
    const configuredProviderIDs = Object.keys(cfg.provider ?? {}).filter((id) => id !== FreeTier.PROVIDER_ID)
    const provider = Object.values(providers).find(
      (p) => configuredProviderIDs.length === 0 || configuredProviderIDs.includes(p.id),
    )
    // altimate_change end
    if (!provider) throw new Error("no providers found")
    const [model] = sort(Object.values(provider.models))
    if (!model) throw new Error("no models found")
    return {
      providerID: provider.id,
      modelID: model.id,
    }
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: ProviderID.make(providerID),
      modelID: ModelID.make(rest.join("/")),
    }
  }

  export const ModelNotFoundError = NamedError.create("ProviderModelNotFoundError", {
    providerID: ProviderID,
    modelID: ModelID,
    suggestions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  })

  export const InitError = NamedError.create("ProviderInitError", {
    providerID: ProviderID,
  })

  // altimate_change start — upstream httpapi additions consumed by the experimental
  // provider handler/group and the debug agent CLI. NoModelsError mirrors the plain
  // "no models found" throw in defaultModel(); toPublicInfo/defaultModelIDs/ListResult
  // back the provider.list HttpApi endpoint (behavior matches the legacy Hono route:
  // `all` is the Info list verbatim, `default` is the top-sorted model id per provider).
  export const NoModelsError = NamedError.create("ProviderNoModelsError", {
    providerID: ProviderID,
  })

  /** Public projection of a provider Info for the list endpoint (identity today). */
  export function toPublicInfo(info: Info): Info {
    return info
  }

  /** Map of providerID -> default (top-sorted) model id, skipping providers with no models. */
  export function defaultModelIDs(providers: Record<string, Info>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, provider] of Object.entries(providers)) {
      const [model] = sort(Object.values(provider.models))
      if (model) out[key] = model.id
    }
    return out
  }

  /**
   * Effect Schema for the provider.list response. The `all` element reuses the fork's
   * rich zod `Info` validator via Schema.declare (same recipe as tool-zod-compat) so the
   * effect HttpApi layer gets correct types without hand-mirroring the model schema.
   */
  const InfoSchema = Schema.declare<Info>((u): u is Info => Info.safeParse(u).success)
  export const ListResult = Schema.Struct({
    all: Schema.Array(InfoSchema),
    default: Schema.Record(Schema.String, Schema.String),
    connected: Schema.Array(Schema.String),
  }).annotate({ identifier: "ProviderListResult" })
  export type ListResult = Schema.Schema.Type<typeof ListResult>
  // altimate_change end

  // altimate_change start — Effect Context.Service facade over the existing namespace
  // functions. New upstream consumers compose Provider into the Effect runtime via
  // `yield* Provider.Service` / `Provider.defaultLayer` / `Provider.node`. This is a
  // thin facade: every method delegates to the existing Promise-returning namespace
  // function above (which self-manages Instance state), so behavior is unchanged. The
  // imperative wrappers (list/getModel/getLanguage/defaultModel/...) remain exported
  // for the fork's synchronous callers.
  export interface Interface {
    readonly list: () => Effect.Effect<Record<ProviderID, Info>>
    readonly getProvider: (providerID: ProviderID) => Effect.Effect<Info>
    readonly getModel: (providerID: ProviderID, modelID: ModelID) => Effect.Effect<Model>
    readonly getLanguage: (model: Model) => Effect.Effect<LanguageModelV2>
    readonly closest: (
      providerID: ProviderID,
      query: string[],
    ) => Effect.Effect<{ providerID: ProviderID; modelID: string } | undefined>
    readonly getSmallModel: (providerID: ProviderID) => Effect.Effect<Model | undefined>
    readonly defaultModel: () => Effect.Effect<{ providerID: ProviderID; modelID: ModelID }>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Provider") {}

  // Failure type surfaced by the resolved service (consumers narrow with `instanceof`).
  // `defaultModel`/`getModel`/`getLanguage` reject with `ModelNotFoundError` or a plain
  // `Error` ("no providers found" / "no models found"); callers cast the squashed cause
  // to this union before narrowing.
  export type DefaultModelError = InstanceType<typeof ModelNotFoundError> | Error

  // altimate_change start — Provider.Service delegates to legacy Promise functions that read Instance.directory
  const withLegacyInstance = <A>(fn: () => Promise<A>) =>
    Effect.gen(function* () {
      const ctx = yield* InstanceRef
      return yield* Effect.promise(() => (ctx ? Instance.restore(ctx, fn) : fn()))
    })

  export const layer = Layer.succeed(
    Service,
    Service.of({
      list: () => withLegacyInstance(() => list()),
      getProvider: (providerID) => withLegacyInstance(() => getProvider(providerID)),
      getModel: (providerID, modelID) => withLegacyInstance(() => getModel(providerID, modelID)),
      getLanguage: (model) => withLegacyInstance(() => getLanguage(model)),
      closest: (providerID, query) => withLegacyInstance(() => closest(providerID, query)),
      getSmallModel: (providerID) => withLegacyInstance(() => getSmallModel(providerID)),
      defaultModel: () => withLegacyInstance(() => defaultModel()),
    }),
  )
  // altimate_change end

  export const defaultLayer = layer

  export const node = LayerNode.make(layer, [])

  // Effect accessor over the Service (mirrors Env.use): `Provider.use.list()`
  // returns an Effect requiring `Provider.Service` in R. Used by tests/consumers
  // that compose Provider into an Effect runtime via `Provider.defaultLayer`.
  export const use = serviceUse(Service)
  // altimate_change end
}
