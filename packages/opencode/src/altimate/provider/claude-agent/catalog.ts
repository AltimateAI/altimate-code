export * as ClaudeAgentCatalog from "./catalog"

import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk"
import { Option, Schema } from "effect"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import type { ClaudeProbe } from "./claude/probe"
import { ClaudeAgentID } from "./id"
import { ClaudeAgentStorage } from "./storage"

// Ported from upstream `claude-agent/provider.ts`: the model list kept between starts, so the CLI
// can list Claude models without running `claude`.
const CatalogModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  efforts: Schema.Array(Schema.String),
  contextWindow: Schema.optionalKey(Schema.Number),
  resolvedModel: Schema.optionalKey(Schema.String),
})
type CatalogModel = typeof CatalogModel.Type
const Catalog = Schema.Struct({
  priceSource: Schema.optionalKey(Schema.String),
  models: Schema.Array(CatalogModel),
})
export type Catalog = typeof Catalog.Type
const KEY = "models"

// Before the first `claude` start reports its models. Claude Code resolves these aliases to its
// current models, so they stay valid as Anthropic ships new ones.
const FALLBACK: readonly CatalogModel[] = [
  { id: "opus", name: "Opus", efforts: [] },
  { id: "sonnet", name: "Sonnet", efforts: [] },
  { id: "haiku", name: "Haiku", efforts: [] },
]

const DEFAULT_CONTEXT = 200_000
const DEFAULT_OUTPUT = 32_000

// Mantle is Bedrock serving Anthropic's API, and Bedrock's list drops most `anthropic.…` IDs,
// so it uses Anthropic's prices.
const PRICE_SOURCES: Partial<Record<NonNullable<AccountInfo["apiProvider"]>, string>> = {
  firstParty: "anthropic",
  anthropicAws: "anthropic",
  anthropicGoogleCloud: "anthropic",
  mantle: "anthropic",
  bedrock: "amazon-bedrock",
  vertex: "google-vertex",
  foundry: "azure",
}

export async function load(): Promise<Catalog> {
  const saved = Schema.decodeUnknownOption(Catalog)(await ClaudeAgentStorage.read(KEY))
  return Option.getOrElse(saved, (): Catalog => ({ models: [] }))
}

// Saves what a probe or a chat's startup reported. Returns whether the list changed, so the
// caller knows the provider list needs a reload to show it.
export async function update(probe: ClaudeProbe.Result, baseURL: string | undefined) {
  const current = await load()
  const source = priceSource(probe.account, baseURL)
  const next: Catalog = {
    ...(source ? { priceSource: source } : {}),
    models: fromClaude(probe.models, current.models),
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return false
  await ClaudeAgentStorage.write(KEY, next)
  return true
}

export function provider(
  catalog: Catalog,
  database: Readonly<Record<string, { readonly models: Readonly<Record<string, Provider.Model>> }>>,
): Provider.Info {
  const prices = catalog.priceSource ? database[catalog.priceSource]?.models : undefined
  const models = catalog.models.length > 0 ? catalog.models : FALLBACK
  return {
    id: ProviderID.make(ClaudeAgentID.ID),
    name: "Claude Agent",
    source: "custom",
    env: [],
    options: {},
    models: Object.fromEntries(models.map((model) => [model.id, toModel(model, prices)])),
  }
}

// Context windows only come from the full probe, so a chat's startup report keeps the saved ones.
function fromClaude(models: readonly ClaudeProbe.Model[], saved: readonly CatalogModel[]): CatalogModel[] {
  const known = new Map<string, number | undefined>()
  for (const model of saved) known.set(model.id, model.contextWindow)
  const result: CatalogModel[] = []
  for (const model of models) {
    // "default" follows Claude Code's own default, which can change under a running session.
    if (model.value === "default") continue
    const contextWindow = model.contextWindow ?? known.get(model.value)
    result.push({
      id: model.value,
      name: model.displayName,
      efforts: model.supportedEffortLevels ?? [],
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    })
  }
  return result
}

// A subscription covers usage, and a custom base URL or an enterprise gateway can bill anything,
// so they show no cost.
function priceSource(account: AccountInfo, baseURL: string | undefined) {
  if (baseURL) return
  if (account.apiProvider === undefined) return
  if (account.apiProvider === "firstParty" && account.apiKeySource === undefined) return
  return PRICE_SOURCES[account.apiProvider]
}

function toModel(model: CatalogModel, prices: Readonly<Record<string, Provider.Model>> | undefined): Provider.Model {
  // The 1M context version's price tiers are on the base model.
  const id = (model.resolvedModel ?? model.id).replace(/\[1m\]$/, "")
  // Mantle names models `anthropic.claude-…`, and Vertex lists current models as `claude-…@default`.
  const priced = prices?.[id] ?? prices?.[id.replace(/^anthropic\./, "")] ?? prices?.[`${id}@default`]
  return {
    id: ModelID.make(model.id),
    providerID: ProviderID.make(ClaudeAgentID.ID),
    api: { id: model.id, url: "", npm: ClaudeAgentID.PACKAGE },
    name: model.name,
    family: model.id.includes("haiku") ? "claude-haiku" : undefined,
    capabilities: {
      // Claude Code sets sampling itself; temperature, top-p and top-k are not passed through.
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: priced?.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // The SDK reports context windows before a prompt, but not output limits.
    limit: { context: model.contextWindow ?? DEFAULT_CONTEXT, output: priced?.limit.output ?? DEFAULT_OUTPUT },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    variants: Object.fromEntries(model.efforts.map((effort) => [effort, { effort }])),
  }
}
