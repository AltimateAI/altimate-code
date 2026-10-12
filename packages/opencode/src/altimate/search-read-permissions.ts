import path from "path"
import { Permission } from "@/permission"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

/** Select readable candidates before the result cap or any output is applied. */
export function readableSearchResults(
  files: string[],
  worktree: string,
  permissions: PermissionV1.Ruleset = [],
) {
  const allowed = new Set<string>()
  const patterns = new Set<string>()
  // Tool execution supplies the agent's effective defaults when context rules are
  // absent/empty. If no agent rules can be resolved, fail closed without prompting.
  if (permissions.length === 0) return { allowed, patterns: [] }
  for (const file of new Set(files)) {
    // Read uses worktree-relative paths; also recognize configured absolute paths.
    // Preserve rule order when both forms match, including explicit allow overrides.
    const relative = path.relative(worktree, file)
    const absoluteRule = Permission.evaluate("read", file, permissions)
    const relativeRule = Permission.evaluate("read", relative, permissions)
    const absolute = permissions.indexOf(absoluteRule) > permissions.indexOf(relativeRule)
    const rule = absolute ? absoluteRule : relativeRule
    if (rule.action === "deny") continue
    allowed.add(file)
    if (rule.action === "ask") patterns.add(absolute ? file : relative)
  }
  return { allowed, patterns: [...patterns] }
}
