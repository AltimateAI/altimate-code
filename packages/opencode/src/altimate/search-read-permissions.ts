// altimate_change start — canonical and lexical read rules for search candidates
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Permission } from "@/permission"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

/** Select readable candidates before the result cap or any output is applied. */
export function readableSearchResults(files: string[], worktree: string, permissions: PermissionV1.Ruleset = []) {
  const allowed = new Set<string>()
  const patterns = new Set<string>()
  // Tool execution supplies the agent's effective defaults when context rules are
  // absent/empty. If no agent rules can be resolved, fail closed without prompting.
  if (permissions.length === 0) return { allowed, patterns: [] }
  const absolutePermissions = permissions.filter(
    (rule) => path.isAbsolute(rule.pattern) && Wildcard.match("read", rule.permission),
  )
  for (const file of new Set(files)) {
    // Match read's worktree-relative evaluation. An explicit absolute rule can
    // tighten it, but an absolute allow can never override a relative deny/ask.
    const relative = path.relative(worktree, file)
    const absoluteRule = Permission.evaluate("read", file, absolutePermissions)
    const relativeRule = Permission.evaluate("read", relative, permissions)
    const absolute = path.isAbsolute(absoluteRule.pattern) ? absoluteRule.action : "allow"
    // Preserve alias-specific rules while applying absolute rules to symlink targets.
    let canonicalFile = file
    try {
      if (absolutePermissions.length > 0) canonicalFile = FSUtil.resolve(file)
    } catch {
      // Fail closed for this candidate without discarding other search results.
      continue
    }
    const canonicalRule = Permission.evaluate("read", canonicalFile, absolutePermissions)
    const canonical = path.isAbsolute(canonicalRule.pattern) ? canonicalRule.action : "allow"
    if (relativeRule.action === "deny" || absolute === "deny" || canonical === "deny") continue
    allowed.add(file)
    if (relativeRule.action === "ask") patterns.add(relative)
    if (absolute === "ask") patterns.add(file)
    if (canonical === "ask") patterns.add(canonicalFile)
  }
  return { allowed, patterns: [...patterns] }
}
// altimate_change end
