const kinds = ["terminal", "pwsh", "powershell", "cmd", "bash"] as const
export type Kind = (typeof kinds)[number]

const shellKinds = new Set<string>(kinds)

function isKind(value: string): value is Kind {
  return shellKinds.has(value)
}

export function toKind(value: string): Kind {
  return isKind(value) ? value : "terminal"
}

// Keep the exposed tool ID and permission key as "terminal" for compatibility with
// existing plugins, users, and saved permissions.
export const ToolID = "terminal"
export type ToolID = typeof ToolID

export * as ShellID from "./id"
