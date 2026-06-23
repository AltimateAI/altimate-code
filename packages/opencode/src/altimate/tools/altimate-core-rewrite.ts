import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreRewriteTool = Tool.define("altimate_core_rewrite", {
  description:
    "Suggest query optimization rewrites. Analyzes SQL and proposes concrete rewrites for better performance. Provide schema_context or schema_path for accurate table/column resolution. " +
    "Set verify_equivalence=true to additionally PROVE each rewrite returns the same results as the original (via semantic equivalence) before recommending it — rewrites that pass are labeled verified-safe to apply, the rest 'review before applying'. Use verify_equivalence=true whenever the rewrite may be applied automatically or correctness matters; it requires a schema.",
  parameters: z.object({
    sql: z.string().describe("SQL query to optimize"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
    verify_equivalence: z
      .boolean()
      .optional()
      .describe(
        "If true, verify each rewrite is semantically equivalent to the original before recommending it (requires a schema).",
      ),
  }),
  async execute(args) {
    try {
      const result = (await Dispatcher.call("altimate_core.rewrite", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })) as { success?: boolean; error?: string; data?: Record<string, any> } | null
      const data = (result?.data ?? {}) as Record<string, any>
      // Treat an explicit `success === false` as a failure even when the error
      // string is empty/absent — otherwise an `{ success: false, error: "" }`
      // payload would fall through to the success path and misreport results.
      const failed = result?.success === false || !!(result?.error ?? data.error)
      if (failed) {
        const error = result?.error ?? data.error ?? "rewrite failed"
        return {
          title: "Rewrite: ERROR",
          metadata: { success: false, rewrite_count: 0, verified_count: 0, unverified_count: 0, error },
          output: `Failed to generate rewrites: ${error}`,
        }
      }

      const suggestions = data.suggestions ?? data.rewrites ?? []
      const rewriteCount = suggestions.length || (data.rewritten_sql && data.rewritten_sql !== args.sql ? 1 : 0)

      // Verified mode: gate each rewrite on proven semantic equivalence to the original.
      if (args.verify_equivalence) {
        return await verifyRewrites(args, data)
      }

      return {
        title: `Rewrite: ${rewriteCount} suggestion(s)`,
        metadata: { success: result?.success, rewrite_count: rewriteCount },
        output: formatRewrite(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Rewrite: ERROR",
        metadata: { success: false, rewrite_count: 0, error: msg },
        output: `Failed: ${msg}`,
      }
    }
  },
})

/**
 * Verify each candidate rewrite against the original via altimate-core equivalence.
 * A rewrite is VERIFIED only when equivalence affirmatively returns `equivalent === true`
 * (strict boolean — never a truthy coercion). Everything else — not-equivalent,
 * can't-decide, a thrown equivalence check, or no schema — is returned UNVERIFIED
 * ("review before applying"). Conservative by design: a verified rewrite is safe to
 * apply without changing results.
 */
async function verifyRewrites(
  args: { sql: string; schema_path?: string; schema_context?: Record<string, any> },
  data: Record<string, any>,
) {
  const hasSchema = !!(args.schema_path || (args.schema_context && Object.keys(args.schema_context).length > 0))
  // Normalize whitespace only for dedup / no-op detection — do NOT case-fold:
  // lowercasing would collapse rewrites that differ only by a case-sensitive
  // string literal or quoted identifier (distinct queries) into one, dropping a
  // valid candidate before it's verified. Equivalence itself is checked by the
  // engine, not by this string compare.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()

  // Collect candidate rewrites (whole-query + per-suggestion), drop blanks/no-ops/dupes.
  const suggestions: any[] = data.suggestions ?? data.rewrites ?? []
  const raw: Array<{ sql: string; rule?: string }> = []
  if (typeof data.rewritten_sql === "string" && data.rewritten_sql.trim()) raw.push({ sql: data.rewritten_sql })
  for (const s of suggestions) {
    if (typeof s?.rewritten_sql === "string" && s.rewritten_sql.trim()) {
      raw.push({ sql: s.rewritten_sql, rule: s.rule ?? s.type })
    }
  }
  const seen = new Set<string>([norm(args.sql)])
  const candidates = raw.filter((c) => {
    const n = norm(c.sql)
    if (seen.has(n)) return false
    seen.add(n)
    return true
  })

  if (!candidates.length) {
    return {
      title: "Rewrite: no rewrites",
      metadata: { success: true, rewrite_count: 0, verified_count: 0, unverified_count: 0, has_schema: hasSchema },
      output: "No optimizations suggested for this query.",
    }
  }

  const verified: Array<{ sql: string; rule?: string; confidence?: number }> = []
  const unverified: Array<{ sql: string; rule?: string; reason: string }> = []
  for (const c of candidates) {
    if (!hasSchema) {
      unverified.push({ sql: c.sql, rule: c.rule, reason: "no schema supplied — equivalence cannot be verified" })
      continue
    }
    try {
      const eq = (await Dispatcher.call("altimate_core.equivalence", {
        sql1: args.sql,
        sql2: c.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })) as { error?: string; data?: Record<string, any> } | null
      const ed = (eq?.data ?? {}) as Record<string, any>
      if (ed.equivalent === true) {
        verified.push({ sql: c.sql, rule: c.rule, confidence: ed.confidence })
      } else {
        // Derive a specific reason. The gate stays strict (only `=== true` verifies);
        // this just explains WHY a rewrite is unverified so callers can act on it.
        const diffs = Array.isArray(ed.differences) ? ed.differences : []
        let reason: string
        if (eq?.error ?? ed.error) {
          reason = String(eq?.error ?? ed.error)
        } else if (!("equivalent" in ed)) {
          reason = "missing 'equivalent' field in equivalence response"
        } else if (typeof ed.equivalent !== "boolean") {
          reason = `non-boolean 'equivalent' value (${typeof ed.equivalent})`
        } else if (diffs.length) {
          reason = `not proven equivalent: ${diffs
            .map((d: any) => d?.description)
            .filter(Boolean)
            .slice(0, 2)
            .join("; ")}`
        } else {
          reason = "could not be proven equivalent"
        }
        unverified.push({ sql: c.sql, rule: c.rule, reason })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      unverified.push({ sql: c.sql, rule: c.rule, reason: `equivalence check failed: ${msg}` })
    }
  }

  return {
    title: `Rewrite (verified): ${verified.length} verified, ${unverified.length} unverified`,
    metadata: {
      success: true,
      rewrite_count: candidates.length,
      verified_count: verified.length,
      unverified_count: unverified.length,
      has_schema: hasSchema,
    },
    output: formatVerified(verified, unverified, hasSchema),
  }
}

function formatVerified(
  verified: Array<{ sql: string; rule?: string; confidence?: number }>,
  unverified: Array<{ sql: string; rule?: string; reason: string }>,
  hasSchema: boolean,
): string {
  const lines: string[] = []
  if (verified.length) {
    lines.push("✓ VERIFIED-EQUIVALENT optimizations (safe to apply — proven to return the same results):")
    for (const v of verified) {
      lines.push(`  • ${v.rule ?? "rewrite"}${v.confidence != null ? ` (confidence ${v.confidence})` : ""}`)
      lines.push(`    ${v.sql}`)
    }
    lines.push("")
  }
  if (unverified.length) {
    lines.push("⚠ UNVERIFIED optimizations (review before applying — equivalence NOT proven):")
    for (const u of unverified) {
      lines.push(`  • ${u.rule ?? "rewrite"} — ${u.reason}`)
      lines.push(`    ${u.sql}`)
    }
    lines.push("")
  }
  if (!verified.length && !unverified.length) return "No optimizations suggested for this query."
  if (!hasSchema) {
    lines.push(
      "Note: no schema was supplied, so no rewrite could be verified. Provide schema_context or schema_path to verify equivalence.",
    )
  } else if (!verified.length) {
    lines.push("Note: optimizations were found but none could be proven equivalent. Apply only after manual review.")
  }
  return lines.join("\n").trimEnd()
}

function formatRewrite(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const suggestions = data.suggestions ?? data.rewrites ?? []
  if (!suggestions.length) {
    if (data.rewritten_sql) return `Optimized SQL:\n${data.rewritten_sql}`
    return "No rewrites suggested."
  }
  const lines: string[] = []
  // Use first suggestion's rewritten_sql if top-level rewritten_sql not present
  const bestSql = data.rewritten_sql ?? suggestions[0]?.rewritten_sql
  if (bestSql) {
    lines.push("Optimized SQL:")
    lines.push(bestSql)
    lines.push("")
  }
  lines.push("Rewrites applied:")
  for (const r of suggestions) {
    lines.push(`  - ${r.rule ?? r.type ?? "rewrite"}: ${r.explanation ?? r.description ?? r.improvement ?? ""}`)
  }
  return lines.join("\n")
}
