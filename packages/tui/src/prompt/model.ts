import { parseModel, type ModelRef } from "../context/local"

// Keep command overrides aligned with session.command's model precedence.
export function submissionModel(input: {
  shell: boolean
  text: string
  command?: { name: string; model?: string; subtask?: boolean }
  commandAgentMode?: string
  commandAgentModel?: ModelRef
  current?: ModelRef
}): { required: boolean; model?: ModelRef; subtask?: boolean; parent?: ModelRef } {
  if (input.shell) return { required: false }
  if (input.command?.name === "mcps" && /^\/mcps(?:\s*$|\s+(?:enable|disable)\s+\S)/.test(input.text))
    return { required: false }
  return {
    required: true,
    ...((input.command?.subtask === true || (input.commandAgentMode === "subagent" && input.command?.subtask !== false))
      ? { subtask: true, parent: input.current } : {}),
    model:
      input.command?.model !== undefined ? parseModel(input.command.model) : (input.commandAgentModel ?? input.current),
  }
}

export function isModelMetadataOnly(parts: readonly {
  type: string
  metadata?: Record<string, unknown>
  synthetic?: boolean
  text?: string
}[]) {
  return parts.some((part) => part.type === "text" &&
    (part.metadata?.modelMetadataOnly === true ||
      (part.synthetic && part.text === "The following tool was executed by the user")))
}

export function resolveCommandAgent<T extends { name: string }>(agents: readonly T[], name: string | undefined): T | undefined {
  if (name === undefined) return undefined
  return agents.find((agent) => agent.name === name) ??
    (name === "build" ? agents.find((agent) => agent.name === "builder") : undefined)
}

export function captureDraftRevision(readDraft: () => { input: string; mode: string; parts: readonly unknown[] }) {
  const initial = JSON.stringify(readDraft())
  const changed = () => JSON.stringify(readDraft()) !== initial
  return {
    changed,
    async after<T>(operation: Promise<T>) {
      const result = await operation
      return { result, changed: changed() }
    },
  }
}

// A deferred submit is cancelled when either the draft or the prompt mode changes.
export function deferredSubmitRevision<Prompt extends object>(prompt: Prompt, mode: string) {
  return { ...prompt, mode }
}

// Agent and command catalogs gate every submission; model readiness is checked only after
// `submissionModel` says the submission needs a model, so shell and MCP admin forms never wait on it.
type CatalogStatus = "loading" | "ready" | "failed"
export function catalogGate(input: {
  agentStatus: CatalogStatus
  needsCommands: boolean
  commandStatus: CatalogStatus
}): "ready" | "wait" | "agents-failed" | "commands-failed" {
  if (input.agentStatus === "failed") return "agents-failed"
  if (input.needsCommands && input.commandStatus === "failed") return "commands-failed"
  if (input.agentStatus === "loading" || (input.needsCommands && input.commandStatus === "loading")) return "wait"
  return "ready"
}

// The server publishes guided text for an unavailable model before rejecting the request, so the
// rejection itself needs no second toast.
export function isServerReportedModelError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ((error as { name?: unknown }).name === "ProviderModelNotFoundError") return true
  // The SDK wraps a rejected body in an Error and keeps the server's body at `cause.body`.
  const cause = (error as { cause?: unknown }).cause
  return typeof cause === "object" && cause !== null && isServerReportedModelError((cause as { body?: unknown }).body)
}
