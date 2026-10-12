import path from "path"
import { Permission } from "@/permission"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

/** Select readable candidates before the result cap or any output is applied. */
export function readableSearchResults(files: string[], worktree: string, permissions: PermissionV1.Ruleset = []) {
  const allowed = new Set<string>()
  const patterns = new Set<string>()
  // Tool execution supplies the agent's effective defaults when context rules are
  // absent/empty. If no agent rules can be resolved, fail closed without prompting.
  if (permissions.length === 0) return { allowed, patterns: [] }
  const absolutePermissions = permissions.filter((rule) => path.isAbsolute(rule.pattern))
  for (const file of new Set(files)) {
    // Match read's worktree-relative evaluation. An explicit absolute rule can
    // tighten it, but an absolute allow can never override a relative deny/ask.
    const relative = path.relative(worktree, file)
    const absoluteRule = Permission.evaluate("read", file, absolutePermissions)
    const relativeRule = Permission.evaluate("read", relative, permissions)
    const absolute = path.isAbsolute(absoluteRule.pattern) ? absoluteRule.action : "allow"
    if (relativeRule.action === "deny" || absolute === "deny") continue
    allowed.add(file)
    if (relativeRule.action === "ask") patterns.add(relative)
    if (absolute === "ask") patterns.add(file)
  }
  return { allowed, patterns: [...patterns] }
}
