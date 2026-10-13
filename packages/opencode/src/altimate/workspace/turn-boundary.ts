// altimate_change - new file
import type { MessageV2 } from "../../session/message-v2"
import { latestRequestID } from "../session/user-request"

/**
 * Decides, at each tool catalog of one prompt loop, whether the workspace engine's turn boundary runs.
 *
 * It runs on the loop's first catalog, and again on the first catalog after a new user request joins the loop. A
 * message sent while the assistant is busy does not start a loop of its own: the running loop picks it up. Without the
 * second rule, that message would keep the engine and tool pin the loop started with, even if the engine was installed
 * in between.
 *
 * "New user request" is `requestID` in `altimate/session/user-request.ts`, the rule lesson retrieval uses. The user
 * messages the loop writes itself (subtask summary, validator retry, compaction marker and continue message) carry no
 * request, so none of them move the turn to a new engine mid-task. A compaction replay stays its original request
 * while lessons are delivered; otherwise it counts as new, so the boundary runs once more where the request restarts
 * from the summary. The newest request in history is the one checked, so a loop-written message arriving after a
 * queued request does not hide it.
 */
export function tracker(): (messages: MessageV2.WithParts[]) => boolean {
  let catalogued = false
  const seen = new Set<string>()
  return (messages) => {
    const request = latestRequestID(messages)
    const boundary = !catalogued || (request !== undefined && !seen.has(request))
    catalogued = true
    if (request !== undefined) seen.add(request)
    return boundary
  }
}
