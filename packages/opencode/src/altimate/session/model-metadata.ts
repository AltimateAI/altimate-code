import type { MessageV2 } from "../../session/message-v2"

const SHELL_MARKER = "The following tool was executed by the user"

// Shell and direct MCP commands record a model on their user row for display only; model
// resolution must skip those rows instead of treating them as a model choice.
export function isModelMetadataOnly(parts: readonly MessageV2.Part[]) {
  return parts.some(
    (part) =>
      part.type === "text" &&
      (part.metadata?.modelMetadataOnly === true || (part.synthetic === true && part.text === SHELL_MARKER)),
  )
}

export * as ModelMetadata from "./model-metadata"
