// altimate_change - new file
//
// Per-project serialization. Two attaches for the same project must not race to
// `MCP.add`, because whichever lands LAST owns the runtime client.
import { projectRoot } from "./engine-seams"

/** In-flight attach chain per project.
 *
 * Per-session ordering is not enough: the MCP client is instance-wide, not per
 * session, `MCP.add` is last-writer-wins, and `SessionRunState` keeps
 * independent runners per session id — so two prompts in the same project
 * genuinely overlap. Without this, a slower attach from one session can land
 * after another session's and leave the runtime serving a workspace nobody is
 * bound to, with both memos settled so no later turn repairs it. */
export const attachChains = new Map<string, Promise<unknown>>()

export function projectKey(): string {
  try {
    return projectRoot()
  } catch {
    return "<no-instance>"
  }
}

export function serializeAttach<T>(fn: () => Promise<T>): Promise<T> {
  const key = projectKey()
  const previous = attachChains.get(key) ?? Promise.resolve()
  // Run regardless of how the previous attach ended — a failure must not wedge
  // the chain for the rest of the process.
  const next = previous.then(fn, fn)
  const tail = next.then(
    () => {},
    () => {},
  )
  attachChains.set(key, tail)
  // Drop the entry once it settles, unless another attach has already queued
  // behind it — otherwise every project path a long-running server opens is
  // retained for the life of the process. Bounding `sessions` did not cover this.
  void tail.then(() => {
    if (attachChains.get(key) === tail) attachChains.delete(key)
  })
  return next
}

/** Test seam — how many project attach chains are currently retained. */
export function trackedChainsForTests(): number {
  return attachChains.size
}
