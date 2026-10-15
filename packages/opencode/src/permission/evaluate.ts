// altimate_change start — upstream_fix: match equivalent path spellings with one rule precedence
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

// `pattern` is the spelling the caller authored; `aliases` are equivalent normalized
// spellings. Only deny/ask rules consider aliases, so normalization can tighten a
// decision but never lets an allow rule apply to something it did not match before.
function evaluatePatterns(
  permission: string,
  pattern: string,
  aliases: string[],
  ...rulesets: PermissionV1.Ruleset[]
): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast(
        (rule) =>
          Wildcard.match(permission, rule.permission) &&
          (Wildcard.match(pattern, rule.pattern) ||
            (rule.action !== "allow" && aliases.some((alias) => Wildcard.match(alias, rule.pattern)))),
      ) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return evaluatePatterns(permission, pattern, [], ...rulesets)
}

export function evaluateRequest(
  request: Pick<PermissionV1.Request, "permission" | "metadata">,
  pattern: string,
  ...rulesets: PermissionV1.Ruleset[]
): PermissionV1.Rule {
  const aliases = request.metadata.permissionAliases
  const values = aliases && typeof aliases === "object" ? (aliases as Record<string, unknown>)[pattern] : undefined
  const groups = Array.isArray(values)
    ? values.filter((group): group is string[] => Array.isArray(group) && group.every((value) => typeof value === "string"))
    : []
  if (!groups.length) return evaluate(request.permission, pattern, ...rulesets)
  // Preserve rule order within each access. Distinct invocations must all be allowed,
  // even when they normalize to the same command.
  const rules = groups.map((group) => evaluatePatterns(request.permission, pattern, group, ...rulesets))
  return rules.find((rule) => rule.action === "deny") ?? rules.find((rule) => rule.action === "ask") ?? rules[0]!
}

export function evaluateRequestPatterns(
  request: Pick<PermissionV1.Request, "permission" | "metadata" | "patterns">,
  ...rulesets: PermissionV1.Ruleset[]
) {
  // Legacy callers return at the first prompt, so reject all denied accesses first.
  return request.patterns
    .map((pattern) => ({ pattern, rule: evaluateRequest(request, pattern, ...rulesets) }))
    .sort((a, b) => Number(b.rule.action === "deny") - Number(a.rule.action === "deny"))
}
// altimate_change end
