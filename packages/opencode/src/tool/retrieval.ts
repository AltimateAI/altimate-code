/**
 * Tool retrieval — pick a relevant subset of tools per turn.
 *
 * With ~78 tools, sending the full set every turn floods context and adds
 * distractors that hurt tool SELECTION. This picks a relevant subset per turn:
 * a fixed always-on CORE + lexically-ranked top-k of the rest, and NEVER drops a
 * tool that's mid-trajectory (referenced by an in-flight tool call) — dropping
 * those would corrupt the conversation.
 *
 * v1 is lexical (dependency-free, deterministic, testable). An embedding +
 * cross-encoder rerank pass is a later enhancement; the `select` signature is
 * stable so wiring doesn't change.
 */

export namespace Retrieval {
  /**
   * Always-available agent essentials — never retrieved out.
   * NOTE: every entry must be a REAL registered tool id (see tool/registry.ts).
   * A name that isn't registered is silently skipped by `select` (the `all.has`
   * guard), so it's harmless but dead — keep this list honest. There is no
   * directory-listing tool registered (file discovery is `glob` / `bash ls`),
   * so no "list"/"ls" entry here.
   */
  export const CORE = [
    "bash", "read", "write", "edit", "glob", "grep",
    "task", "todowrite", "skill",
  ]

  export interface Tool {
    name: string
    description?: string
  }

  export interface Options {
    /**
     * Target size of the exposed set. NOT a hard cap: core essentials + any
     * forced `keep` (in-flight tools) are ALWAYS retained even if together they
     * exceed `topk` — dropping a referenced/core tool would corrupt the turn.
     * `topk` bounds how many extra lexically-ranked tools are added on top.
     */
    topk?: number
    /** names that MUST stay (e.g. tools referenced by in-flight tool calls). */
    keep?: Iterable<string>
    /** only retrieve when the tool count exceeds this (no-op for small sets). */
    minToolsToRetrieve?: number
  }

  export function enabled(): boolean {
    return process.env["ALTIMATE_TOOL_RETRIEVAL"] === "1"
  }

  function score(query: string, t: Tool): number {
    // Tokenize on alphanumerics + underscore so digits survive (e.g. "v2", "s3")
    // and hyphenated names split into matchable parts (e.g. "dbt-schema-verify").
    const words = new Set(query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    const hay = (t.name + " " + (t.description ?? "")).toLowerCase()
    let s = 0
    // length >= 3 so high-signal domain terms count (sql, dbt, pii, ddl, api, ssh);
    // stopwords this short rarely appear in a tool name/description so add little noise.
    for (const w of words) if (w.length >= 3 && hay.includes(w)) s += 1
    // small boost for a direct name mention
    if (words.has(t.name.toLowerCase())) s += 3
    return s
  }

  /**
   * Return the SUBSET of tool names to expose this turn. Caller deletes the rest.
   * Deterministic: core + forced-keep first, then highest-scoring others up to topk
   * (ties broken by original order for stability).
   */
  export function select(query: string, tools: Tool[], opts: Options = {}): Set<string> {
    const topk = opts.topk ?? 12
    const minToRetrieve = opts.minToolsToRetrieve ?? topk
    const all = new Set(tools.map((t) => t.name))
    // No-op for small tool sets — nothing to gain.
    if (tools.length <= minToRetrieve) return all

    const keep = new Set<string>()
    for (const n of opts.keep ?? []) if (all.has(n)) keep.add(n)
    for (const n of CORE) if (all.has(n)) keep.add(n)

    const rest = tools.filter((t) => !keep.has(t.name))
    const ranked = rest
      .map((t, i) => ({ name: t.name, s: score(query, t), i }))
      .sort((a, b) => b.s - a.s || a.i - b.i)

    for (const r of ranked) {
      if (keep.size >= topk) break
      keep.add(r.name)
    }
    return keep
  }
}
