export * as ClaudeAgentID from "./id"

// The provider ID upstream registers (`Provider.ID.claudeAgent`), kept so configs and sessions carry over.
export const ID = "claude-agent"
// The AI SDK package name the shipped provider loader resolves to the bundled Claude Agent factory.
export const PACKAGE = "@opencode/claude-agent"
