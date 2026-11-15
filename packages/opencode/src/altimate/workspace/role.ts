// altimate_change - new file
//
// The caller's role on a workspace, from a server answer: `owner`, `admin` or `member`. Owner and admins manage a
// workspace (they decide review requests and rules, and their own items reach it without review); members use it and
// send items for review. A server older than workspace roles sends only `is_owner`, and a role this version does not
// know is read the same way, so a client never offers a decision the server would refuse.

export type Role = "owner" | "admin" | "member"

/** `role` as the server sent it, else what `is_owner` says. */
export function roleOf(answer: { is_owner: boolean; role?: string | null }): Role {
  if (answer.role === "owner" || answer.role === "admin" || answer.role === "member") return answer.role
  return answer.is_owner ? "owner" : "member"
}

/** Owner or admin: decides review requests and rules. */
export function manages(answer: { is_owner: boolean; role?: string | null }): boolean {
  return roleOf(answer) !== "member"
}

export * as WorkspaceRole from "./role"
