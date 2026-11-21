import { parseModel, type ModelRef } from "../context/local"

// One precedence for the submitted model, its source label and whether a conversation pick can
// replace it, aligned with session.command: command model, then command agent, then the chat model.
export function resolveSubmissionModel(input: {
  command?: { name: string; model?: string }
  commandAgent?: { name: string; model?: ModelRef }
  current?: ModelRef
  currentSource?: string
}): { model?: ModelRef; source?: string; pickerCanOverride: boolean } {
  if (input.command?.model !== undefined)
    return {
      model: parseModel(input.command.model),
      source: `command "${input.command.name}" config (model)`,
      pickerCanOverride: false,
    }
  if (input.commandAgent?.model)
    return {
      model: input.commandAgent.model,
      source: `agent "${input.commandAgent.name}" config (model)`,
      pickerCanOverride: false,
    }
  return { model: input.current, source: input.currentSource, pickerCanOverride: true }
}

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
    model: resolveSubmissionModel({
      command: input.command,
      commandAgent: input.commandAgentModel ? { name: "", model: input.commandAgentModel } : undefined,
      current: input.current,
    }).model,
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

// Submit-time check for the selected model. `validate` shows the error toast for an unavailable
// model; when a conversation pick can replace that model, the picker then opens. Returns whether
// submission continues.
export function acceptSubmissionModel<Model>(input: {
  model: Model | undefined
  source?: string
  // A command or command-agent model outranks the chat model, so a pick cannot replace it.
  pickerCanOverride: boolean
  validate: (model: Model, source?: string, pickable?: boolean) => boolean
  openPicker: () => void
}) {
  if (input.model === undefined || input.validate(input.model, input.source, input.pickerCanOverride)) return true
  if (input.pickerCanOverride) input.openPicker()
  return false
}

// Accept a submission's model and, for a subtask, its parent turn's chat model, which a pick can replace.
export function acceptSubmissionSelection<Model>(input: {
  selection: { model?: Model; subtask?: boolean; parent?: Model }
  origin: { source?: string; pickerCanOverride: boolean }
  chatSource?: string
  validate: (model: Model, source?: string, pickable?: boolean) => boolean
  openPicker: () => void
}): "accepted" | "rejected" | "missing-parent" {
  const { selection, validate, openPicker } = input
  if (!acceptSubmissionModel({ model: selection.model, ...input.origin, validate, openPicker })) return "rejected"
  if (!selection.subtask) return "accepted"
  if (!selection.parent) return "missing-parent"
  const parent = acceptSubmissionModel({
    model: selection.parent,
    source: input.chatSource,
    pickerCanOverride: true,
    validate,
    openPicker,
  })
  return parent ? "accepted" : "rejected"
}

