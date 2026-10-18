// altimate_change - new file
import * as Manage from "@/altimate/workspace/manage"
import { mirrorWasRequested } from "@/altimate/workspace/memory-sync"

/**
 * What `run` prints at exit about memory saved here that the workspace has not received, or null when
 * there is nothing to say. `unsynced` is `workspace status`'s count: an upload that failed, was deferred
 * or declined, or was still in flight when the exit flush gave up is pending there; a block deleted
 * since is not.
 */
export function unsentMemoryNotice(unsynced: number | null): string | null {
  if (unsynced === null)
    return "Could not confirm that the memory saved here reached the workspace. Run `altimate-code workspace status` to check."
  if (unsynced === 0) return null
  return (
    `${unsynced === 1 ? "1 memory saved here is" : `${unsynced} memories saved here are`} not in the workspace yet. ` +
    `Run \`altimate-code workspace sync\` to send ${unsynced === 1 ? "it" : "them"}.`
  )
}

/** Counted only when this process saved memory for a linked workspace, so other runs pay nothing. */
export async function unsentMemoryNoticeAfterRun(directory: string): Promise<string | null> {
  if (!mirrorWasRequested()) return null
  const report = await Manage.status(directory)
  if (!report.binding || !report.memory) return null
  return unsentMemoryNotice(report.memory.unsynced)
}
