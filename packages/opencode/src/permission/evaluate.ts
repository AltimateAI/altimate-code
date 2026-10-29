// altimate_change start — upstream_fix: match equivalent path spellings with one rule precedence
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/util/log"

const log = Log.create({ service: "permission" })

// `pattern` is the spelling the caller authored; `aliases` are equivalent normalized
// spellings. An alias only ever tightens a decision: the result is the strictest of the
// authored spelling's rule and the last rule matching it or, for deny/ask rules, an alias.
// An alias match can never relax a stricter authored match.
const STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const

function matchPattern(permission: string, input: string, pattern: string) {
  return permission === "external_directory" || permission === "sensitive_write"
    ? Wildcard.matchPath(input, pattern)
    : Wildcard.match(input, pattern)
}

// An external_directory request also asks for the symlink-resolved directory of its path. That
// resolved pattern is evaluated with every external_directory rule followed by its own resolved
// spelling (its "twin"), so an allowed folder reached through a symlink stays allowed while a
// link from an allowed folder into a denied one is caught. The path as written is always decided
// by the configured rules alone, exactly as without this check, and the request needs both, so
// the resolved check can only tighten a decision, never loosen it.
function resolvedTwin(pattern: string) {
  const segments = pattern.split(process.platform === "win32" ? /[\\/]/ : "/")
  const wildcard = segments.findIndex((segment) => /[*?]/.test(segment))
  if (wildcard <= 0) return
  const dir = segments.slice(0, wildcard).join(path.sep) || path.sep
  // Only path patterns have a directory to resolve; a pattern such as "rm -rf /tmp/*" does not.
  if (!path.isAbsolute(dir)) return
  const resolved = (() => {
    try {
      return Filesystem.realLocation(dir)
    } catch (error) {
      // A link loop in a configured directory just leaves the rule without a twin.
      log.debug("no resolved twin for external_directory rule", { pattern, error: String(error) })
      return undefined
    }
  })()
  if (!resolved || resolved === dir) return
  const twin = path.join(resolved, ...segments.slice(wildcard))
  return process.platform === "win32" ? FSUtil.normalizePathPattern(twin) : twin
}

function withResolvedTwins(rules: PermissionV1.Rule[]) {
  const twins = new Map<string, string | undefined>()
  const twinOf = (pattern: string) => {
    if (!twins.has(pattern)) twins.set(pattern, resolvedTwin(pattern))
    return twins.get(pattern)
  }
  return rules.flatMap((rule) => {
    // Every rule here already applies to external_directory, including wildcard-permission rules.
    const twin = twinOf(rule.pattern)
    return twin ? [rule, { ...rule, pattern: twin }] : [rule]
  })
}

function resolvedPatterns(request: Pick<PermissionV1.Request, "metadata">) {
  const value = request.metadata.resolvedPatterns
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function evaluatePatterns(
  permission: string,
  pattern: string,
  aliases: string[],
  resolved: boolean,
  ...rulesets: PermissionV1.Ruleset[]
): PermissionV1.Rule {
  const matching = rulesets.flat().filter((rule) => Wildcard.match(permission, rule.permission))
  const rules = resolved && permission === "external_directory" ? withResolvedTwins(matching) : matching
  const authored = rules.findLast((rule) => matchPattern(permission, pattern, rule.pattern)) ?? {
    action: "ask" as const,
    permission,
    pattern: "*",
  }
  // Rule order still decides: an allow rule only applies to the authored spelling.
  const aliased = rules.findLast(
    (rule) =>
      matchPattern(permission, pattern, rule.pattern) ||
      (rule.action !== "allow" && aliases.some((alias) => matchPattern(permission, alias, rule.pattern))),
  )
  return aliased && STRICTNESS[aliased.action] > STRICTNESS[authored.action] ? aliased : authored
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return evaluatePatterns(permission, pattern, [], false, ...rulesets)
}

// Evaluate a symlink-resolved external_directory pattern, as a request's resolved pattern is.
export function evaluateResolved(
  permission: string,
  pattern: string,
  ...rulesets: PermissionV1.Ruleset[]
): PermissionV1.Rule {
  return evaluatePatterns(permission, pattern, [], true, ...rulesets)
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
  const resolved = resolvedPatterns(request).includes(pattern)
  if (!groups.length) return evaluatePatterns(request.permission, pattern, [], resolved, ...rulesets)
  // Preserve rule order within each access. Distinct invocations must all be allowed,
  // even when they normalize to the same command.
  const rules = groups.map((group) => evaluatePatterns(request.permission, pattern, group, resolved, ...rulesets))
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
