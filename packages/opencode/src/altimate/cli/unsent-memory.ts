// altimate_change - new file
import * as Manage from "@/altimate/workspace/manage"
import { mirrorWasRequested } from "@/altimate/workspace/memory-sync"

/** How long `run`'s exit waits for the count. Without a local link row, `Manage.status` asks the service. */
export const UNSENT_CHECK_MS = 5000

/**
 * What `run` prints at exit about memory on this machine that the workspace has not received, or null
 * when there is nothing to say. `unsynced` is `workspace status`'s count for the project, not only this
 * run's: an upload that failed, was deferred or declined, or was still in flight when the exit flush gave
 * up is pending there; a block deleted since is not.
 */
export function unsentMemoryNotice(unsynced: number | null): string | null {
  if (unsynced === null)
    return "Could not confirm that the memory saved here reached the workspace. Run `altimate-code workspace status` to check."
  if (unsynced === 0) return null
  return (
    `${unsynced === 1 ? "1 memory on this machine is" : `${unsynced} memories on this machine are`} not in the workspace yet. ` +
    `Run \`altimate-code workspace sync\` to send ${unsynced === 1 ? "it" : "them"}.`
  )
}

export interface UnsentMemoryDeps {
  requested(): boolean
  status(directory: string): Promise<Manage.StatusReport>
  timeoutMs: number
}

const defaultDeps: UnsentMemoryDeps = {
  requested: mirrorWasRequested,
  status: (directory) => Manage.status(directory),
  timeoutMs: UNSENT_CHECK_MS,
}

/** Counted only when this process saved memory for a linked workspace, so other runs pay nothing. A count
 * that cannot be read, or not in time, is reported as unknown. */
export async function unsentMemoryNoticeAfterRun(
  directory: string,
  deps: UnsentMemoryDeps = defaultDeps,
): Promise<string | null> {
  if (!deps.requested()) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const report = await Promise.race([
    deps.status(directory).catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
  if (!report || report.memoryUnreadable) return unsentMemoryNotice(null)
  if (!report.binding || !report.memory) return null
  return unsentMemoryNotice(report.memory.unsynced)
}
