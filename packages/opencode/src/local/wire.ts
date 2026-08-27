import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { mergeDeep } from "remeda"

import type { LlamaRecipeTier } from "./recipes"
import { getLocalPaths, type LocalPaths } from "./paths"
import { writeLocalEnvironment, readLocalEnvironment } from "./environment"
import { Wildcard } from "@/util/wildcard"

// Precedence Config actually applies when merging (lowest to highest —
// see config/config.ts's load order; each later file overrides the earlier
// ones). If more than one of these exists, the LAST one here is the file
// that actually takes effect.
const CONFIG_PRECEDENCE = ["config.json", "opencode.json", "opencode.jsonc", "altimate-code.json", "altimate-code.jsonc"]
// Default target when nothing exists yet, so a fresh install still lands in
// the expected file.
const DEFAULT_CONFIG_FILE = "altimate-code.json"

function configFile(env: NodeJS.ProcessEnv, home: string) {
  const root = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "altimate-code")
  return {
    root,
    defaultFile: path.join(root, DEFAULT_CONFIG_FILE),
    // Highest precedence first: the file that wins if it exists.
    precedence: [...CONFIG_PRECEDENCE].reverse().map((name) => path.join(root, name)),
  }
}

// Which existing config file actually wins under Config's merge order.
// Writing to (or reading from) any lower-precedence file that also exists
// would be silently shadowed by this one — see config/config.ts's load order.
async function winningConfigFile(config: ReturnType<typeof configFile>) {
  for (const file of config.precedence) {
    if (
      await fs
        .stat(file)
        .then(() => true)
        .catch(() => false)
    )
      return file
  }
  return config.defaultFile
}

// The config schema accepts a bare `"permission": "deny"` shorthand string, which
// ConfigPermissionV1's own decoder normalizes to `{ "*": "deny" }` — but that normalization lives
// in the Config schema pipeline, not in raw JSON. Every reader of the raw parsed permission value
// in this file goes through this so a shorthand string can't reach `Object.keys()` (returns
// character indices, not pattern keys) or a bare `key in permission` (throws on a primitive).
function normalizePermission(raw: unknown): Record<string, unknown> {
  return typeof raw === "string" ? { "*": raw } : ((raw ?? {}) as Record<string, unknown>)
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

// Effective permission across every config file that actually exists, merged
// in the SAME low-to-high precedence order Config itself applies (see
// CONFIG_PRECEDENCE above and config/config.ts's mergeDeep-based loader).
// The winning file alone can look empty while a lower-precedence file still
// carries a rule (e.g. a global `{"*":"deny"}`) that the real loader would
// still apply — reading only the winning file would miss it and let a
// guard-owned "ask" key silently widen the user's effective permissions.
async function readEffectivePermission(config: ReturnType<typeof configFile>): Promise<Record<string, unknown>> {
  let merged: Record<string, unknown> = {}
  for (const name of CONFIG_PRECEDENCE) {
    const file = path.join(config.root, name)
    const text = await fs.readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) continue
    const parsed = parse(text, [], { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown> | undefined
    merged = mergeDeep(merged, normalizePermission(parsed?.permission)) as Record<string, unknown>
  }
  return merged
}

function patch(input: string, keys: (string | number)[], value: unknown) {
  return applyEdits(
    input,
    modify(input, keys, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  )
}

// Tool permission keys that send content off the machine. With the egress guard
// on, each gets an "ask" rule so a local-first session escalates to the network
// only with per-step approval. User config merges after agent rulesets
// (last-match-wins), so these override the agents' built-in "allow".
export const EGRESS_PERMISSIONS = ["websearch", "webfetch", "codesearch"] as const

export async function wireLocalProvider(input: {
  baseURL: string
  modelID: string
  tier: Pick<LlamaRecipeTier, "ctx" | "parallel" | "agent">
  egressGuard?: boolean
  env?: NodeJS.ProcessEnv
  home?: string
  paths?: LocalPaths
}) {
  const env = input.env ?? process.env
  const home = input.home ?? env.OPENCODE_TEST_HOME ?? os.homedir()
  const paths = input.paths ?? getLocalPaths(env, home)
  const config = configFile(env, home)
  await fs.mkdir(config.root, { recursive: true })
  const file = await winningConfigFile(config)
  const before = await fs.readFile(file, "utf8").catch(() => "{}")
  const errors: ParseError[] = []
  const parsed = parse(before, errors, { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown>
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Refusing to update invalid JSON/JSONC config: ${file}`)
  }

  const advertisedContext = Math.floor(input.tier.ctx / input.tier.parallel)
  // Deep-merge onto any pre-existing `provider.local` the user already
  // defined instead of replacing it wholesale — a prior custom provider can
  // carry its own extra models, options, or top-level keys, and those must
  // survive re-wiring. We only own baseURL/apiKey (under options) and our
  // own model entry (under models); everything else the user set is spread
  // in first and kept as-is.
  const existingProvider = asRecord(asRecord(parsed.provider).local)
  const existingOptions = asRecord(existingProvider.options)
  const existingModels = asRecord(existingProvider.models)
  const provider = {
    ...existingProvider,
    name: "Local OpenAI-compatible",
    npm: "@ai-sdk/openai-compatible",
    options: {
      ...existingOptions,
      apiKey: "local",
      baseURL: input.baseURL,
    },
    models: {
      ...existingModels,
      [input.modelID]: {
        name: input.modelID,
        tool_call: true,
        reasoning: true,
        temperature: true,
        interleaved: { field: "reasoning_content" },
        limit: { context: advertisedContext, output: 16384 },
      },
    },
  }

  let updated = before
  if (!("$schema" in parsed)) updated = patch(updated, ["$schema"], "https://altimate.ai/config.json")
  updated = patch(updated, ["provider", "local"], provider)
  if (!("model" in parsed)) updated = patch(updated, ["model"], `local/${input.modelID}`)
  // Whether the config's default `model` actually resolves to this local model:
  // the patch above never overwrites an existing value (see comment above),
  // so a user with a cloud default keeps using it silently after setup
  // reports "Ready" — callers use this to warn instead of implying the
  // switch happened. Computed here (before the agent-tuning patch below)
  // because that patch is itself gated on this.
  const defaultModelIsLocal = !("model" in parsed) || parsed.model === `local/${input.modelID}`
  if (defaultModelIsLocal) {
    // "builder" is the real built-in agent; "build" is only a config-lookup
    // alias that fires when no `agent.build` entry exists (agent/agent.ts).
    // Writing to "build" here would materialize a phantom non-native agent
    // that shadows the alias, so these settings would never reach the actual
    // builder agent. Only tune when the default model is actually local:
    // "builder"/"general" are shared agents also used for cloud sessions, so
    // clobbering their tuning when the user's cloud default is left in place
    // (never-clobbered above) would silently change cloud behavior too.
    for (const agent of ["builder", "general"] as const) {
      updated = patch(updated, ["agent", agent, "temperature"], input.tier.agent.temperature)
      updated = patch(updated, ["agent", agent, "options", "reasoningEffort"], input.tier.agent.reasoning_effort)
    }
  }

  // Keep internal machinery (compaction, title generation) on the local model:
  // getSmallModel falls back to the session model today, but an explicit value
  // survives future default changes without silently leaving the machine.
  if (!("small_model" in parsed)) updated = patch(updated, ["small_model"], `local/${input.modelID}`)

  const guarded: string[] = []
  // Winning-file-only view: still correct for the "did WE previously set this
  // to ask" ownership check below, since we only ever write guard keys into
  // the winning file. The "does the user already have coverage" check further
  // down needs the full merged view instead — see readEffectivePermission.
  const permission = normalizePermission(parsed.permission)
  if (input.egressGuard !== false) {
    // Carry forward ownership from a prior guard-on wiring. Without this, a key already set to
    // "ask" (because a previous guard-on run added it) matches itself in the "already covered"
    // check below and gets skipped — so `guarded` would only ever contain keys added on THIS
    // run, and a second guard-on run in a row would report `guarded: []`. That empty list then
    // overwrites `guarded_permissions` in environment.json, and a later --no-egress-guard reads
    // it back as "the guard owns nothing", removing none of the "ask" rules it actually added.
    // Only keys still set to exactly "ask" are carried forward — if the user has since changed
    // the value, we no longer own it.
    const priorEnvironment = await readLocalEnvironment(paths)
    const priorOwned = priorEnvironment?.egress_guard === true ? (priorEnvironment.guarded_permissions ?? EGRESS_PERMISSIONS) : []
    for (const key of priorOwned) {
      if ((EGRESS_PERMISSIONS as readonly string[]).includes(key) && permission[key] === "ask") guarded.push(key)
    }
    // Checking only the winning file's own keys missed rules that live in a
    // LOWER-precedence file Config still merges in — e.g. a global
    // `{"*":"deny"}` with nothing in the winning file. Writing an exact "ask"
    // rule into the winning file in that case would win under last-match-wins
    // permission evaluation and silently widen the user's effective policy,
    // so check every existing config file's merged effective permission.
    const effectivePermissionKeys = Object.keys(await readEffectivePermission(config))
    for (const key of EGRESS_PERMISSIONS) {
      if (guarded.includes(key)) continue
      // Skip if the user already has ANY rule that resolves for this tool —
      // an exact key or a wildcard/pattern key (e.g. "*": "deny") that would
      // already cover it. Checking only exact-key presence missed wildcard
      // rules: adding "ask" here would widen a user's broader top-level rule
      // the moment this key happens to sort after it in the permission
      // engine's evaluation order. Never clobber their config.
      if (effectivePermissionKeys.some((existing) => Wildcard.match(key, existing))) continue
      updated = patch(updated, ["permission", key], "ask")
      guarded.push(key)
    }
  } else {
    // Reversible: --no-egress-guard removes only permission keys THIS wiring
    // actually added under the guard, recorded in environment.json's
    // guarded_permissions (see writeLocalEnvironment below) — never a value
    // the user configured independently, and never rules from a run that
    // had the guard off in the first place. Older environment files (written
    // before guarded_permissions existed) only recorded the boolean; fall
    // back to the previous coarse heuristic (treat every egress permission
    // as possibly guard-owned) for those so upgrading doesn't stop honoring
    // --no-egress-guard on state from an older setup.
    const priorEnvironment = await readLocalEnvironment(paths)
    if (priorEnvironment?.egress_guard === true) {
      const ownedKeys = priorEnvironment.guarded_permissions ?? EGRESS_PERMISSIONS
      for (const key of ownedKeys) {
        if ((EGRESS_PERMISSIONS as readonly string[]).includes(key) && permission[key] === "ask") {
          updated = patch(updated, ["permission", key], undefined)
        }
      }
    }
  }
  if (!updated.endsWith("\n")) updated += "\n"

  if (updated !== before) {
    const temp = `${file}.${process.pid}.tmp`
    await fs.writeFile(temp, updated, { mode: 0o600 })
    await fs.rename(temp, file)
  }
  await fs.chmod(file, 0o600)
  await writeLocalEnvironment(input.tier.agent.tool_retrieval, paths, input.egressGuard !== false, guarded)
  return { file, changed: updated !== before, advertisedContext, guarded, defaultModelIsLocal }
}

// Resolve the effective action for `key` the way the permission engine does:
// the LAST rule (in config key order) whose pattern matches wins, including
// wildcard/pattern keys like "*". A non-string value at the exact key is a
// nested per-pattern ruleset, not a simple top-level decision — report it as
// "custom" rather than trying to resolve a single winner from it.
function resolveEgressAction(permission: Record<string, unknown>, key: string): string {
  if (key in permission && typeof permission[key] !== "string") return "custom"
  let resolved: string | undefined
  for (const [pattern, value] of Object.entries(permission)) {
    if (typeof value !== "string") continue
    if (Wildcard.match(key, pattern)) resolved = value
  }
  return resolved ?? "allow (no rule)"
}

// Effective egress-guard state for `altimate local status`: what each
// network-egress permission resolves to in the user config file.
export async function readEgressGuard(env?: NodeJS.ProcessEnv, home?: string) {
  const resolvedEnv = env ?? process.env
  const resolvedHome = home ?? resolvedEnv.OPENCODE_TEST_HOME ?? os.homedir()
  const config = configFile(resolvedEnv, resolvedHome)
  const file = await winningConfigFile(config)
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return Object.fromEntries(EGRESS_PERMISSIONS.map((key) => [key, "allow (no rule)"]))
  const parsed = parse(text, [], { allowTrailingComma: true, disallowComments: false }) as
    | Record<string, unknown>
    | undefined
  const permission = normalizePermission(parsed?.permission)
  return Object.fromEntries(EGRESS_PERMISSIONS.map((key) => [key, resolveEgressAction(permission, key)]))
}
