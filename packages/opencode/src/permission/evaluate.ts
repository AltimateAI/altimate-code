// altimate_change start — upstream_fix: match equivalent path spellings with one rule precedence
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

// `pattern` is the spelling the caller authored; `aliases` are equivalent normalized
// spellings. An alias only ever tightens a decision: the result is the strictest of the
// authored spelling's rule and the last rule matching it or, for deny/ask rules, an alias.
// An alias match can never relax a stricter authored match.
const STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const

function evaluatePatterns(
  permission: string,
  pattern: string,
  aliases: string[],
  ...rulesets: PermissionV1.Ruleset[]
): PermissionV1.Rule {
  const rules = rulesets.flat().filter((rule) => Wildcard.match(permission, rule.permission))
  const authored = rules.findLast((rule) => Wildcard.match(pattern, rule.pattern)) ?? {
    action: "ask" as const,
    permission,
    pattern: "*",
  }
  // Rule order still decides: an allow rule only applies to the authored spelling.
  const aliased = rules.findLast(
    (rule) =>
      Wildcard.match(pattern, rule.pattern) ||
      (rule.action !== "allow" && aliases.some((alias) => Wildcard.match(alias, rule.pattern))),
  )
  return aliased && STRICTNESS[aliased.action] > STRICTNESS[authored.action] ? aliased : authored
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
    ? values.filter(
        (group): group is string[] => Array.isArray(group) && group.every((value) => typeof value === "string"),
      )
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

export * as PermissionEvaluate from "./evaluate"
