import { createHash } from "node:crypto"
import fs from "node:fs/promises"

import snapshot from "./recipes.json"
import { ensureLocalDirectories, getLocalPaths, type LocalPaths } from "./paths"
import { LLAMA_CPP_REF } from "./runtime"

export type ReasoningEffort = "low" | "medium" | "xhigh"

export interface RecipeAgent {
  tool_retrieval: boolean
  reasoning_effort: ReasoningEffort
  temperature: number
}

export interface RecipeMtp {
  file: string
  sha256: string
  draft_max: number
}

export interface LlamaRecipeTier {
  name: string
  min_vram_gb: number
  engine: "llama.cpp"
  quant: string
  file: string
  sha256: string
  ctx: number
  parallel: number
  kv: string
  mtp?: RecipeMtp
  flags: string[]
  agent: RecipeAgent
}

export interface GuidanceRecipeTier {
  name: string
  min_vram_gb: number
  engine: "vllm" | "guidance"
  quant: string
  guidance: string
}

export interface DockerRecipeTier {
  name: string
  min_vram_gb: number
  engine: "docker-sglang"
  quant: string
  image: string
  image_digest: string
  model_hf: string
  model_revision: string
  ctx: number
  container_port: number
  server_args: string[]
  agent: RecipeAgent
  guidance: string
}

export type RecipeTier = LlamaRecipeTier | GuidanceRecipeTier | DockerRecipeTier

export interface ModelRecipe {
  id: string
  name: string
  hf_repo: string
  revision: string
  llama_cpp_ref: string
  tiers: RecipeTier[]
}

export interface Recipes {
  schema: 1
  models: ModelRecipe[]
}

export interface RecipeLoadResult {
  recipes: Recipes
  source: "bundled" | "cache" | "remote"
  warning?: string
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

// fetchModelArtifacts joins this value directly into a filesystem path
// (paths.models/<id>/<revision>/...) without further sanitization. A remote
// recipe (loaded via ALTIMATE_LOCAL_RECIPES_URL, pinned by sha256 but not
// otherwise trusted) containing "../" here could escape the managed model
// cache directory.
function pathSegment(value: unknown, label: string) {
  const result = string(value, label)
  if (result === "." || result === ".." || /[\\/]/.test(result)) {
    throw new Error(`${label} must not contain path separators or be "." or ".."`)
  }
  return result
}

function finite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function positiveInteger(value: unknown, label: string) {
  const result = finite(value, label)
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${label} must be a positive integer`)
  return result
}

function port(value: unknown, label: string) {
  const result = positiveInteger(value, label)
  if (result > 65535) throw new Error(`${label} must be between 1 and 65535`)
  return result
}

function sha(value: unknown, label: string) {
  const result = string(value, label)
  if (!/^[a-f0-9]{64}$/i.test(result) && !/^TODO_[A-Z0-9_]+$/.test(result)) {
    throw new Error(`${label} must be a sha256 or a TODO_* placeholder`)
  }
  return result
}

function validateAgent(value: unknown, label: string): RecipeAgent {
  const input = record(value, label)
  if (typeof input.tool_retrieval !== "boolean") throw new Error(`${label}.tool_retrieval must be a boolean`)
  const reasoning = string(input.reasoning_effort, `${label}.reasoning_effort`)
  if (!(["low", "medium", "xhigh"] as string[]).includes(reasoning)) {
    throw new Error(`${label}.reasoning_effort is unsupported`)
  }
  return {
    tool_retrieval: input.tool_retrieval,
    reasoning_effort: reasoning as ReasoningEffort,
    temperature: finite(input.temperature, `${label}.temperature`),
  }
}

function validateMtp(value: unknown, label: string): RecipeMtp {
  const input = record(value, label)
  return {
    file: string(input.file, `${label}.file`),
    sha256: sha(input.sha256, `${label}.sha256`),
    draft_max: positiveInteger(input.draft_max, `${label}.draft_max`),
  }
}

function validateTier(value: unknown, label: string): RecipeTier {
  const input = record(value, label)
  const engine = string(input.engine, `${label}.engine`)
  const common = {
    name: string(input.name, `${label}.name`),
    min_vram_gb: finite(input.min_vram_gb, `${label}.min_vram_gb`),
    quant: string(input.quant, `${label}.quant`),
  }
  if (common.min_vram_gb <= 0) throw new Error(`${label}.min_vram_gb must be positive`)

  if (engine === "vllm" || engine === "guidance") {
    return { ...common, engine, guidance: string(input.guidance, `${label}.guidance`) }
  }
  if (engine === "docker-sglang") {
    const imageDigest = string(input.image_digest, `${label}.image_digest`)
    if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error(`${label}.image_digest must be a sha256: digest`)
    if (!Array.isArray(input.server_args) || input.server_args.some((flag) => typeof flag !== "string")) {
      throw new Error(`${label}.server_args must be an array of strings`)
    }
    return {
      ...common,
      engine,
      image: string(input.image, `${label}.image`),
      image_digest: imageDigest,
      model_hf: string(input.model_hf, `${label}.model_hf`),
      model_revision: (() => {
        const revision = string(input.model_revision, `${label}.model_revision`)
        if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error(`${label}.model_revision must be a pinned 40-character commit`)
        return revision
      })(),
      ctx: positiveInteger(input.ctx, `${label}.ctx`),
      container_port: port(input.container_port, `${label}.container_port`),
      server_args: [...input.server_args] as string[],
      agent: validateAgent(input.agent, `${label}.agent`),
      guidance: string(input.guidance, `${label}.guidance`),
    }
  }
  if (engine !== "llama.cpp") throw new Error(`${label}.engine is unsupported`)
  if (!Array.isArray(input.flags) || input.flags.some((flag) => typeof flag !== "string")) {
    throw new Error(`${label}.flags must be an array of strings`)
  }
  const ctx = positiveInteger(input.ctx, `${label}.ctx`)
  const parallel = positiveInteger(input.parallel, `${label}.parallel`)
  if (ctx % parallel !== 0) throw new Error(`${label}.ctx must divide evenly across parallel slots`)
  return {
    ...common,
    engine,
    file: string(input.file, `${label}.file`),
    sha256: sha(input.sha256, `${label}.sha256`),
    ctx,
    parallel,
    kv: string(input.kv, `${label}.kv`),
    mtp: input.mtp === undefined ? undefined : validateMtp(input.mtp, `${label}.mtp`),
    flags: [...input.flags] as string[],
    agent: validateAgent(input.agent, `${label}.agent`),
  }
}

function validateModel(value: unknown, label: string): ModelRecipe {
  const input = record(value, label)
  if (!Array.isArray(input.tiers) || input.tiers.length === 0) throw new Error(`${label}.tiers must be non-empty`)
  const tiers = input.tiers.map((tier, index) => validateTier(tier, `${label}.tiers[${index}]`))
  if (new Set(tiers.map((tier) => tier.name)).size !== tiers.length)
    throw new Error(`${label} has duplicate tier names`)
  const revision = string(input.revision, `${label}.revision`)
  if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error(`${label}.revision must be a pinned 40-character commit`)
  const llama_cpp_ref = string(input.llama_cpp_ref, `${label}.llama_cpp_ref`)
  // Runtime discovery/download in runtime.ts always installs the hard-coded
  // LLAMA_CPP_REF build, ignoring this field entirely — a remote recipe (loaded
  // via ALTIMATE_LOCAL_RECIPES_URL) that advances llama_cpp_ref past what the
  // installer supports must fail loudly here rather than silently running an
  // incompatible llama.cpp build against its updated flags/model.
  if (tiers.some((tier) => tier.engine === "llama.cpp") && llama_cpp_ref !== LLAMA_CPP_REF) {
    throw new Error(
      `${label}.llama_cpp_ref (${llama_cpp_ref}) does not match the installer's supported build (${LLAMA_CPP_REF}); upgrade altimate-code before using this recipe`,
    )
  }
  return {
    id: pathSegment(input.id, `${label}.id`),
    name: string(input.name, `${label}.name`),
    hf_repo: string(input.hf_repo, `${label}.hf_repo`),
    revision,
    llama_cpp_ref,
    tiers,
  }
}

export function validateRecipes(value: unknown): Recipes {
  const input = record(value, "recipes")
  if (input.schema !== 1) throw new Error("recipes.schema must be 1")
  if (!Array.isArray(input.models) || input.models.length === 0) throw new Error("recipes.models must be non-empty")
  const models = input.models.map((model, index) => validateModel(model, `recipes.models[${index}]`))
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw new Error("recipes has duplicate model ids")
  return { schema: 1, models }
}

export const BUNDLED_RECIPES = validateRecipes(snapshot)

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function pinnedSha(value: string | undefined) {
  return value && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined
}

export async function loadRecipes(
  options: {
    env?: NodeJS.ProcessEnv
    paths?: LocalPaths
  } = {},
): Promise<RecipeLoadResult> {
  const env = options.env ?? process.env
  const paths = options.paths ?? getLocalPaths(env)
  const url = env.ALTIMATE_LOCAL_RECIPES_URL
  const expected = pinnedSha(env.ALTIMATE_LOCAL_RECIPES_SHA256)
  if (!url || !expected) return { recipes: BUNDLED_RECIPES, source: "bundled" }

  try {
    const [raw, metaRaw] = await Promise.all([fs.readFile(paths.recipes), fs.readFile(paths.recipesMeta, "utf8")])
    const meta = JSON.parse(metaRaw) as { url?: string; sha256?: string }
    if (meta.url !== url || meta.sha256 !== expected || digest(raw) !== expected) {
      throw new Error("cached recipe pin does not match")
    }
    return { recipes: validateRecipes(JSON.parse(raw.toString("utf8"))), source: "cache" }
  } catch {
    return { recipes: BUNDLED_RECIPES, source: "bundled" }
  }
}

export async function refreshRecipes(
  options: {
    env?: NodeJS.ProcessEnv
    paths?: LocalPaths
    fetchImpl?: Fetch
  } = {},
): Promise<RecipeLoadResult> {
  const env = options.env ?? process.env
  const paths = options.paths ?? getLocalPaths(env)
  const fetchImpl = options.fetchImpl ?? fetch
  const url = env.ALTIMATE_LOCAL_RECIPES_URL
  const expected = pinnedSha(env.ALTIMATE_LOCAL_RECIPES_SHA256)
  if (!url) {
    return {
      recipes: BUNDLED_RECIPES,
      source: "bundled",
      warning: "ALTIMATE_LOCAL_RECIPES_URL is not set; using the bundled recipe snapshot.",
    }
  }
  if (!expected) {
    return {
      recipes: BUNDLED_RECIPES,
      source: "bundled",
      warning: "ALTIMATE_LOCAL_RECIPES_SHA256 must be a 64-character sha256; refusing an unpinned recipe update.",
    }
  }

  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } })
    if (!response.ok) throw new Error(`recipe server returned HTTP ${response.status}`)
    const raw = new Uint8Array(await response.arrayBuffer())
    const actual = digest(raw)
    if (actual !== expected) throw new Error(`recipe sha256 mismatch: expected ${expected}, got ${actual}`)
    const recipes = validateRecipes(JSON.parse(new TextDecoder().decode(raw)))
    await ensureLocalDirectories(paths)
    const temp = `${paths.recipes}.${process.pid}.tmp`
    await fs.writeFile(temp, raw)
    await fs.rename(temp, paths.recipes)
    await fs.writeFile(paths.recipesMeta, JSON.stringify({ url, sha256: expected }, null, 2) + "\n", { mode: 0o600 })
    return { recipes, source: "remote" }
  } catch (error) {
    return {
      recipes: BUNDLED_RECIPES,
      source: "bundled",
      warning: `Recipe update failed; using bundled snapshot: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function firstModel(recipes: Recipes) {
  const model = recipes.models[0]
  if (!model) throw new Error("No local model recipe is available")
  return model
}

// The registry is multi-model; the default is its first entry. `--model` selects
// any other entry by id.
export function selectModel(recipes: Recipes, id?: string) {
  if (id === undefined) return firstModel(recipes)
  const model = recipes.models.find((candidate) => candidate.id === id)
  if (!model) {
    const available = recipes.models.map((candidate) => candidate.id).join(", ")
    throw new Error(`Unknown local model "${id}". Available: ${available}`)
  }
  return model
}
