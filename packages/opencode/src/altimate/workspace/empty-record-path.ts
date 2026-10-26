// altimate_change - new file
import path from "path"
import { createHash } from "node:crypto"
import { Global } from "@/global"

/** Where a sync records that this project's workspace has no skills. Keyed by the resolved
 * directory, so the TUI thread and the prompt worker agree on one file. Under the app's state
 * directory, so nothing is written into the user's repository. Kept out of `skill-sync` so the
 * per-turn gate in `session/prompt` can check it without loading that module. */
export function emptyRecordPath(canon: string): string {
  const id = createHash("sha256").update(canon).digest("hex").slice(0, 32)
  return path.join(Global.Path.state, "altimate-workspace-empty", id)
}
