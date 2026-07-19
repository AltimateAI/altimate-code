// altimate_change - HardPolicy: single fork-owned chokepoint for non-bypassable hard denies (S3, de-fork spike)
//
// This consolidates two hard blocks that already existed in scattered form:
//   1. sql_execute DDL block (previously inline in altimate/tools/sql-execute.ts)
//   2. bash DDL block (previously inline in agent.ts's safetyDenials permission table)
// into ONE pure, synchronous, TOTAL function so every tool-execution dispatcher can call
// the same check instead of re-implementing (or forgetting) it.
//
// Design contract (see docs/internal/2026-07-18-defork-spike-spec.md §S3):
// - TOTAL: never throws, never implicitly allows on malformed input. Any internal failure
//   (bad args shape, broken rule table, classifier exception) resolves to a deny with
//   ruleID "policy_internal_error" — fail closed, not fail open.
// - PURE + SYNCHRONOUS: no I/O, no async, safe to call from both Promise-based and
//   Effect-based dispatchers without adapters.
// - v1 rules are BEHAVIOR-PRESERVING relocations of existing blocks, not new blocks. Do
//   NOT add new hard denies here (e.g. rm -rf, git push --force) without a product
//   decision — those stay ask-tier in the Ruleset, user-overridable.
// - Every check() call emits a structured audit record. The audit log — not trace
//   evidence — is the security oracle: TraceSpan.status is only ok|error (no "denied"
//   state), and denials throw DeniedError without publishing permission events, so an
//   absent execute span does NOT prove enforcement. Tests must assert against the audit
//   log and execute-not-called counters.

import { createHash } from "node:crypto"
import { Wildcard } from "@/util/wildcard"
import { classifyAndCheck } from "@/altimate/tools/sql-classify"

export namespace HardPolicy {
  // ---------------------------------------------------------------------------------
  // Public types
  // ---------------------------------------------------------------------------------

  export type Source = "native" | "plugin" | "mcp" | "batch" | "task"

  export interface Input {
    toolID: string
    source: Source
    args: unknown
    sessionID: string
    agentID?: string
    callID?: string
  }

  export type Decision = { allow: true } | { allow: false; ruleID: string; safeReason: string }

  export interface AuditRecord {
    ruleID: string
    dispatcher: Source
    toolID: string
    source: Source
    finalArgsDigest: string
    sessionID: string
    callID?: string
    decision: Decision
    timestamp: number
  }

  // ---------------------------------------------------------------------------------
  // Rule table (v1) — versioned, each rule is a relocation of a pre-existing hard block.
  // ---------------------------------------------------------------------------------

  interface Rule {
    ruleID: string
    toolID: string
    // Returns true if the args match this rule's deny condition. MUST throw (not return
    // false) if `args` is not shaped as this rule expects — that throw is caught by
    // check() and converted into a policy_internal_error deny. This keeps malformed-args
    // handling fail-closed for GOVERNED tool IDs (those with an applicable rule) without
    // extending denial behavior to tool IDs HardPolicy was never meant to touch.
    match: (args: unknown) => boolean
    safeReason: string
    positiveExamples: unknown[]
    negativeExamples: unknown[]
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
  }

  // Mirrors altimate/tools/sql-execute.ts:24-28 — same classifier, same denied types
  // (DROP DATABASE, DROP SCHEMA, TRUNCATE), same "cannot be overridden" behavior.
  function matchSqlDdl(args: unknown): boolean {
    if (!isRecord(args) || typeof args.query !== "string") {
      throw new Error("hard-policy: sql_execute args missing string 'query' field")
    }
    return classifyAndCheck(args.query).blocked
  }

  // Mirrors agent.ts's safetyDenials bash table (9 patterns; UPPER/lowercase/Title-Case
  // only — NOT fully case-insensitive, because Wildcard.match is case-sensitive on
  // non-Windows). Whole-command-string match, not per-AST-subcommand — a documented v1
  // simplification vs. bash.ts's tree-sitter subcommand splitting used for the ask-tier
  // permission flow.
  const BASH_DDL_PATTERNS = [
    "DROP DATABASE *",
    "DROP SCHEMA *",
    "TRUNCATE *",
    "drop database *",
    "drop schema *",
    "truncate *",
    "Drop Database *",
    "Drop Schema *",
    "Truncate *",
  ]

  function matchBashDdl(args: unknown): boolean {
    if (!isRecord(args) || typeof args.command !== "string") {
      throw new Error("hard-policy: bash args missing string 'command' field")
    }
    const command = args.command
    return BASH_DDL_PATTERNS.some((pattern) => Wildcard.match(command, pattern))
  }

  const SQL_DDL_SAFE_REASON =
    "DROP DATABASE, DROP SCHEMA, and TRUNCATE are blocked for safety. This cannot be overridden."
  const BASH_DDL_SAFE_REASON =
    "DROP DATABASE, DROP SCHEMA, and TRUNCATE via bash are blocked for safety. This cannot be overridden."

  export const RULES: readonly Rule[] = [
    {
      ruleID: "sql_execute_ddl_v1",
      toolID: "sql_execute",
      match: matchSqlDdl,
      safeReason: SQL_DDL_SAFE_REASON,
      positiveExamples: [{ query: "DROP DATABASE prod" }, { query: "TRUNCATE TABLE users" }],
      negativeExamples: [{ query: "SELECT 1" }, { query: "DROP TABLE staging_tmp" }],
    },
    {
      ruleID: "bash_ddl_v1",
      toolID: "bash",
      match: matchBashDdl,
      safeReason: BASH_DDL_SAFE_REASON,
      positiveExamples: [{ command: "DROP DATABASE prod" }, { command: "truncate users" }],
      negativeExamples: [{ command: "ls -la" }, { command: "DROP TABLE staging_tmp" }],
    },
  ]

  // Index rules by toolID for O(1) "is this toolID governed at all" lookups. A toolID
  // with no entry here is UNGOVERNED — check() always allows it regardless of args shape,
  // preserving "v1 is behavior-preserving, not new blocks."
  function buildRulesByTool(rules: readonly Rule[]): Map<string, Rule[]> {
    const byTool = new Map<string, Rule[]>()
    for (const rule of rules) {
      const list = byTool.get(rule.toolID) ?? []
      list.push(rule)
      byTool.set(rule.toolID, list)
    }
    return byTool
  }

  // ---------------------------------------------------------------------------------
  // Fail-closed initialization — validated once at module load. A broken rule table must
  // make app composition fail loudly (via assertInitialized() thrown at the app-runtime
  // composition seam), not silently degrade to allow-everything.
  // ---------------------------------------------------------------------------------

  function validateRuleTable(rules: readonly Rule[]): string | null {
    if (!Array.isArray(rules) || rules.length === 0) return "RULES table is empty or not an array"
    const seenIDs = new Set<string>()
    for (const rule of rules) {
      if (!rule || typeof rule !== "object") return "RULES contains a non-object entry"
      if (typeof rule.ruleID !== "string" || rule.ruleID.length === 0) return "rule missing ruleID"
      if (seenIDs.has(rule.ruleID)) return `duplicate ruleID: ${rule.ruleID}`
      seenIDs.add(rule.ruleID)
      if (typeof rule.toolID !== "string" || rule.toolID.length === 0) {
        return `rule ${rule.ruleID} missing toolID`
      }
      if (typeof rule.match !== "function") return `rule ${rule.ruleID} missing match()`
      if (typeof rule.safeReason !== "string" || rule.safeReason.length === 0) {
        return `rule ${rule.ruleID} missing safeReason`
      }
      // Positive examples must actually match; negative examples must not. A rule table
      // that fails its own examples is broken and must not silently pass through.
      for (const example of rule.positiveExamples) {
        try {
          if (!rule.match(example)) return `rule ${rule.ruleID} failed its own positive example`
        } catch {
          return `rule ${rule.ruleID} threw on its own positive example`
        }
      }
      for (const example of rule.negativeExamples) {
        try {
          if (rule.match(example)) return `rule ${rule.ruleID} matched its own negative example`
        } catch {
          return `rule ${rule.ruleID} threw on its own negative example`
        }
      }
    }
    return null
  }

  const rulesByTool = buildRulesByTool(RULES)
  const initError = validateRuleTable(RULES)

  // MCP tools are registered with a flattened id `<sanitized-client>_<sanitized-tool>`
  // (see src/mcp/index.ts's MCP.tools()), but RULES are keyed by the bare governed tool id
  // (`sql_execute`, `bash`). Without this resolution an MCP server exposing its own
  // `sql_execute` arrives as e.g. `warehouse_sql_execute`, matches no rule, and is allowed
  // to run DDL — a silent bypass. For MCP-sourced calls, also resolve a governed key that is
  // a full `_`-delimited suffix of the flattened id. Native/plugin/batch/task tools keep
  // strict exact-match (their ids are not client-prefixed), so this only ever ADDS coverage
  // for the mcp source; it never un-governs a tool that exact-match already caught.
  function resolveGovernedKey(toolID: string, source: Source): string | undefined {
    if (rulesByTool.has(toolID)) return toolID
    if (source !== "mcp") return undefined
    for (const governed of rulesByTool.keys()) {
      if (toolID.endsWith(`_${governed}`)) return governed
    }
    return undefined
  }

  /**
   * Must be called at the app-runtime composition seam so a broken rule table fails app
   * startup instead of silently allowing everything. Throws (does not process.exit —
   * this is library code) if the rule table failed self-validation at module load.
   */
  export function assertInitialized(): void {
    if (initError) {
      throw new Error(`HardPolicy: rule table failed validation and cannot be used: ${initError}`)
    }
  }

  // ---------------------------------------------------------------------------------
  // Audit probe — THE security oracle. Deterministic, in-memory, test-collectable.
  // Not the tracer: tracing is best-effort/failure-suppressing and cannot prove a deny
  // actually blocked execution. Every check() call — allow or deny, governed or not —
  // appends a record, so the audit log itself proves the chokepoint was reached.
  // ---------------------------------------------------------------------------------

  const MAX_AUDIT_LOG = 1000
  let auditLog: AuditRecord[] = []
  let auditSink: ((record: AuditRecord) => void) | null = null

  function emitAudit(record: AuditRecord): void {
    auditLog.push(record)
    // Batched trim (O(1) amortized) instead of an O(n) shift() on every call:
    // let the log overshoot, then splice the oldest entries once it grows past
    // twice the cap. check() runs on the tool-execution hot path.
    if (auditLog.length > MAX_AUDIT_LOG * 2) auditLog.splice(0, auditLog.length - MAX_AUDIT_LOG)
    // A faulty externally-installed sink must NEVER propagate out of the
    // enforcement chokepoint — check() is contractually total (never throws).
    // The decision is already computed and returned regardless of audit outcome.
    if (auditSink) {
      try {
        auditSink(record)
      } catch {
        // Intentionally swallowed: audit-side failure cannot affect enforcement.
      }
    }
  }

  /** Test support: read the in-memory audit log (oldest first). */
  export function getAuditLog(): readonly AuditRecord[] {
    return auditLog
  }

  /** Test support: reset the in-memory audit log between test cases. */
  export function clearAuditLog(): void {
    auditLog = []
  }

  /** Test support: install a callback invoked synchronously on every audit emission. */
  export function setAuditSink(sink: ((record: AuditRecord) => void) | null): void {
    auditSink = sink
  }

  // ---------------------------------------------------------------------------------
  // Deterministic, non-reversible digest of the final args snapshot — for audit
  // correlation in tests (e.g. "was the deny keyed off the post-hook-mutated args?").
  // It is a SHA-256 over the stable-stringified args, NOT the raw args: tool arguments
  // routinely carry secrets (a `write` of `.env` contents, a `bash` command with an auth
  // token). The audit log is retained (up to MAX_AUDIT_LOG records, readable via
  // getAuditLog() or an installed sink), so storing raw or truncated args would retain
  // those secrets near the start of the payload. The hash preserves the correlation
  // property (same args -> same digest, different args -> different digest) without
  // retaining the plaintext. Tests recompute the expected digest via exported digestArgs().
  // ---------------------------------------------------------------------------------

  function stableStringify(value: unknown): string {
    const seen = new WeakSet<object>()
    function normalize(input: unknown): unknown {
      if (input === undefined) return null
      if (typeof input === "function" || typeof input === "symbol") return String(input)
      if (typeof input === "bigint") return input.toString()
      if (input === null || typeof input !== "object") return input
      if (seen.has(input)) return "[circular]"
      seen.add(input)
      if (Array.isArray(input)) return input.map(normalize)
      const record = input as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) out[key] = normalize(record[key])
      return out
    }
    try {
      return JSON.stringify(normalize(value)) ?? "null"
    } catch {
      return "[unstringifiable]"
    }
  }

  function finalArgsDigest(args: unknown): string {
    return createHash("sha256").update(stableStringify(args)).digest("hex")
  }

  /**
   * Test/forensic support: the exact non-reversible digest check() records for a given
   * args snapshot. Lets tests assert the audit digest reflects the post-hook (final) args
   * HardPolicy actually evaluated, without exposing or reconstructing the plaintext.
   */
  export function digestArgs(args: unknown): string {
    return finalArgsDigest(args)
  }

  // ---------------------------------------------------------------------------------
  // The chokepoint.
  // ---------------------------------------------------------------------------------

  const INTERNAL_ERROR_RULE_ID = "policy_internal_error"
  const INTERNAL_ERROR_SAFE_REASON = "Policy could not be evaluated; denying for safety."

  export function check(input: Input): Decision {
    let decision: Decision
    let toolID = "unknown"
    let source: Source = "native"
    let sessionID = ""
    let callID: string | undefined
    let digest = ""

    try {
      if (!isRecord(input as unknown)) {
        throw new Error("hard-policy: input is not an object")
      }
      toolID = typeof input.toolID === "string" ? input.toolID : "unknown"
      source = input.source
      sessionID = typeof input.sessionID === "string" ? input.sessionID : ""
      callID = input.callID
      digest = finalArgsDigest(input.args)

      assertInitialized()

      const rules = rulesByTool.get(resolveGovernedKey(toolID, source) ?? "")
      if (!rules || rules.length === 0) {
        // Ungoverned toolID — HardPolicy has no rule for it, so it always allows,
        // regardless of args shape. Denying here would be a NEW block, not a relocation
        // of an existing one.
        decision = { allow: true }
      } else {
        let matched: Rule | null = null
        for (const rule of rules) {
          if (rule.match(input.args)) {
            matched = rule
            break
          }
        }
        decision = matched
          ? { allow: false, ruleID: matched.ruleID, safeReason: matched.safeReason }
          : { allow: true }
      }
    } catch {
      // Any failure — malformed top-level input, a rule's match() throwing on malformed
      // args, a broken rule table, or an unexpected classifier exception — fails closed.
      decision = { allow: false, ruleID: INTERNAL_ERROR_RULE_ID, safeReason: INTERNAL_ERROR_SAFE_REASON }
    }

    emitAudit({
      ruleID: decision.allow ? "" : decision.ruleID,
      dispatcher: source,
      toolID,
      source,
      finalArgsDigest: digest,
      sessionID,
      callID,
      decision,
      timestamp: Date.now(),
    })

    return decision
  }
}
