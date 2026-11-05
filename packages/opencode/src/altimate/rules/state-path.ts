// altimate_change - new file
//
// Where a project's workspace rules state lives: in the person's own state directory, keyed by the project's real path,
// never in the project (`RulesStore`). Its own module so the prompt path can find it without loading the rules store.
import { createHash } from "node:crypto"
import path from "node:path"
import { Global } from "@/global"

/** The rules state file of the project whose real path is `realRoot`. */
export function stateFileOf(realRoot: string): string {
  return path.join(Global.Path.state, "workspace-rules", createHash("sha256").update(realRoot).digest("hex") + ".json")
}
