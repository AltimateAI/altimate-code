import type { LanguageModelV3Message } from "@ai-sdk/provider"

// These messages belong to one outgoing request, outside the saved conversation.
// Keep the marker on the in-process message identity so it never reaches the wire.
const transient = new WeakSet<LanguageModelV3Message>()

export function make(text: string): LanguageModelV3Message {
  const message: LanguageModelV3Message = { role: "user", content: [{ type: "text", text }] }
  transient.add(message)
  return message
}

export function isTransient(message: LanguageModelV3Message): boolean {
  return transient.has(message)
}

export * as TurnContext from "./turn-context"
