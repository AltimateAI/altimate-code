import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { ensureLocalDirectories, getLocalPaths, type LocalPaths } from "./paths"

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface CertificateCheck {
  ok: boolean
  duration_ms: number
  detail: string
}

export interface LocalCertificate {
  schema: 1
  key: string
  passed: boolean
  cached: boolean
  model_sha256: string
  runtime_version: string
  flags_sha256: string
  endpoint: string
  model: string
  created_at: string
  checks: {
    tool_call_round_trip: CertificateCheck
    reasoning_render: CertificateCheck
    prompt_prefill_8k: CertificateCheck
  }
  certificate_sha256: string
}

export function flagsHash(flags: readonly string[]) {
  return createHash("sha256").update(JSON.stringify(flags)).digest("hex")
}

export function certificateCacheKey(input: {
  modelSha256: string
  runtimeVersion: string
  flags: readonly string[]
  reasoningEffort: string
  temperature: number
}) {
  const hash = createHash("sha256")
  hash.update(input.modelSha256)
  hash.update("\0")
  hash.update(input.runtimeVersion)
  hash.update("\0")
  hash.update(flagsHash(input.flags))
  hash.update("\0")
  // The certification probes send these on every request (see chat() call
  // sites below) but the Docker recipe's `flags` don't encode either — a
  // refreshed recipe changing just reasoningEffort/temperature would
  // otherwise silently reuse an old certificate that never actually ran
  // under the new configuration.
  hash.update(input.reasoningEffort)
  hash.update("\0")
  hash.update(String(input.temperature))
  return hash.digest("hex")
}

function messageContent(value: unknown) {
  if (!value || typeof value !== "object") return ""
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return ""
  const message = (choices[0] as { message?: unknown }).message
  if (!message || typeof message !== "object") return ""
  const content = (message as { content?: unknown }).content
  return typeof content === "string" ? content.trim() : ""
}

function firstMessage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return undefined
  const message = (choices[0] as { message?: unknown }).message
  return message && typeof message === "object" ? (message as Record<string, unknown>) : undefined
}

async function chat(input: { baseURL: string; apiKey: string; fetchImpl: Fetch; body: Record<string, unknown> }) {
  const response = await input.fetchImpl(`${input.baseURL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`)
  }
  return response.json()
}

export async function check(run: () => Promise<string>): Promise<CertificateCheck> {
  const started = Date.now()
  try {
    // Object-literal properties evaluate in source order, so awaiting
    // `run()` inline in the `detail` field would compute `duration_ms`
    // before the await — reporting near-zero time for every pass.
    const detail = await run()
    return { ok: true, duration_ms: Date.now() - started, detail }
  } catch (error) {
    return {
      ok: false,
      duration_ms: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function toolCallRoundTrip(input: {
  baseURL: string
  apiKey: string
  modelID: string
  reasoningEffort: string
  temperature: number
  fetchImpl: Fetch
}) {
  const user = { role: "user", content: "Use local_add to add 2 and 3. You must call the tool." }
  const tools = [
    {
      type: "function",
      function: {
        name: "local_add",
        description: "Add two integers",
        parameters: {
          type: "object",
          properties: { a: { type: "integer" }, b: { type: "integer" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
      },
    },
  ]
  const first = await chat({
    ...input,
    body: {
      model: input.modelID,
      messages: [user],
      tools,
      tool_choice: "required",
      max_tokens: 256,
      temperature: input.temperature,
      reasoning_effort: input.reasoningEffort,
    },
  })
  const assistant = firstMessage(first)
  const calls = assistant?.tool_calls
  if (!Array.isArray(calls) || !calls[0] || typeof calls[0] !== "object") throw new Error("model returned no tool call")
  const call = calls[0] as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
  if (call.function?.name !== "local_add" || typeof call.id !== "string")
    throw new Error("model returned an invalid tool call")
  if (typeof call.function.arguments !== "string") throw new Error("tool arguments were not JSON")
  const args = JSON.parse(call.function.arguments) as { a?: unknown; b?: unknown }
  if (args.a !== 2 || args.b !== 3) throw new Error("tool arguments did not contain a=2 and b=3")

  const second = await chat({
    ...input,
    body: {
      model: input.modelID,
      messages: [user, assistant, { role: "tool", tool_call_id: call.id, content: "5" }],
      tools,
      max_tokens: 128,
      temperature: input.temperature,
      reasoning_effort: input.reasoningEffort,
    },
  })
  if (!messageContent(second)) throw new Error("model returned no final content after the tool result")
  return "tool call and tool-result continuation succeeded"
}

async function reasoningRender(input: {
  baseURL: string
  apiKey: string
  modelID: string
  reasoningEffort: string
  temperature: number
  fetchImpl: Fetch
}) {
  const response = await chat({
    ...input,
    body: {
      model: input.modelID,
      messages: [{ role: "user", content: "Compute 17 * 19 and explain the result in one sentence." }],
      max_tokens: 512,
      temperature: input.temperature,
      reasoning_effort: input.reasoningEffort,
    },
  })
  const content = messageContent(response)
  if (!content) throw new Error("reasoning request returned empty assistant content")
  // A raw <think> block in content means the server's reasoning parser is not
  // active — the agent would render chain-of-thought as the final answer.
  if (/<think>/i.test(content)) throw new Error("assistant content contains an unparsed <think> block")
  return `${input.reasoningEffort} reasoning produced assistant content`
}

async function promptPrefill(input: {
  baseURL: string
  apiKey: string
  modelID: string
  reasoningEffort: string
  temperature: number
  fetchImpl: Fetch
}) {
  const prompt = `${" datum".repeat(8192)}\nReply with PREFILL_OK.`
  const response = await chat({
    ...input,
    body: {
      model: input.modelID,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 64,
      temperature: input.temperature,
      reasoning_effort: input.reasoningEffort,
    },
  })
  if (!messageContent(response)) throw new Error("8K-token prefill returned empty assistant content")
  return "8K-token prompt prefill succeeded"
}

export async function certify(input: {
  baseURL: string
  apiKey?: string
  modelID: string
  modelSha256: string
  runtimeVersion: string
  flags: string[]
  reasoningEffort: string
  temperature: number
  force?: boolean
  paths?: LocalPaths
  fetchImpl?: Fetch
}): Promise<LocalCertificate> {
  const paths = input.paths ?? getLocalPaths()
  const fetchImpl = input.fetchImpl ?? fetch
  const key = certificateCacheKey(input)
  const file = path.join(paths.certificates, `${key}.json`)
  if (!input.force) {
    try {
      const cached = JSON.parse(await fs.readFile(file, "utf8")) as LocalCertificate
      if (cached.schema === 1 && cached.key === key && cached.passed) return { ...cached, cached: true }
    } catch {
      // A missing or malformed cache entry simply causes certification to run.
    }
  }

  const common = {
    baseURL: input.baseURL,
    apiKey: input.apiKey ?? "local",
    modelID: input.modelID,
    reasoningEffort: input.reasoningEffort,
    temperature: input.temperature,
    fetchImpl,
  }
  const checks = {
    tool_call_round_trip: await check(() => toolCallRoundTrip(common)),
    reasoning_render: await check(() => reasoningRender(common)),
    prompt_prefill_8k: await check(() => promptPrefill(common)),
  }
  // `cached` is deliberately excluded from the signed payload: it is
  // call-site metadata (whether THIS caller got a cache hit), not part of
  // what the digest is meant to attest to. Including it would make the
  // digest computed at write time (cached: false) mismatch the one implied
  // by every later cache-hit read (cached: true) — a consumer validating
  // the digest against the returned object would reject every cached
  // certificate.
  const unsigned = {
    schema: 1 as const,
    key,
    passed: Object.values(checks).every((item) => item.ok),
    model_sha256: input.modelSha256,
    runtime_version: input.runtimeVersion,
    flags_sha256: flagsHash(input.flags),
    endpoint: input.baseURL,
    model: input.modelID,
    created_at: new Date().toISOString(),
    checks,
  }
  const certificate: LocalCertificate = {
    ...unsigned,
    cached: false,
    certificate_sha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  }
  await ensureLocalDirectories(paths)
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(certificate, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(temp, file)
  return certificate
}
