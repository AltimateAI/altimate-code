// Single source of truth for the de-fork spike's 3-bucket file taxonomy and
// the versioned marker-block category rule table.
//
// Every other S1 tool (census.ts, divergence.ts, replay.ts) imports its
// classification logic from here — never re-implements it. See the binding
// Codex watch-item in docs/internal/2026-07-18-defork-spike-spec.md §S1:
// "Taxonomy precedence lives ONLY in taxonomy.ts".
//
// This module is pure (no filesystem/git I/O) so it can be unit-tested with
// plain string/Set fixtures. Callers are responsible for producing the
// `upstreamPaths` set (see utils/refs.ts#loadPathsAtRef) and for reading
// file content off disk.

import { minimatch } from "minimatch"

export const TAXONOMY_VERSION = 1

// ─────────────────────────────────────────────────────────────────────────
// Bucket: upstream_shared | fork_owned | fork_added_outside_boundary
// ─────────────────────────────────────────────────────────────────────────

export type Bucket = "upstream_shared" | "fork_owned" | "fork_added_outside_boundary"

/**
 * Approved fork-owned roots (glob patterns matched against a repo-relative,
 * forward-slash-normalized path). A path only reaches this list if it does
 * NOT exist in the upstream tree (bucket 1 always wins — see classifyBucket).
 *
 * Sourced from:
 *  - the S1 task assignment's explicit list (**\/altimate/**, packages/drivers,
 *    packages/dbt-tools, script/upstream, docs/, .opencode/, fork test dirs)
 *  - cross-referenced against script/upstream/utils/config.ts's `keepOurs`
 *    array, which independently confirms most of these roots as fork-owned
 *    for bridge-merge purposes.
 *
 * KNOWN GAP FIXED HERE: config.ts's `keepOurs` does NOT list
 * `packages/dbt-tools/**` even though that package is real, populated, and
 * has no upstream counterpart (confirmed via `ls packages/` and via the
 * census.ts prototype's own `isForkOwned()` check). taxonomy.ts's list is
 * intentionally independent of `keepOurs` rather than re-exporting it, since
 * `keepOurs` serves a different purpose (bridge-merge overlay exclusion) and
 * has known gaps we don't want to silently inherit.
 */
export const FORK_OWNED_ROOTS: readonly string[] = [
  "**/altimate/**", // packages/opencode/src/altimate/**, packages/opencode/test/altimate/**, etc.
  "packages/altimate-engine/**",
  "packages/drivers/**",
  "packages/dbt-tools/**", // gap vs config.ts keepOurs — real, populated, upstream has no equivalent
  "packages/opencode/src/bridge/**", // effect->promise compat shim, net-new
  "packages/opencode/src/memory/**", // net-new altimate feature
  "packages/opencode/test/upstream/**", // fork's own upstream-tooling tests
  "packages/opencode/test/branding/**",
  "script/upstream/**",
  "docs/**",
  ".opencode/**",
  ".claude/**", // Claude Code project config/skills/rules — fork-authored, no upstream OpenCode equivalent
  "sdks/**", // altimate-authored client SDKs, not part of upstream OpenCode's package set
  "experiments/**", // fork-owned scratch/spike work (benchmarks, prototypes), never upstreamed
  ".github/meta/**", // fork-only CI/process metadata (e.g. merge reports), not part of upstream's workflow set
]

/**
 * Classify a repo-relative path into one of the three buckets.
 *
 * Precedence (unconditional, in this order):
 *   1. upstream_shared  — path exists in the upstream tree (`upstreamPaths`),
 *      regardless of whether it also matches a fork-owned root. This is what
 *      lets e.g. `.opencode/.gitignore` (a real overlap path) classify
 *      correctly even though `.opencode/**` is otherwise fork-owned.
 *   2. fork_owned        — path matches one of FORK_OWNED_ROOTS.
 *   3. fork_added_outside_boundary — neither of the above ("misplacement debt").
 */
export function classifyBucket(relPath: string, upstreamPaths: ReadonlySet<string>): Bucket {
  const normalized = normalizePath(relPath)
  if (upstreamPaths.has(normalized)) return "upstream_shared"
  if (FORK_OWNED_ROOTS.some((pattern) => minimatch(normalized, pattern))) return "fork_owned"
  return "fork_added_outside_boundary"
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "")
}

// ─────────────────────────────────────────────────────────────────────────
// Category rule table
// ─────────────────────────────────────────────────────────────────────────

/**
 * Primary categories — what functional area of the product a marker block
 * touches. Sourced from spec §2's category table (as relayed in the S1 task
 * assignment).
 */
export type PrimaryCategory =
  | "TOOL_REGISTRY"
  | "TELEMETRY_CALLSITE"
  | "TRACING_CALLSITE"
  | "CONFIG_SCHEMA"
  | "BRANDING"
  | "TUI"
  | "CLI_CMDS"
  | "PROVIDER_AUTH"
  | "SESSION_LOOP"
  | "MCP_DISCOVERY"
  | "PERMISSION_SAFETY"
  | "AGENT_MODES"
  | "FLAGS"
  | "COMMANDS"
  | "SERVER"
  | "COMPAT_SHIM"
  | "OTHER"

/**
 * Sub-buckets — an orthogonal "why/what kind" tag that can co-occur with a
 * primary category (multi-label).
 */
export type SubBucket = "UNCLEAR" | "ROBUSTNESS" | "TEST_ONLY" | "FEATURE" | "PKG_SPLIT_SHIM" | "LOG_NOISE" | "WIRING"

export type Category = PrimaryCategory | SubBucket

/**
 * Emitted when zero rules match a block. Distinct from the `OTHER` primary
 * category (which is itself just another rule outcome, not a fallback) —
 * UNATTRIBUTED means "the rule table has no opinion", which is a signal the
 * rule table needs a new rule, not a legitimate steady-state category.
 */
export const UNATTRIBUTED = "UNATTRIBUTED" as const
export type CategoryLabel = Category | typeof UNATTRIBUTED

export interface CategoryRule {
  id: string
  category: Category
  /**
   * "primary" rules classify PrimaryCategory (what functional area); "subBucket"
   * rules classify SubBucket (an orthogonal why/what-kind tag). This distinction
   * matters for UNATTRIBUTED: a block that matches only sub-bucket rules (e.g.
   * TEST_ONLY, ROBUSTNESS) still has no opinion on WHERE it belongs functionally,
   * so it must still carry UNATTRIBUTED alongside its sub-bucket labels — see
   * classifyCategories().
   */
  kind: "primary" | "subBucket"
  /** Applied to a lower-cased relPath and lower-cased description. */
  test: (relPath: string, description: string) => boolean
}

/**
 * Versioned category rule table. Ported from docs/internal/census/census.ts's
 * `classify()` keyword chain, split so ALL matching rules fire (multi-label)
 * instead of the prototype's first-match-wins early return, plus the
 * additional orthogonal sub-bucket rules from the S1 spec.
 *
 * Ordering is not significant for classification (every rule is evaluated),
 * but is kept roughly in prototype order for diffability against the
 * original, plus sub-bucket rules appended at the end.
 */
export const CATEGORY_RULES: readonly CategoryRule[] = [
  { id: "tui-path", category: "TUI", kind: "primary", test: (p) => p.includes("packages/tui/") },
  {
    id: "tool-registry",
    category: "TOOL_REGISTRY",
    kind: "primary",
    test: (p, d) => p.includes("/tool/registry") || p.includes("/tool/tool.ts") || (p.includes("/tool/") && (d.includes("registry") || d.includes("register"))),
  },
  {
    id: "agent-modes",
    category: "AGENT_MODES",
    kind: "primary",
    test: (p, d) =>
      p.includes("/agent/agent.ts") || (p.includes("/agent/") && (d.includes("builder") || d.includes("analyst") || d.includes("reviewer") || d.includes("agent mode") || d.includes("prompt"))),
  },
  {
    id: "permission-safety",
    category: "PERMISSION_SAFETY",
    kind: "primary",
    test: (p, d) => d.includes("permission") || d.includes("bash-safety") || d.includes("bash safety") || d.includes(" ddl ") || d.includes("deny") || p.includes("/permission/"),
  },
  { id: "telemetry", category: "TELEMETRY_CALLSITE", kind: "primary", test: (p, d) => d.includes("telemetry") || p.includes("/telemetry") },
  { id: "tracing", category: "TRACING_CALLSITE", kind: "primary", test: (p, d) => d.includes("trac") || p.includes("/trace") || p.includes("tracer") },
  {
    id: "config-schema",
    category: "CONFIG_SCHEMA",
    kind: "primary",
    test: (p, d) => p.includes("/config/config.ts") || (p.includes("/config/") && (d.includes("config") || d.includes("mcpservers") || d.includes("experimental"))),
  },
  {
    id: "branding",
    category: "BRANDING",
    kind: "primary",
    test: (p, d) =>
      d.includes("brand") ||
      d.includes("wordmark") ||
      d.includes("docs url") ||
      d.includes("welcome") ||
      d.includes("app name") ||
      d.includes("user-agent") ||
      d.includes("github app") ||
      (d.includes("install") && d.includes("url")),
  },
  { id: "cli-cmds", category: "CLI_CMDS", kind: "primary", test: (p) => p.includes("/cli/cmd/") },
  {
    id: "provider-auth",
    category: "PROVIDER_AUTH",
    kind: "primary",
    test: (p, d) => p.includes("/provider/") || p.includes("/auth/") || p.includes("/plugin/") || d.includes("models-snapshot") || d.includes("model snapshot"),
  },
  {
    id: "session-loop",
    category: "SESSION_LOOP",
    kind: "primary",
    test: (p, d) =>
      p.includes("/session/prompt.ts") ||
      p.includes("/session/system.ts") ||
      p.includes("/session/llm.ts") ||
      (p.includes("/session/") && (d.includes("validator") || d.includes("fingerprint") || d.includes("skill-selector") || d.includes("training"))),
  },
  { id: "mcp-discovery", category: "MCP_DISCOVERY", kind: "primary", test: (p, d) => p.includes("/mcp/") || d.includes("mcp discover") },
  { id: "commands", category: "COMMANDS", kind: "primary", test: (p, d) => p.includes("/command/index.ts") || (p.includes("/command/") && d.includes("slash")) },
  {
    id: "compat-shim",
    category: "COMPAT_SHIM",
    kind: "primary",
    test: (p, d) =>
      p.includes("effect/run-service") ||
      d.includes("tool-zod-compat") ||
      d.includes("zod-compat") ||
      d.includes("makeruntime") ||
      d.includes("layer.suspend") ||
      d.includes("layernode") ||
      d.includes("effect context.service") ||
      d.includes("effect schema") ||
      d.includes("effect->zod") ||
      d.includes("effect→zod") ||
      d.includes("effect runtime") ||
      d.includes("bridge the effect") ||
      d.includes("promise wrapper") ||
      (d.includes("promise-based") && d.includes("effect")),
  },
  { id: "flags", category: "FLAGS", kind: "primary", test: (p) => p.includes("/flag/flag.ts") },
  { id: "server", category: "SERVER", kind: "primary", test: (p) => p.includes("packages/server/") },
  { id: "other-fallback-shim", category: "OTHER", kind: "primary", test: (p, d) => d.includes("shim") && !p.includes("/tool/") },

  // ── Sub-buckets (orthogonal, can co-occur with a primary category) ──────
  { id: "test-only", category: "TEST_ONLY", kind: "subBucket", test: (p) => /(^|\/)(test|tests)\//.test(p) || /\.(test|spec)\.tsx?$/.test(p) },
  { id: "robustness", category: "ROBUSTNESS", kind: "subBucket", test: (_p, d) => /\b(defensive|fallback|guard|graceful|robust)\w*\b/.test(d) },
  { id: "unclear", category: "UNCLEAR", kind: "subBucket", test: (_p, d) => d.trim().length === 0 || d.trim() === "(no description)" },
  { id: "feature", category: "FEATURE", kind: "subBucket", test: (_p, d) => /\bnew feature\b|\bnet[- ]new\b/.test(d) },
  { id: "pkg-split-shim", category: "PKG_SPLIT_SHIM", kind: "subBucket", test: (p, d) => d.includes("package split") || d.includes("pkg split") || p.includes("/bridge/") },
  { id: "log-noise", category: "LOG_NOISE", kind: "subBucket", test: (_p, d) => /\blog(ging)?\b/.test(d) && /\b(noise|verbosity|silence|suppress)\w*\b/.test(d) },
  { id: "wiring", category: "WIRING", kind: "subBucket", test: (_p, d) => /\bwir(e|ing)\b/.test(d) },
]

/**
 * Classify a marker block's description/path into all matching category
 * labels (multi-label).
 *
 * UNATTRIBUTED is added whenever no PRIMARY-category rule matches — even if
 * one or more sub-bucket rules did. A sub-bucket label (e.g. TEST_ONLY,
 * ROBUSTNESS) only says "why/what kind" the block is; it says nothing about
 * WHERE it belongs functionally. A block matching only sub-bucket rules still
 * has zero opinion on functional area, so it must still surface as needing a
 * primary-category rule, not be silently treated as fully classified.
 */
export function classifyCategories(relPath: string, description: string): CategoryLabel[] {
  const p = normalizePath(relPath).toLowerCase()
  const d = (description ?? "").toLowerCase()
  const matched: Category[] = []
  let matchedPrimary = false
  for (const rule of CATEGORY_RULES) {
    if (rule.test(p, d)) {
      matched.push(rule.category)
      if (rule.kind === "primary") matchedPrimary = true
    }
  }
  const unique = [...new Set(matched)]
  return matchedPrimary ? unique : [...unique, UNATTRIBUTED]
}

/** All rule ids currently defined, for provenance in generated envelopes. */
export function categoryRuleIds(): string[] {
  return CATEGORY_RULES.map((r) => r.id)
}

// ─────────────────────────────────────────────────────────────────────────
// upstream_fix flag — orthogonal to bucket and category
// ─────────────────────────────────────────────────────────────────────────

const UPSTREAM_FIX_RE = /upstream_fix:/i

/** Whether a marker's start-line comment declares itself an `upstream_fix:`. */
export function isUpstreamFixLine(startLineText: string): boolean {
  return UPSTREAM_FIX_RE.test(startLineText)
}
