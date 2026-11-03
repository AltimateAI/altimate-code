// altimate_change - new file
/**
 * The MCP calls that may not write, by their abort signal. The adapter marks each call it makes
 * with `forceReadOnly`; a tool's helper that gets the call's signal but not its context reads it
 * here. Tool.define passes `ctx.abort` through unchanged, so the signal identifies the call.
 */
const readOnly = new WeakSet<AbortSignal>()

export function markReadOnlyCall(signal: AbortSignal): void {
  readOnly.add(signal)
}

export function isReadOnlyCall(signal: AbortSignal): boolean {
  return readOnly.has(signal)
}
