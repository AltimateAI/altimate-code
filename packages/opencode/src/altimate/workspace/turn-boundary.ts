// altimate_change - new file
import type { MessageV2 } from "../../session/message-v2"
import { requestID } from "../session/user-request"

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
 * from the summary. Every request in history is checked, not only the newest: history is not in id order after a
 * compaction that keeps a tail, and a loop-written message or a replay can arrive after a queued request.
 */
export function tracker(): (messages: MessageV2.WithParts[]) => boolean {
  let catalogued = false
  const seen = new Set<string>()
  return (messages) => {
    let unseen = false
    for (const message of messages) {
      const request = requestID(message)
      if (request === undefined || seen.has(request)) continue
      seen.add(request)
      unseen = true
    }
    const boundary = !catalogued || unseen
    catalogued = true
    return boundary
  }
}
