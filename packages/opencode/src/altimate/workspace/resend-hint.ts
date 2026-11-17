// altimate_change - new file
//
// What the author of a skill or knowledge request sent back for changes does next, said the same way by the CLI
// (`workspace review status`) and the TUI (`/rules`, the decision toast).
import { printable } from "../rules/printable"

/** A skill name as a shell argument: quoted unless it is a plain slug. */
const shellArg = (name: string) => (/^[A-Za-z0-9._-]+$/.test(name) ? name : JSON.stringify(name))

/** How the author sends a request sent back for changes again; the new version replaces it, back in review. */
export function resendHint(kind: "skill" | "knowledge", name: string): string {
  if (kind === "knowledge") return "Change the knowledge base, then send it again from the workspace's Knowledge tab."
  return `Change the skill, then send it again with \`altimate-code skill publish ${shellArg(printable(name))}\` (or from your IDE).`
}
