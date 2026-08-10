// altimate_change — WorkspaceLink feature. Shared polling loop for the WorkspaceLink poll
// endpoint (CONTRACT.md §1.3), used by Path A's detached background poller (altimate.ts) and
// the `altimate link` CLI command (cli/cmd/link.ts). Adapted from the GitHub Copilot device
// flow's poll loop (packages/opencode/src/plugin/github-copilot/copilot.ts:268-342) but adds
// the hard client-side expiry check that Copilot's loop lacks — CONTRACT.md explicitly calls
// this out as a gap to fix here (Copilot polls forever with no client-side timeout).
//
// Simpler than Copilot's loop in one respect: CONTRACT.md's poll response is a closed
// {pending|declined|expired|approved} union, not raw RFC 8628 error strings, so there is no
// authorization_pending/slow_down text to parse — the backend, not the client, is expected to
// hand back `expires_in`/`interval` values the client just honors.
import { setTimeout as sleep } from "node:timers/promises"
import { WorkspaceLinkApi } from "./api-client"
import type { WorkspaceLinkPollResponse } from "./types"

export interface PollLoopOptions {
  linkId: string
  pollToken: string
  /** Seconds, from the creation response. */
  expiresIn: number
  /** Seconds, from the creation response. */
  interval: number
  /** Called once per attempt (including transient-error attempts, reported as `pending`) — lets
   * a caller show "Waiting for approval..." or similar without owning the loop itself. */
  onTick?: (result: WorkspaceLinkPollResponse) => void
}

export async function pollUntilResolved(opts: PollLoopOptions): Promise<WorkspaceLinkPollResponse> {
  const deadline = Date.now() + Math.max(0, opts.expiresIn) * 1000
  const intervalMs = Math.max(1, opts.interval) * 1000
  while (true) {
    if (Date.now() >= deadline) {
      const expired: WorkspaceLinkPollResponse = { status: "expired" }
      opts.onTick?.(expired)
      return expired
    }
    let result: WorkspaceLinkPollResponse
    try {
      result = await WorkspaceLinkApi.poll(opts.linkId, opts.pollToken)
    } catch {
      // Transient network failure — keep waiting rather than aborting the whole flow. The
      // hard deadline check above still fires once expires_in has genuinely elapsed.
      opts.onTick?.({ status: "pending" })
      await sleep(intervalMs)
      continue
    }
    opts.onTick?.(result)
    if (result.status !== "pending") return result
    await sleep(intervalMs)
  }
}
