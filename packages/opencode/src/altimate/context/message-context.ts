// altimate_change start - side channel for per-turn user message text
// Follows the same pattern as Fingerprint (module-level cached state, get/set/clear)
export namespace MessageContext {
  let current: string | undefined

  export function set(text: string): void {
    current = text
  }

  export function get(): string | undefined {
    return current
  }

  export function clear(): void {
    current = undefined
  }
}
// altimate_change end
