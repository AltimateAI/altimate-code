import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

import type { LlamaRecipeTier } from "./recipes"
import { getLocalPaths, type LocalPaths } from "./paths"
import { writeLocalEnvironment } from "./environment"

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

export async function wireLocalProvider(input: {
  baseURL: string
  modelID: string
  tier: Pick<LlamaRecipeTier, "ctx" | "parallel" | "agent">
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
  if (!updated.endsWith("\n")) updated += "\n"

  if (updated !== before) {
    const temp = `${file}.${process.pid}.tmp`
    await fs.writeFile(temp, updated, { mode: 0o600 })
    await fs.rename(temp, file)
  }
  await fs.chmod(file, 0o600)
  await writeLocalEnvironment(input.tier.agent.tool_retrieval, paths)
  return { file, changed: updated !== before, advertisedContext }
}
