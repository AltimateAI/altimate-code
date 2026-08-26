import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

import type { LlamaRecipeTier } from "./recipes"
import { getLocalPaths, type LocalPaths } from "./paths"
import { writeLocalEnvironment, readLocalEnvironment } from "./environment"

function configFile(env: NodeJS.ProcessEnv, home: string) {
  const root = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "altimate-code")
  const candidates = ["altimate-code.json", "altimate-code.jsonc", "opencode.jsonc", "opencode.json", "config.json"]
  return { root, candidates: candidates.map((name) => path.join(root, name)) }
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
  const existing = await Promise.all(
    config.candidates.map(async (file) => ({
      file,
      exists: await fs
        .stat(file)
        .then(() => true)
        .catch(() => false),
    })),
  )
  const file = existing.find((candidate) => candidate.exists)?.file ?? config.candidates[0]!
  const before = await fs.readFile(file, "utf8").catch(() => "{}")
  const errors: ParseError[] = []
  const parsed = parse(before, errors, { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown>
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Refusing to update invalid JSON/JSONC config: ${file}`)
  }

  const advertisedContext = Math.floor(input.tier.ctx / input.tier.parallel)
  const provider = {
    name: "Local OpenAI-compatible",
    npm: "@ai-sdk/openai-compatible",
    options: {
      apiKey: "local",
      baseURL: input.baseURL,
    },
    models: {
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
  for (const agent of ["build", "general"] as const) {
    updated = patch(updated, ["agent", agent, "temperature"], input.tier.agent.temperature)
    updated = patch(updated, ["agent", agent, "options", "reasoningEffort"], input.tier.agent.reasoning_effort)
  }
  if (!("model" in parsed)) updated = patch(updated, ["model"], `local/${input.modelID}`)

  // Keep internal machinery (compaction, title generation) on the local model:
  // getSmallModel falls back to the session model today, but an explicit value
  // survives future default changes without silently leaving the machine.
  if (!("small_model" in parsed)) updated = patch(updated, ["small_model"], `local/${input.modelID}`)

  const guarded: string[] = []
  const permission = (parsed.permission ?? {}) as Record<string, unknown>
  if (input.egressGuard !== false) {
    for (const key of EGRESS_PERMISSIONS) {
      // Only where the user has not already decided — never clobber their config.
      if (key in permission) continue
      updated = patch(updated, ["permission", key], "ask")
      guarded.push(key)
    }
  } else {
    // Reversible: --no-egress-guard removes only rules the guard plausibly owns
    // (value is exactly "ask" AND a prior `altimate local` wiring actually turned
    // the guard on — recorded in environment.json's egress_guard field). Without
    // that check, an "ask" rule the user wrote themselves (or one from a run that
    // never applied the guard) would be silently deleted just because it matches
    // the value the guard happens to use.
    const priorEnvironment = await readLocalEnvironment(paths)
    if (priorEnvironment?.egress_guard === true) {
      for (const key of EGRESS_PERMISSIONS) {
        if (permission[key] === "ask") updated = patch(updated, ["permission", key], undefined)
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
  await writeLocalEnvironment(input.tier.agent.tool_retrieval, paths, input.egressGuard !== false)
  // Whether the config's default `model` actually resolves to this local model:
  // the patch above never overwrites an existing value (see comment at the top of
  // this function), so a user with a cloud default keeps using it silently after
  // setup reports "Ready" — callers use this to warn instead of implying the
  // switch happened.
  const defaultModelIsLocal = !("model" in parsed) || parsed.model === `local/${input.modelID}`
  return { file, changed: updated !== before, advertisedContext, guarded, defaultModelIsLocal }
}

// Effective egress-guard state for `altimate local status`: what each
// network-egress permission resolves to in the user config file.
export async function readEgressGuard(env?: NodeJS.ProcessEnv, home?: string) {
  const resolvedEnv = env ?? process.env
  const resolvedHome = home ?? resolvedEnv.OPENCODE_TEST_HOME ?? os.homedir()
  const config = configFile(resolvedEnv, resolvedHome)
  for (const file of config.candidates) {
    const text = await fs.readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) continue
    const parsed = parse(text, [], { allowTrailingComma: true, disallowComments: false }) as
      | Record<string, unknown>
      | undefined
    const permission = (parsed?.permission ?? {}) as Record<string, unknown>
    return Object.fromEntries(
      EGRESS_PERMISSIONS.map((key) => {
        const value = permission[key]
        return [key, typeof value === "string" ? value : value === undefined ? "allow (no rule)" : "custom"]
      }),
    )
  }
  return Object.fromEntries(EGRESS_PERMISSIONS.map((key) => [key, "allow (no rule)"]))
}
