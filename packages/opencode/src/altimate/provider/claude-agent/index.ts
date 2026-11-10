export * as ClaudeAgent from "./index"

import { Effect, Exit, Scope, SubscriptionRef } from "effect"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { ClaudeIO } from "./claude/io"
import { ClaudeProbe } from "./claude/probe"
import { ClaudeQueryOptions } from "./claude/query-options"
import { ClaudeSessions } from "./claude/sessions"
import { ClaudeStatus } from "./claude/status"
import { ClaudeAgentCatalog } from "./catalog"
import { ClaudeAgentID } from "./id"
import { ClaudeAgentLanguageModel } from "./language-model/claude-agent-language-model"
import { RequestKind } from "./language-model/request-kind"
import { ClaudeSystemPrompt } from "./language-model/system-prompt"
import { ClaudeAgentStorage } from "./storage"

// Shipped-runtime integration of upstream's Claude Agent provider (opencode PR 58782).
// Upstream registers it through core's v2 plugin context (`ctx.provider`, `ctx.aisdk.hook`,
// `ctx.session.hook`); the shipped CLI resolves providers in `provider/provider.ts` and builds
// requests in `session/llm.ts`, so this module exposes the same pieces for those call sites.

const log = Log.create({ service: "claude-agent" })

export const ID = ClaudeAgentID.ID
export const PACKAGE = ClaudeAgentID.PACKAGE
// What `/connect` saves. It only records that the user chose the Claude Code login; the login
// itself stays with `claude`, and this value is never sent anywhere.
export const AUTH_KEY = "claude-code-login"

export function matches(model: { readonly api: { readonly npm: string } }) {
  return model.api.npm === PACKAGE
}

const io = ClaudeIO.real
// One registry per directory, outside any instance, so an instance reload of the same directory adopts its
// running `claude` processes, and disposing one project never waits on another project's owner count.
const registries = new Map<string, ReturnType<typeof ClaudeSessions.registry>>()

function registryFor(directory: string) {
  let registry = registries.get(directory)
  if (!registry) {
    registry = ClaudeSessions.registry()
    registries.set(directory, registry)
  }
  return registry
}

// A chat's own process reports the version, login and models it found, which keeps the saved model
// list current without a separate check.
async function saveCatalog(state: ClaudeStatus.State, connection: Readonly<Record<string, string>>) {
  if (state.type !== "ready") return
  const baseURL = connection.ANTHROPIC_BASE_URL ?? io.env().ANTHROPIC_BASE_URL
  await ClaudeAgentCatalog.update(state.probe, baseURL).catch((error) =>
    log.warn("failed to save Claude Agent models", { error }),
  )
}

// Per instance: this project's connection settings, login status and registry attachment. Disposing the
// instance closes the attachment, and its processes get the registry's handover window.
const instance = Instance.state(
  async () => {
    const settings = { connection: {} as Record<string, string> }
    const inner = await Effect.runPromise(ClaudeStatus.make(io, () => Effect.sync(() => settings.connection)))
    const status: ClaudeStatus.Interface = {
      ...inner,
      report: (next) =>
        inner.report(next).pipe(Effect.andThen(Effect.promise(() => saveCatalog(next, settings.connection)))),
    }
    const scope = Scope.makeUnsafe()
    const sessions = await Effect.runPromise(
      registryFor(Instance.directory)
        .attach({ io, status, storage: ClaudeAgentStorage.sessions, directory: Instance.directory })
        .pipe(Scope.provide(scope)),
    )
    return { settings, status, sessions, scope }
  },
  async (entry) => {
    await Effect.runPromise(Scope.close(entry.scope, Exit.void))
  },
)

// The connection settings from this project's provider config (`settings.baseURL`, `headers`, ...), as
// Claude Code environment variables. Used by the login check, which runs before any chat. Call within the instance.
export async function configure(options: Readonly<Record<string, unknown>> | undefined) {
  const { settings } = await instance()
  settings.connection = ClaudeQueryOptions.connectionEnv({
    settings: options,
    headers: options?.headers as Record<string, string> | undefined,
    body: options?.body as Record<string, unknown> | undefined,
  })
}

// Runs `claude` without sending a prompt (no tokens are used) to read its version, login and models.
// Call within the instance.
export async function check(): Promise<ClaudeStatus.State> {
  const { status, settings } = await instance()
  await Effect.runPromise(status.refresh())
  const state = await Effect.runPromise(SubscriptionRef.get(status.state))
  await saveCatalog(state, settings.connection)
  return state
}

export function problem(state: ClaudeStatus.State): string | undefined {
  if (state.type === "missing") return "Claude Code is not installed. Install it, then run `claude auth login`."
  if (state.type === "failed") return state.message
  if (state.type === "ready" && !ClaudeProbe.isLoggedIn(state.probe.account))
    return "Claude Code is not logged in. Run `claude auth login` in a terminal."
  if (state.type === "checking") return "Claude Code login check did not finish."
  return undefined
}

// The session stopped running, so a Claude turn still waiting for tool results will not get them.
// Call within the instance.
export async function idle(sessionID: string) {
  const { sessions } = await instance()
  await Effect.runPromise(sessions.idle(sessionID))
}

// The provider's merged options as Claude Code environment variables. The loader fills `apiKey`
// from the saved /connect marker, which is not an Anthropic key; a configured apiKey still maps.
export function connectionEnv(options: Readonly<Record<string, any>>) {
  const { apiKey, ...settings } = options
  return ClaudeQueryOptions.connectionEnv({
    settings: apiKey === AUTH_KEY ? settings : options,
    headers: options.headers,
    body: options.body,
  })
}

// The AI SDK provider factory for `PACKAGE`, called by the shipped provider loader with the
// provider's merged options. Mirrors upstream's `ClaudeAISDK.register` "sdk" hook.
export function createSDK(options: Record<string, any>) {
  // Resolved here, inside the instance, because the model's stream runs from the AI SDK's callbacks.
  const current = instance()
  // A failed attach surfaces from the chat that awaits it, not as an unhandled rejection.
  current.catch(() => {})
  const env = connectionEnv(options)
  const dependencies: ClaudeAgentLanguageModel.Dependencies = {
    run: async (request, signal) => {
      const { sessions } = await current
      await Effect.runPromise(sessions.run(request), { signal })
    },
  }
  return {
    languageModel: (modelID: string) => new ClaudeAgentLanguageModel.Model(modelID, dependencies, env),
  }
}

// Upstream's request kinds. Titles, summaries and compaction run as standalone side calls here:
// the shipped runtime has no hook to snapshot a chat's Claude session for them.
function kind(input: { readonly agent: string; readonly small?: boolean }) {
  if (input.small) return "utility"
  if (input.agent === "title" || input.agent === "summary" || input.agent === "compaction") return "utility"
  return "primary"
}

// What `session/llm.ts` adds to a Claude Agent request, standing in for upstream's
// `model.request`, `context` and instruction hooks.
export function request(input: {
  readonly sessionID: string
  readonly agent: string
  readonly agentPrompt?: string
  readonly small?: boolean
  // Instruction sources after the agent/provider prompt: AGENTS.md, skills, workspace rules, ...
  // The per-turn environment block is left out: Claude Code writes its own date and environment,
  // and forwarding them made Claude subscriptions reject chats as a third-party app.
  readonly instructions: readonly (string | undefined)[]
}) {
  const requestKind = kind(input)
  return {
    headers: {
      [RequestKind.HEADER]: requestKind,
      ...(requestKind === "primary" ? { [RequestKind.SESSION_HEADER]: input.sessionID } : {}),
    },
    options: {
      [ClaudeSystemPrompt.AGENT_OPTION]: input.agentPrompt ?? "",
      [ClaudeSystemPrompt.INSTRUCTIONS_OPTION]: input.instructions.filter((text) => text?.trim()).join("\n\n"),
    },
  }
}
