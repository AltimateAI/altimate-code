// altimate_change - new file
/**
 * Background workspace work a turn started without waiting for it. Registered synchronously, at the moment the turn
 * starts it, so a one-shot `run` that ends straight away still waits for it on exit: the sync registers itself only
 * after a module import and a couple of awaits, and a flush that ran in that window found nothing to wait for.
 * Kept free of imports so the turn path can register without loading the sync module.
 */
const KEY = Symbol.for("altimate.workspace.pendingTurns")
const pending: Set<Promise<unknown>> = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Set()) as Set<Promise<unknown>>

export function track(work: Promise<unknown>): void {
  pending.add(work)
  work.then(
    () => pending.delete(work),
    () => pending.delete(work),
  )
}

export function all(): Promise<unknown>[] {
  return [...pending]
}
