// altimate_change - new file
import * as Manage from "@/altimate/workspace/manage"
import { lastMirrorTarget, type MirrorTarget } from "@/altimate/workspace/memory-sync"

/** How long `run`'s exit waits for the count. It is read from local files, so this only bounds a stalled disk. */
export const UNSENT_CHECK_MS = 5000

/**
 * What `run` prints at exit about memory on this machine that the workspace has not received, or null
 * when there is nothing to say. `unsynced` is `workspace status`'s count for the project, not only this
 * run's: an upload that failed, was deferred or declined by the service, or was still in flight when the
 * exit flush gave up is pending there; a block deleted since is not. A workspace with memory turned off
 * keeps its blocks here by design and is not reported.
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
  target(): MirrorTarget | undefined
  status(directory: string, binding: MirrorTarget["binding"]): Promise<Manage.StatusReport>
}

const defaultDeps: UnsentMemoryDeps = {
  target: lastMirrorTarget,
  // Passing the binding the upload used keeps `Manage.status` off the network.
  status: (directory, binding) => Manage.status(directory, { binding }),
}

/** Counted only when this process tried to upload memory to a linked workspace, so other runs pay nothing.
 * A count that cannot be read, or not within `timeoutMs`, is reported as unknown. */
export async function unsentMemoryNoticeAfterRun(
  fallbackDirectory: string,
  timeoutMs: number = UNSENT_CHECK_MS,
  deps: UnsentMemoryDeps = defaultDeps,
): Promise<string | null> {
  const target = deps.target()
  if (!target) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const report = await Promise.race([
    deps.status(target.directory ?? fallbackDirectory, target.binding).catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
  if (!report || report.memoryUnreadable) return unsentMemoryNotice(null)
  if (!report.binding || !report.memory) return null
  return unsentMemoryNotice(report.memory.unsynced)
}
