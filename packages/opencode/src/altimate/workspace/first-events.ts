// altimate_change - new file
//
// `first_prompt_sent` and `first_job_completed` for workspaces: once per workspace per machine, from
// any session bound to that workspace. Onboarding sessions keep sending these rows as they always
// did, and mark the workspace as sent, so a machine that onboards in a linked project doesn't send
// them again from a later session. The marks don't hold back an onboarding row: its row for the job
// it selected is sent even when the workspace's row was sent before it.
//
// A job has no finish signal of its own outside `sample_setup`: a skill loads instructions and the
// agent does the work with other tools. So a job here is a turn with at least one tool call that
// didn't fail, ending `completed`, the outcome `task_outcome_signal` reports as `accepted`. It
// reports as `something_else` because nothing says which job it was.
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { Log } from "@/altimate/util/log"
import { Telemetry } from "@/altimate/telemetry"
import * as OnboardingTelemetry from "@/altimate/telemetry/onboarding"
import { currentScope } from "./state"

const log = Log.create({ service: "workspace-first-events" })

export type FirstEvent = "first_prompt_sent" | "first_job_completed"

/** What this process already knows is sent, so a bound turn skips the filesystem after the first. */
const sent = new Set<string>()

/**
 * True the one time this machine should send `event` for this workspace.
 *
 * A mark is a file created exclusively, under the app's state directory so nothing lands in the
 * user's repository, which makes the claim atomic across the `serve` processes of several windows.
 * Workspace ids are per tenant, so the tenant and API are in the key. The credential is not: a second
 * person signing in on the machine is still the same machine.
 *
 * Nothing is claimed while telemetry is off, so a machine that opts back in can still send the row. A
 * mark that can't be written claims nothing either, and the next turn tries again. The claim comes
 * before the send, so a process killed between the two loses the row rather than duplicating it.
 */
export async function claim(event: FirstEvent, workspaceId: number): Promise<boolean> {
  if (!Telemetry.isEnabled()) return false
  const scope = await currentScope().catch(() => null)
  if (!scope) return false
  const id = createHash("sha256")
    .update(JSON.stringify([scope.tenant, scope.apiUrl, workspaceId, event]))
    .digest("hex")
    .slice(0, 32)
  if (sent.has(id)) return false
  const dir = path.join(Global.Path.state, "altimate-workspace-first-events")
  // Apart from the write: only the exclusive create may answer EEXIST with "already sent". A failure
  // here shows up on the write below.
  await mkdir(dir, { recursive: true }).catch(() => undefined)
  try {
    await writeFile(path.join(dir, id), "", { flag: "wx", mode: 0o600 })
    sent.add(id)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") sent.add(id)
    else log.warn("could not record a workspace first event", { event, err: String(err) })
    return false
  }
}

/** A typed prompt: the onboarding row and the workspace row are one row when both apply. */
export async function promptSent(sessionID: string, workspaceId: number | undefined): Promise<void> {
  const onboarding = OnboardingTelemetry.isOnboardingSession(sessionID) && OnboardingTelemetry.claimFirstPrompt(sessionID)
  const inWorkspace = workspaceId !== undefined && (await claim("first_prompt_sent", workspaceId))
  if (onboarding || inWorkspace) {
    await OnboardingTelemetry.emit({ type: "first_prompt_sent", workspace_id: workspaceId }, sessionID)
  }
}

/** A turn in a workspace that ended `completed` with at least one tool call that didn't fail. */
export async function jobCompleted(sessionID: string, workspaceId: number | undefined): Promise<void> {
  if (workspaceId === undefined) return
  if (await claim("first_job_completed", workspaceId)) {
    await OnboardingTelemetry.emit(
      { type: "first_job_completed", job: "something_else", workspace_id: workspaceId },
      sessionID,
    )
  }
}

/** Test seam: drops this process's memory of the marks, as a new process would start. */
export function resetForTest() {
  sent.clear()
}
