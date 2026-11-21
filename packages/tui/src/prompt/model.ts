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
