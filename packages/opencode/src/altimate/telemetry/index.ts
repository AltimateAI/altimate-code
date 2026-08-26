import { Account } from "@/account"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Log } from "@/altimate/util/log"
// altimate_change — shared machine-id helper (race-safe, UUID-validated, size-capped)
import { getOrCreateMachineId } from "@/altimate/util/machine-id"
import { createHash, randomUUID } from "crypto"
import fs from "fs"
import path from "path"
import os from "os"

const log = Log.create({ service: "telemetry" })

// altimate_change start — telemetry query reference for Azure App Insights (KQL)
/**
 * Telemetry Module — Azure App Insights Integration
 *
 * QUERYING TELEMETRY DATA (KQL / Log Analytics):
 *
 *   customDimensions  → string fields (tool_name, model_id, provider_id, error_class, os, etc.)
 *   customMeasurements → numeric fields (tokens_input, cost, duration_ms, etc.)
 *
 * Serialization rules (see toAppInsightsEnvelopes):
 *   - typeof number  → measurements map  (customMeasurements)
 *   - typeof string  → properties map    (customDimensions)
 *   - typeof boolean → properties map    (as "true"/"false")
 *   - typeof object  → properties map    (JSON.stringify)
 *   - session_id / project_id are lifted into envelope tags, not properties
 *   - cli_version is injected into every event's properties automatically
 *
 * Example KQL:
 *
 *   // Token usage per model
 *   customEvents
 *   | where name == "generation"
 *   | extend model = tostring(customDimensions.model_id),
 *           tokens_in = todouble(customMeasurements.tokens_input),
 *           tokens_out = todouble(customMeasurements.tokens_output)
 *   | summarize avg(tokens_in), avg(tokens_out) by model
 *
 *   // Error class distribution
 *   customEvents
 *   | where name == "core_failure"
 *   | extend err = tostring(customDimensions.error_class)
 *   | summarize count() by err
 */

// altimate_change end

/** True when a test runner is driving the process rather than a real user session.
 *
 *  Deliberately keyed on test runners, NOT on CI. Running in CI is legitimate product usage —
 *  `altimate-code-actions` wraps this CLI and every invocation sets `CI`/`GITHUB_ACTIONS` — so
 *  gating on those would make a shipped product surface invisible. The polluting population was
 *  our own suites (`provider_id="test"`, `cli_version="local"`), all of which run under a test
 *  runner. `bun test` sets NODE_ENV=test, which covers both CI and developer machines.
 *
 *  Set `ALTIMATE_TELEMETRY_FORCE=true` to opt back in, or point
 *  APPLICATIONINSIGHTS_CONNECTION_STRING at your own sink — an explicit sink is always honoured.
 */
function isAutomatedRun(): boolean {
  if (process.env.ALTIMATE_TELEMETRY_FORCE === "true") return false
  if (process.env.NODE_ENV === "test") return true
  return Boolean(process.env.BUN_TEST || process.env.VITEST || process.env.JEST_WORKER_ID)
}

// altimate_change start — composed path-masking rules (shared fragments)
// R: one path-run character — anything but whitespace/separators/quotes,
// plus an apostrophe when a word character follows (O'Connor vs closing ').
const PM_R = "(?:[^\\s\\/\\\\'\"`]|'(?=[\\p{L}\\p{N}_]))"
// slash-delimited variant: backslash is path content, not a separator
const PM_R_P = "(?:[^\\s\\/'\"`]|'(?=[\\p{L}\\p{N}_]))"
// drive-relative run (`C:file.sql`, `C:dir\x`): PM_R minus the colon — a second
// colon inside the run is never a path (Snowflake `v:col`, `c::int`, `k:v`),
// and stopping at it keeps every `x:` anchor of a colon-dense run O(1).
// The separator-free form (`C:file.sql`) is the weakest evidence of all, so
// it also requires the canonical uppercase drive letter and no `:` after
// the extension — `v:geo.city::string` is a VARIANT traversal, not a file.
const PM_DR = "(?:[^\\s\\/\\\\'\"`:]|'(?=[\\p{L}\\p{N}_]))"
const PM_WORD = "(?:[\\p{L}\\p{M}\\p{N}_‘’-]|'(?=[\\p{L}\\p{N}_]))"
const PM_ANCHOR = "(^|[\\s\"'`=(,[{:;<|>)\\]}&])"
const PM_SP = "[^\\S\\t\\n\\r\\v\\f]"
const PM_EXT = "\\.[\\p{L}\\p{M}\\p{N}-]{0,29}[\\p{L}\\p{M}\\p{N}]"
// span char: path content incl. delimiters (, ; ) ] } >) that a later
// separator — or an attached dotted terminal filename (;draft.sql) —
// proves is path content — multi-word spaced runs allowed, all
// quantified units space- or separator-anchored with disjoint inner classes
// (unambiguous parse => linear time; the nested-quantifier ReDoS shape is
// banned here).
const SEP_P = "\\/"
const SEP_W = "[\\\\\\/]"
// per-letter case expansion — used instead of the i flag on home/cloud
// rules: under /iu, conformant engines case-fold \p{Lu}, which would turn
// the capitalized-tail gate into "match any word" (V8 folds; JSC does not —
// never rely on the divergence)
const pmCI = (w: string) => w.split("").map((c) => ("[" + c + c.toUpperCase() + "]")).join("")
const pmR = (sep: string) => (sep === SEP_P ? PM_R_P : PM_R)
const PM_WR = "(?:[^\\s\\/\\\\'\"`,;:\\]}>]|'(?=[\\p{L}\\p{N}_]))"
const PM_WR_P = "(?:[^\\s\\/'\"`,;:\\]}>]|'(?=[\\p{L}\\p{N}_]))"
const pmWR = (sep: string) => (sep === SEP_P ? PM_WR_P : PM_WR)
const PM_SEG_L = "(?=[^\\s'\"`]{0,128}[\\p{L}\\p{M}]|[\\s'\"`,;)\\]}>]|$)"
// Bridge proofs (after spaced words). SEG_B: the FIRST segment past the
// proving separator carries a letter (no slash-crossing — dates/fractions
// are all-digit) or the path terminates cleanly. SEG_DEEP: for longer
// bridges (3-6 words) the continuation must ALSO look like a real path —
// reach another separator or a dotted extension — so a 4+-word directory
// component ('/data/my big client folder/models/x.sql') masks while 3+
// prose words bridging to a lone slashed token ('references missing
// source raw/orders') do not.
const PM_SEG_B = "(?=[^\\s\\/\\\\'\"`]{0,64}[\\p{L}\\p{M}]|[\\s'\"`,;)\\]}>]|$)"
const PM_SEG_DEEP = "(?=[^\\s'\"`]{0,128}(?:[\\/\\\\]|" + PM_EXT + "(?=$|[\\s.,;:)\\]}!?])))"
// Component-length bounds. Spaced runs are bounded by the filesystem's
// 255-byte component limit — never by a word count: past a word cap the rest
// of the component would ship in the clear, the wrong failure mode. pmComp:
// the rest of this component reaches its proving separator within the
// limit; PM_COMP_EXT: it ends in a dotted extension within the limit.
const pmComp = (sep: string) => "(?=[^\\/\\\\\\n]{0,255}" + sep + ")"
const PM_COMP_EXT = "(?=[^\\/\\\\\\n]{0,255}" + PM_EXT + "(?=$|[\\s.,;:)\\]}!?]))"
// a spaced bridge + its proving separator: <=2 words with the first-segment
// proof, or 3+ words (one component) with the deep-continuation proof as well
const pmBridgeLight = (sep: string) =>
  "(?:(?:" + PM_SP + "{1,2}" + pmWR(sep) + "{1,64}){1,2}" + sep + PM_SEG_B + ")"
const pmBridge = (sep: string) =>
  "(?:(?:" + PM_SP + "{1,2}" + pmWR(sep) + "{1,64}){1,2}" + sep + PM_SEG_B +
  "|" + pmComp(sep) + "(?:" + PM_SP + "{1,2}" + pmWR(sep) + "{1,64}){3,64}" + sep + PM_SEG_B + PM_SEG_DEEP + ")"
const PM_ANCHOR_HOME = "(^|[\\s\"'`=(,[{:;<|>)\\]}&]|(?<=[^\\s:\\/\\\\])(?=\\/(?:" + pmCI("users") + "|" + pmCI("home") + "[sS]?)\\/))"
const pmSpan = (sep: string) =>
  "(?:[^\\s'\"`)\\]},;>]|'(?=[\\p{L}\\p{N}_])|[,;)\\]}>](?=" + pmR(sep) + "{0,256}(?:" + sep + PM_SEG_L + "|(?:" + PM_SP + "{1,2}" + pmWR(sep) + "{1,64}){1,2}" + sep + PM_SEG_B + "|" + PM_EXT + "(?=$|[\\s.,;:)\\]}!?])))|[\"'`](?=" + pmR(sep) + "{1,256}(?:" + sep + PM_SEG_L + "|(?:" + PM_SP + "{1,2}" + pmWR(sep) + "{1,64}){1,2}" + sep + PM_SEG_B + "|" + PM_EXT + "(?=$|[\\s.,;:)\\]}!?]))))"
const pmChunks = (sep: string) => "(?:" + pmBridge(sep) + pmSpan(sep) + "*){0,2}"
// terminal dotted filename: spaced words that END in an extension, bounded
// by component length (PM_COMP_EXT), not by a word count
const pmSpFile = (sep: string) => "(?:" + PM_COMP_EXT + "(?:" + PM_SP + "{1,2}" + pmR(sep) + "+){1,64}(?<=" + PM_EXT + "))?"
// a trailing word is never the drive letter of a following path: `:` ends
// it only when whitespace or the end follows (`copy C:\\a C:\\b`, `moved
// C:\\x D:y.sql` keep both paths whole; `at /x/y line: 3` still terminates)
const PM_TERM_COND = "(?:(?<!" + PM_EXT + ")" + PM_SP + "{1,2}" + PM_WORD + "+(?=$|[.,;)\\]}!?]|:(?=$|\\s)))?"
const PM_TERM_UNC =
  "(?:(?<!" + PM_EXT + ")" + PM_SP + "{1,2}" + PM_WORD + "+(?:" + PM_SP + "{1,2}(?:[\\p{Lu}\\p{Lo}]" + PM_WORD + "*|(?:v[ao]n|de[nrl]?|d[aiou]|dos|la|les?|los|bin|ibn|al|el|te[nr])(?=" + PM_SP + ")))*(?!:\\S))?"
const PM_WC = "(?:[\\p{L}\\p{N}_#@().'-]{2,}|[\\p{L}\\p{N}_#@().'+&-]{3,})"
const PM_WCC = "[\\p{L}\\p{N}_#@().'+&-]+"
const pmSpFileX = (sep: string) => "(?:" + PM_COMP_EXT + "(?:" + PM_SP + "{1,2}" + pmR(sep) + "{1,64}){1,64}(?<=" + PM_EXT + "))?"
const pmTail = (sep: string, term: string) => pmSpan(sep) + "*" + pmChunks(sep) + pmSpFile(sep) + term
// an absolute HTTP request target (`GET /api/v1/x`, `route /a/b`) is not a
// filesystem path — masking it destroys HTTP error identity. Home-rooted
// targets are still masked by the home rules (which carry no such guard).
const PM_NOT_ROUTE = "(?<!(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|route|endpoint)\\s)"
// input cap and the lookahead the rules may see past it (wider than any
// proof scan — all are bounded at the 255-byte component limit)
const PM_CAP = 8192
const PM_LOOKAHEAD = 2048
// is a `q`-quoted span still open at the end of `s`? Mirrors the quote rules'
// grammar exactly (`q(?:[^q\\]|\\.)*q`): a backslash escapes only inside a span
function pmQuoteOpen(s: string, q: string): boolean {
  let open = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (open && c === "\\") i++
    else if (c === q) open = !open
  }
  return open
}
// Known-prefix literals — the local user's home and cwd are KNOWN values,
// replaced by exact match AFTER the structural rules (structure must see the
// original string: stripping the prefix first orphans terminal spaced
// components). The literal pass mops up whatever structure missed. Exact
// matching handles every username shape (spaces, NBSP, unicode) with zero
// false positives; the structural rules below remain for paths the
// literals cannot know (other drives, UNC shares, cloud URIs, relative
// forms, WSL-mounted homes). Variants cover JSON-doubled backslashes and
// swapped separators. Same approach as Salesforce's telemetry GDPR scrub
// (os.homedir() literal) and gatsby-telemetry's cleanPaths (cwd prefixes).
const pmEscape = (v: string) => v.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&")
const pmPrefixVariants = (root: string): RegExp[] => {
  if (!root || root.length < 4) return []
  const out: RegExp[] = []
  for (const v of new Set([root, root.replace(/\\/g, "\\\\"), root.replace(/\\/g, "/")])) {
    out.push(new RegExp("(?<![\\w.-])" + pmEscape(v), "gi"))
  }
  return out
}
const PM_HOME_PREFIXES = pmPrefixVariants(os.homedir())
// The CLI chdirs into the project after this module loads (tui/attach/run),
// so the cwd literals are rebuilt whenever process.cwd() changes — a stale
// import-time cwd would miss exactly the shallow, extensionless project root
// the structural rules cannot mask.
let pmCwdCache = ""
let pmCwdPrefixes: RegExp[] = []
function pmKnownPrefixes(): RegExp[] {
  let cwd = pmCwdCache
  try {
    cwd = process.cwd()
  } catch {
    // cwd deleted or inaccessible: masking an error must never raise a
    // second one — keep the last known prefixes
  }
  if (cwd !== pmCwdCache) {
    pmCwdCache = cwd
    pmCwdPrefixes = pmPrefixVariants(cwd)
  }
  return [...pmCwdPrefixes, ...PM_HOME_PREFIXES]
}
const PATH_RULES = {
  cloud: new RegExp(PM_ANCHOR + "(?:(?:" + [pmCI("gs"), pmCI("s3") + "[anAN]?", pmCI("abfs") + "[sS]?", pmCI("wasb") + "[sS]?", pmCI("adl"), pmCI("dbfs"), pmCI("hdfs")].join("|") + "):\\/\\/|" + pmCI("file") + ":\\/{1,3})" + pmTail(SEP_P, PM_TERM_UNC), "gu"),
  windowsHome: new RegExp(PM_ANCHOR + "(?:(?:\\\\\\\\\\?\\\\)?[A-Za-z]:" + SEP_W + "{0,2}|(?:\\\\\\\\(?:\\?\\\\" + pmCI("unc") + "\\\\)?|(?<!:)\\/\\/(?=[^\\s\\/\\\\]+" + SEP_W + "))(?:" + PM_R + "{1,256}(?:" + SEP_W + "{1,2}" + PM_SEG_L + "|" + pmBridgeLight(SEP_W) + ")){0,8}|" + SEP_W + "{1,2})(?:" + pmCI("users") + "|" + pmCI("home") + "[sS]?|" + pmCI("documents") + " " + pmCI("and") + " " + pmCI("settings") + ")" + SEP_W + "{1,2}" + pmTail(SEP_W, PM_TERM_UNC), "gu"),
  windows: new RegExp(PM_ANCHOR + "(?:[A-Za-z]:" + SEP_W + "|(?<!:)\\/\\/(?=[^\\s\\/\\\\.]+" + SEP_W + ")|[A-Za-z]:(?=" + PM_DR + "{1,256}(?:" + PM_SP + "{1,2}" + PM_DR + "{1,256}){0,8}\\\\|(?=[^\\s\\/\\\\:]{0,256}[\\p{L}])" + PM_DR + "{1,256}(?:" + PM_SP + "{1,2}" + PM_DR + "{1,256}){0,8}\\/)|[A-Z]:(?=" + PM_DR + "{1,255}(?<=\\.[\\p{L}\\p{M}\\p{N}-]{0,29})(?<=[\\p{L}\\p{M}][\\p{L}\\p{M}\\p{N}-]{0,29})(?=$|[\\s.,;)\\]}!?]))|\\\\\\\\|\\.{1,2}\\\\(?=" + PM_R + "{1,256}(?:" + PM_SP + "{1,2}" + PM_R + "{1,256})*\\\\|[^\\s\\\\]{1,256}" + PM_EXT + "(?=$|[\\s.,;:)\\]}!?]))|\\\\(?=(?:" + PM_WC + "(?:" + PM_SP + "{1,2}" + PM_WCC + ")*\\\\){2}|" + PM_WC + "(?:" + PM_SP + "{1,2}" + PM_WCC + ")*\\\\[^\\s\\\\]{1,256}" + PM_EXT + "(?=$|[\\s.,;:)\\]}!?])|" + PM_WC + "(?:" + PM_SP + "{1,2}" + PM_WCC + ")+\\\\[\\p{L}\\p{N}]|[\\p{L}\\p{N}_-]\\\\(?:[\\p{L}\\p{N}_-]{2,}|\\.[\\p{L}\\p{N}_-]{2,})|[^\\s\\\\]{1,256}" + PM_EXT + "(?=$|[\\s.,;:)\\]}!?])))" + pmSpan(SEP_W) + "+" + pmChunks(SEP_W) + pmSpFile(SEP_W) + PM_TERM_COND, "gu"),
  posixHome: new RegExp(PM_ANCHOR_HOME + "\\/(?:" + PM_R_P + "{1,256}(?:\\/" + PM_SEG_L + "|" + pmBridgeLight(SEP_P) + "))*(?:" + pmCI("users") + "|" + pmCI("home") + "[sS]?)\\/" + pmTail(SEP_P, PM_TERM_UNC), "gu"),
  posix: new RegExp(PM_ANCHOR + PM_NOT_ROUTE + "(?:\\.{0,2}\\/(?:" + PM_R_P + "{1,256}(?:\\/" + PM_SEG_L + "|" + pmBridgeLight(SEP_P) + "))+" + pmTail(SEP_P, PM_TERM_COND) + "|(?:\\.{1,2}\\/|\\/(?!\\/))" + pmSpan(SEP_P) + "+" + pmSpFileX(SEP_P) + "(?<=" + PM_EXT + ")(?=$|[\\s.,;:)\\]}!?]))", "gu"),
  tilde: new RegExp(PM_ANCHOR + "~[\\p{L}\\p{M}\\p{N}_.-]*(?:\\/|\\\\(?=" + PM_WC + "(?:" + PM_SP + "{1,2}" + PM_WCC + ")*[\\\\\\/]|\\.[\\p{L}\\p{N}_-]{2,}[\\\\\\/]|[\\p{L}\\p{N}_-]\\\\(?:[\\p{L}\\p{N}_-]{2,}|\\.[\\p{L}\\p{N}_-]{2,})))" + pmTail(SEP_W, PM_TERM_UNC), "gu"),
}
// altimate_change end

export namespace Telemetry {
  const FLUSH_INTERVAL_MS = 5_000
  const MAX_BUFFER_SIZE = 200
  const REQUEST_TIMEOUT_MS = 10_000

  /**
   * altimate_change — single source of truth for the TUI exit-path flush budget, referenced by
   * BOTH the `withTimeout(client.call("shutdown", ...))` deadline on the main thread
   * (cli/cmd/tui.ts) and the worker's remaining-budget computation (cli/tui/worker.ts). They must
   * agree: the worker's buffer flush exists only because `worker.terminate()` would otherwise
   * discard it, and if the main thread's deadline were the shorter of the two it would truncate
   * the flush and silently restore the data loss this guards against.
   */
  export const TUI_SHUTDOWN_BUDGET_MS = 5000

  /** Exit-path budget for the MAIN thread's own flush. Strictly smaller than the worker's,
   *  because it runs after the worker shutdown RPC has already returned and still has to finish
   *  before `process.exit(0)`. */
  export const EXIT_FLUSH_BUDGET_MS = 2000

  export type Event =
    // altimate_change start — add os/arch/node_version for environment segmentation
    | {
        type: "session_start"
        timestamp: number
        session_id: string
        model_id: string
        provider_id: string
        agent: string
        project_id: string
        os: string
        arch: string
        node_version: string
        source?: string
      }
    // altimate_change end
    | {
        type: "session_end"
        timestamp: number
        session_id: string
        total_cost: number
        total_tokens: number
        tool_call_count: number
        duration_ms: number
      }
    | {
        type: "generation"
        timestamp: number
        session_id: string
        message_id: string
        model_id: string
        provider_id: string
        agent: string
        finish_reason: string
        cost: number
        duration_ms: number
        // Flat token fields — only present when data is available from the provider.
        // No nested objects: Azure App Insights custom measures must be top-level numbers.
        //
        // SEMANTICS (read this before writing dashboard queries):
        //   tokens_input        = UNCACHED input tokens. Equal to 0 on a full cache hit.
        //                          Normalized across providers: Anthropic (and Bedrock
        //                          Anthropic) return this directly; non-Anthropic
        //                          providers return the inclusive total and Session.getUsage
        //                          subtracts cache_read (and cache_write where present)
        //                          to derive the uncached portion. cache_write in
        //                          particular is only populated for Anthropic / Bedrock /
        //                          Venice metadata paths — OpenAI / OpenRouter don't
        //                          surface a "cache write" concept today, so the
        //                          subtraction there is a no-op.
        //   tokens_input_total  = INCLUSIVE input tokens (uncached + cache_read +
        //                          cache_write). This is what most cost/volume queries
        //                          actually want. Always present (since 2026-05-22).
        //   tokens_cache_read   = subset of tokens_input_total served from prompt cache.
        //   tokens_cache_write  = subset of tokens_input_total committed to prompt cache.
        // Invariant: tokens_input + tokens_cache_read + tokens_cache_write == tokens_input_total.
        tokens_input: number
        tokens_output: number
        // altimate_change start — total input tokens including cached. Always emitted
        // as of 2026-05-22 (previously conditional, which made dashboard queries that
        // assumed presence return null for non-cache-using providers — including the
        // false-positive "tokens_input=0 broken" finding in telemetry-2026-05-21).
        tokens_input_total: number
        // altimate_change end
        tokens_reasoning?: number // only for reasoning models
        tokens_cache_read?: number // only when a cached prompt was reused
        tokens_cache_write?: number // only when a new cache entry was written
      }
    | {
        type: "tool_call"
        timestamp: number
        session_id: string
        message_id: string
        tool_name: string
        tool_type: "standard" | "mcp"
        tool_category: string
        status: "success" | "error"
        duration_ms: number
        sequence_index: number
        previous_tool: string | null
        input_signature?: string
        error?: string
      }
    | {
        type: "native_call"
        timestamp: number
        session_id: string
        method: string
        status: "success" | "error"
        duration_ms: number
        error?: string
      }
    | {
        type: "error"
        timestamp: number
        session_id: string
        error_name: string
        error_message: string
        context: string
      }
    | {
        type: "command"
        timestamp: number
        session_id: string
        command_name: string
        command_source: "command" | "mcp" | "skill" | "unknown"
        message_id: string
      }
    | {
        type: "context_overflow_recovered"
        timestamp: number
        session_id: string
        model_id: string
        provider_id: string
        tokens_used: number
      }
    | {
        type: "compaction_triggered"
        timestamp: number
        session_id: string
        trigger: "overflow_detection" | "error_recovery"
        attempt: number
      }
    | {
        type: "tool_outputs_pruned"
        timestamp: number
        session_id: string
        count: number
        tokens_pruned: number
      }
    | {
        type: "auth_login"
        timestamp: number
        session_id: string
        provider_id: string
        method: "oauth" | "api_key"
        status: "success" | "error"
        error?: string
      }
    | {
        type: "auth_logout"
        timestamp: number
        session_id: string
        provider_id: string
      }
    | {
        type: "mcp_server_status"
        timestamp: number
        session_id: string
        server_name: string
        transport: "stdio" | "sse" | "streamable-http"
        status: "connected" | "disconnected" | "error"
        error?: string
        duration_ms?: number
      }
    | {
        type: "provider_error"
        timestamp: number
        session_id: string
        provider_id: string
        model_id: string
        error_type: string
        error_message: string
        http_status?: number
      }
    // DEPRECATED: Python engine eliminated. These event types are retained
    // for backward compatibility with existing telemetry dashboards but
    // are never fired by the native TypeScript implementation.
    | {
        type: "engine_started"
        timestamp: number
        session_id: string
        engine_version: string
        python_version: string
        extras?: string
        status: "started" | "restarted" | "upgraded"
        duration_ms: number
      }
    | {
        type: "engine_error"
        timestamp: number
        session_id: string
        phase: "uv_download" | "venv_create" | "pip_install" | "startup" | "runtime"
        error_message: string
      }
    | {
        type: "upgrade_attempted"
        timestamp: number
        session_id: string
        from_version: string
        to_version: string
        method: "npm" | "bun" | "brew" | "other"
        status: "success" | "error"
        error?: string
      }
    | {
        type: "session_forked"
        timestamp: number
        session_id: string
        parent_session_id: string
        message_count: number
      }
    | {
        type: "permission_denied"
        timestamp: number
        session_id: string
        tool_name: string
        tool_category: string
        source: "user" | "config_rule"
      }
    | {
        type: "doom_loop_detected"
        timestamp: number
        session_id: string
        tool_name: string
        repeat_count: number
      }
    | {
        type: "environment_census"
        timestamp: number
        session_id: string
        warehouse_types: string[]
        warehouse_count: number
        dbt_detected: boolean
        dbt_adapter: string | null
        dbt_model_count_bucket: string
        dbt_source_count_bucket: string
        dbt_test_count_bucket: string
        // altimate_change start — dbt project fingerprint expansion
        dbt_snapshot_count_bucket?: string
        dbt_seed_count_bucket?: string
        /** JSON-encoded Record<string, number> — count per materialization type */
        dbt_materialization_dist?: string
        dbt_macro_count_bucket?: string
        // altimate_change end
        connection_sources: string[]
        mcp_server_count: number
        skill_count: number
        os: string
        feature_flags: string[]
      }
    | {
        type: "context_utilization"
        timestamp: number
        session_id: string
        model_id: string
        tokens_used: number
        context_limit: number
        utilization_pct: number
        generation_number: number
        cache_hit_ratio: number
      }
    | {
        type: "agent_outcome"
        timestamp: number
        session_id: string
        agent: string
        tool_calls: number
        generations: number
        duration_ms: number
        cost: number
        compactions: number
        outcome: "completed" | "abandoned" | "aborted" | "error"
        // altimate_change start — agent_outcome diagnostic fields
        final_tool: string
        error_class: string
        reason: string
        // altimate_change end
      }
    | {
        type: "error_recovered"
        timestamp: number
        session_id: string
        error_type: string
        recovery_strategy: string
        attempts: number
        recovered: boolean
        duration_ms: number
      }
    | {
        type: "mcp_server_census"
        timestamp: number
        session_id: string
        server_name: string
        transport: "stdio" | "sse" | "streamable-http"
        tool_count: number
        resource_count: number
      }
    | {
        type: "mcp_discovery"
        timestamp: number
        session_id: string
        server_count: number
        server_names: string[]
        sources: string[]
      }
    | {
        type: "memory_operation"
        timestamp: number
        session_id: string
        operation: "write" | "delete"
        scope: "global" | "project"
        block_id: string
        is_update: boolean
        duplicate_count: number
        tags_count: number
      }
    | {
        type: "memory_injection"
        timestamp: number
        session_id: string
        block_count: number
        total_chars: number
        budget: number
        scopes_used: string[]
      }
    | {
        type: "warehouse_connect"
        timestamp: number
        session_id: string
        warehouse_type: string
        auth_method: string
        success: boolean
        duration_ms: number
        error?: string
        error_category?: string
      }
    | {
        type: "warehouse_query"
        timestamp: number
        session_id: string
        warehouse_type: string
        query_type: string
        success: boolean
        duration_ms: number
        row_count: number
        truncated: boolean
        error?: string
        error_category?: string
      }
    | {
        type: "warehouse_introspection"
        timestamp: number
        session_id: string
        warehouse_type: string
        operation: string
        success: boolean
        duration_ms: number
        result_count: number
        error?: string
      }
    | {
        type: "warehouse_discovery"
        timestamp: number
        session_id: string
        source: string
        connections_found: number
        warehouse_types: string[]
      }
    | {
        type: "warehouse_census"
        timestamp: number
        session_id: string
        total_connections: number
        warehouse_types: string[]
        connection_sources: string[]
        has_ssh_tunnel: boolean
        has_keychain: boolean
      }
    | {
        type: "skill_used"
        timestamp: number
        session_id: string
        message_id: string
        skill_name: string
        skill_source: "builtin" | "global" | "project"
        duration_ms: number
        // altimate_change start — skill trigger classification for discovery analytics
        trigger: "user_command" | "llm_selected" | "auto_suggested" | "unknown"
        // altimate_change end
        has_followups: boolean
        followup_count: number
      }
    // altimate_change start — first_launch event for new user counting (privacy-safe: only version + machine_id)
    | {
        type: "first_launch"
        timestamp: number
        session_id: string
        version: string
        is_upgrade: boolean
      }
    // altimate_change end
    // altimate_change start — telemetry for skill management operations
    | {
        type: "skill_created"
        timestamp: number
        session_id: string
        skill_name: string
        language: string
        source: "cli" | "tui"
      }
    | {
        type: "skill_installed"
        timestamp: number
        session_id: string
        install_source: string
        skill_count: number
        skill_names: string[]
        source: "cli" | "tui"
      }
    | {
        type: "skill_removed"
        timestamp: number
        session_id: string
        skill_name: string
        source: "cli" | "tui"
      }
    // altimate_change end
    // altimate_change start — plan refinement telemetry event
    | {
        type: "plan_revision"
        timestamp: number
        session_id: string
        revision_number: number
        action: "refine" | "approve" | "reject" | "cap_reached"
      }
    // altimate_change end
    | {
        type: "sql_execute_failure"
        timestamp: number
        session_id: string
        warehouse_type: string
        query_type: string
        error_message: string
        masked_sql: string
        duration_ms: number
      }
    // altimate_change start — feature_suggestion event for post-connect and progressive disclosure tracking
    | {
        type: "feature_suggestion"
        timestamp: number
        session_id: string
        suggestion_type: "post_warehouse_connect" | "dbt_detected" | "progressive_disclosure"
        suggestions_shown: string[]
        warehouse_type?: string
      }
    // altimate_change end
    | {
        type: "core_failure"
        timestamp: number
        session_id: string
        tool_name: string
        tool_category: string
        error_class:
          | "parse_error"
          | "connection"
          | "timeout"
          | "validation"
          | "internal"
          | "permission"
          | "http_error"
          | "file_not_found"
          | "file_stale"
          | "edit_mismatch"
          | "not_configured"
          | "resource_exhausted"
          | "unknown"
        error_message: string
        input_signature: string
        masked_args?: string
        duration_ms: number
      }
    // altimate_change start — FileTime observability: drift + assertion outcome tracking
    // Tracks the gap between Node.js wall-clock and filesystem mtime at read time.
    // Use to monitor whether the mtime clock-source change (PR #611) is preventing
    // false stale-file errors, and detect environments with significant drift.
    // KQL: customEvents | where name == "filetime_drift" | extend drift = todouble(customMeasurements.drift_ms)
    | {
        type: "filetime_drift"
        timestamp: number
        session_id: string
        /** Absolute difference in ms between Date.now() and filesystem mtime */
        drift_ms: number
        /** True if filesystem mtime is ahead of wall-clock (the problematic direction) */
        mtime_ahead: boolean
      }
    // Tracks FileTime.assert() outcomes: "stale" when a file fails the check.
    // High volume of "stale" with low delta_ms suggests tolerance is too tight.
    // KQL: customEvents | where name == "filetime_assert" | extend delta = todouble(customMeasurements.delta_ms)
    | {
        type: "filetime_assert"
        timestamp: number
        session_id: string
        outcome: "stale"
        /** mtime - readTime in ms (how far ahead the file's mtime is) */
        delta_ms: number
        /** Current tolerance threshold in ms */
        tolerance_ms: number
      }
    // altimate_change end
    // altimate_change start — sql quality telemetry for issue prevention metrics
    | {
        type: "sql_quality"
        timestamp: number
        session_id: string
        tool_name: string
        tool_category: string
        finding_count: number
        /** JSON-encoded Record<string, number> — count per issue category */
        by_category: string
        has_schema: boolean
        dialect?: string
        duration_ms: number
      }
    // implicit quality signal for task outcome intelligence
    | {
        type: "task_outcome_signal"
        timestamp: number
        session_id: string
        /** Behavioral signal derived from session outcome patterns */
        signal: "accepted" | "error" | "abandoned" | "cancelled"
        /** Total tool calls in this loop() invocation */
        tool_count: number
        /** Number of LLM generation steps in this loop() invocation */
        step_count: number
        /** Total session wall-clock duration in milliseconds */
        duration_ms: number
        /** Last tool category the agent used (or "none") */
        last_tool_category: string
      }
    // task intent classification for understanding DE problem distribution
    | {
        type: "task_classified"
        timestamp: number
        session_id: string
        /** Classified intent category */
        intent:
          | "debug_dbt"
          | "write_sql"
          | "optimize_query"
          | "build_model"
          | "analyze_lineage"
          | "explore_schema"
          | "migrate_sql"
          | "manage_warehouse"
          | "finops"
          | "general"
        /** Keyword match confidence: 1.0 for strong match, 0.5 for weak */
        confidence: number
        /** Detected warehouse type from fingerprint (or "unknown") */
        warehouse_type: string
      }
    // schema complexity signal — structural metrics from warehouse introspection
    | {
        type: "schema_complexity"
        timestamp: number
        session_id: string
        warehouse_type: string
        /** Bucketed table count */
        table_count_bucket: string
        /** Bucketed total column count across all tables */
        column_count_bucket: string
        /** Bucketed schema count */
        schema_count_bucket: string
        /** Average columns per table (rounded to integer) */
        avg_columns_per_table: number
      }
    // sql structure fingerprint — AST shape without content
    | {
        type: "sql_fingerprint"
        timestamp: number
        session_id: string
        /** JSON-encoded statement types, e.g. ["SELECT"] */
        statement_types: string
        /** Broad categories, e.g. ["query"] */
        categories: string
        /** Number of tables referenced */
        table_count: number
        /** Number of functions used */
        function_count: number
        /** Whether the query has subqueries */
        has_subqueries: boolean
        /** Whether the query uses aggregation */
        has_aggregation: boolean
        /** Whether the query uses window functions */
        has_window_functions: boolean
        /** AST node count — proxy for complexity */
        node_count: number
      }
    // error pattern fingerprint — hashed error grouping with recovery data
    | {
        type: "error_fingerprint"
        timestamp: number
        session_id: string
        /** SHA256 hash of normalized (masked) error message for grouping */
        error_hash: string
        /** Classification from classifyError() */
        error_class: string
        /** Tool that produced the error */
        tool_name: string
        /** Tool category */
        tool_category: string
        /** Whether a subsequent tool call succeeded (error was recovered) */
        recovery_successful: boolean
        /** Tool that succeeded after the error (if recovered) */
        recovery_tool: string
      }
    // tool chain effectiveness — aggregated tool sequence + outcome at session end
    | {
        type: "tool_chain_outcome"
        timestamp: number
        session_id: string
        /** JSON-encoded ordered tool names (capped at 50) */
        chain: string
        /** Number of tools in the chain */
        chain_length: number
        /** Whether any tool call errored */
        had_errors: boolean
        /** Number of errors followed by successful tool calls */
        error_recovery_count: number
        /** Final session outcome */
        final_outcome: string
        /** Total session duration in ms */
        total_duration_ms: number
        /** Total LLM cost */
        total_cost: number
      }
    // altimate_change end
    // altimate_change start — pre-execution SQL validation telemetry
    | {
        type: "sql_pre_validation"
        timestamp: number
        session_id: string
        /** skipped = no cache or stale, passed = valid SQL, blocked = invalid SQL caught, error = validation itself failed */
        outcome: "skipped" | "passed" | "blocked" | "error"
        /** why: no_cache, stale_cache, empty_cache, valid, non_structural, structural_error, dispatcher_failed, validation_exception */
        reason: string
        /** warehouse driver type (postgres, snowflake, bigquery, ...) — enables per-warehouse catch-rate analysis */
        warehouse_type: string
        /** read / write / unknown — enables per-query-type analysis */
        query_type: string
        /** SHA-256 prefix of masked SQL — join key to sql_execute_failure events for same query */
        masked_sql_hash: string
        schema_columns: number
        /** true when schema scan hit the column-scan cap — flags samples biased by large-warehouse truncation */
        schema_truncated: boolean
        duration_ms: number
      }
    // altimate_change end
    // altimate_change start — config env-var interpolation telemetry
    | {
        type: "config_env_interpolation"
        timestamp: number
        session_id: string
        /** ${VAR} / ${VAR:-default} references encountered */
        dollar_refs: number
        /** ${VAR} with no value and no default → resolved to empty string (footgun signal) */
        dollar_unresolved: number
        /** ${VAR:-default} where default was used */
        dollar_defaulted: number
        /** $${VAR} literal escape sequences found */
        dollar_escaped: number
        /** legacy {env:VAR} references (raw injection syntax) */
        legacy_brace_refs: number
        /** {env:VAR} with no value → empty string */
        legacy_brace_unresolved: number
      }
    // altimate_change end
    // altimate_change start — plan-agent model tool-call refusal detection
    | {
        type: "plan_no_tool_generation"
        timestamp: number
        session_id: string
        message_id: string
        model_id: string
        provider_id: string
        /** "stop" finish_reason without any tool calls in the session — flags models that refuse to tool-call in plan mode */
        finish_reason: string
        /** output tokens on the stop-without-tools generation — helps distinguish "refused" (low) from "wrote a long text plan" (high) */
        tokens_output: number
      }
    // altimate_change end
    // altimate_change start — first-run onboarding funnel taxonomy.
    //
    // Event names and property names follow the product spec verbatim so the taxonomy is
    // queryable under the names it was specified with. Two naming notes for whoever writes
    // the queries:
    //   - `gateway_device_code_issued` is a spec name kept for fidelity. The gateway flow is
    //     actually a browser loopback OAuth (see altimate/plugin/altimate.ts) — there is no
    //     device code. The event means "authorize URL built and browser open attempted".
    //   - `environment_scan_completed` overlaps `environment_census` above; census stays the
    //     richer dbt/warehouse fingerprint, this one is the onboarding-shaped scan result.
    //
    // Events tagged "derived" are inferred from a proxy signal, not observed directly — the
    // activation menu is model-rendered text (src/command/template/onboard-connect.txt), so
    // there is no UI event to capture. Treat their counts as lower bounds.
    | {
        type: "onboarding_started"
        timestamp: number
        session_id: string
      }
    | {
        type: "model_picker_shown"
        timestamp: number
        session_id: string
        /** the picker mounts from several paths — without this the event over-counts first runs */
        trigger: "first_run" | "connect_command" | "big_pickle_back" | "prompt_gate"
      }
    | {
        type: "provider_selected"
        timestamp: number
        session_id: string
        /** `search_all` means the user opened the full catalogue; the provider they then chose
         *  arrives as a second event with `via_search`. `other` is any provider outside the
         *  curated five. */
        provider: "altimate_gateway" | "anthropic" | "openai" | "google" | "big_pickle" | "search_all" | "other"
        /** Raw provider id, but ONLY for publicly-known providers (see KNOWN_PROVIDER_IDS).
         *  A user-defined provider in opencode.json can be named after their company, so
         *  anything unrecognised is reported as `other` with this omitted. */
        provider_id?: string
        /** True when this selection came from the full catalogue after `search_all`, so the two
         *  events can be told apart from a direct pick on the curated picker. */
        via_search?: boolean
      }
    | {
        type: "big_pickle_confirm_shown"
        timestamp: number
        session_id: string
        origin: "welcome" | "model"
      }
    | {
        type: "big_pickle_choice"
        timestamp: number
        session_id: string
        choice: "accept" | "cancel"
      }
    | {
        type: "gateway_device_code_issued"
        timestamp: number
        session_id: string
      }
    | {
        type: "gateway_auth_completed"
        timestamp: number
        session_id: string
      }
    | {
        type: "gateway_auth_failed"
        timestamp: number
        session_id: string
        /** `denied` only from an explicit error callback; an unknown/invalid state never rejects
         *  the pending promise, so CSRF mismatches surface as `timeout`. Never carries error text. */
        reason: "timeout" | "denied" | "error"
      }
    | {
        type: "instance_connected"
        timestamp: number
        session_id: string
        /** measured from the authorize() call that opened the browser */
        time_to_connect_ms: number
      }
    | {
        type: "onboarding_completed"
        timestamp: number
        session_id: string
      }
    | {
        type: "scan_gate_shown"
        timestamp: number
        session_id: string
      }
    | {
        type: "scan_gate_choice"
        timestamp: number
        session_id: string
        /** `dismissed` is esc / click-away: the gate was shown but neither branch was taken, and
         *  abandonment cannot cover it because completion already fired on the same transition. */
        choice: "scan" | "skip" | "dismissed"
      }
    | {
        type: "environment_scan_completed"
        timestamp: number
        session_id: string
        has_dbt: boolean
        has_warehouse: boolean
        is_repo: boolean
        connections_found: number
        /** bounded list of short enum reasons — arrays are JSON.stringify'd into customDimensions */
        degraded: string[]
      }
    | {
        type: "activation_menu_shown"
        timestamp: number
        session_id: string
        variant: "warehouse" | "no_data"
      }
    | {
        /** derived — inferred from the first job tool/skill after the menu. `something_else`
         *  has no tool anchor and is systematically under-counted. */
        type: "activation_job_selected"
        timestamp: number
        session_id: string
        job: "sample_duck_db" | "breaks_downstream" | "sql_review" | "cost" | "something_else"
      }
    | {
        /** derived — see activation_job_selected */
        type: "first_job_completed"
        timestamp: number
        session_id: string
        job: "sample_duck_db" | "breaks_downstream" | "sql_review" | "cost" | "something_else"
      }
    | {
        /** Deliberately a `success` boolean rather than a `sample_setup_failed` sibling, unlike
         *  the gateway_auth_completed/_failed pair. The gateway has genuinely distinct failure
         *  modes worth their own enum (timeout / denied / error); this tool either materialised
         *  the sample or did not, and the useful breakdown is `reused`, which only exists on the
         *  success path. Splitting it would duplicate the counts an analyst has to add back up. */
        type: "sample_setup_completed"
        timestamp: number
        session_id: string
        success: boolean
        /** counts come from the shipped jaffle-shop manifest; the target path is never sent */
        models: number
        tables: number
        /** the tool is deliberately re-callable (reuse / reset / install-alongside) */
        reused: boolean
      }
    | {
        type: "first_prompt_sent"
        timestamp: number
        session_id: string
      }
    | {
        type: "onboarding_abandoned"
        timestamp: number
        session_id: string
        /** last funnel stage observed before exit without a completion */
        last_stage: string
      }
  // altimate_change end

    // altimate_change start — review feature usage.
    //
    // Deliberately NO `source` field on either event: the envelope seeds `source` from
    // Flag.ALTIMATE_CLI_CLIENT and an event-declared `source` would override it. Leaving it off is
    // what makes caller attribution work with no other code — a plugin setting
    // ALTIMATE_CLI_CLIENT is already attributed.
    | {
        type: "review_run"
        timestamp: number
        /** Real session on the tool path; empty for the CLI command, which has no chat session. */
        session_id: string
        /** Which caller reached the engine. `source` says who launched the process; this says how
         *  review was invoked within it. */
        invocation: "cli" | "tool"
        status: "completed" | "failed"
        duration_ms: number
        /** Present when status is `completed`. */
        verdict?: string
        ideal_verdict?: string
        mode?: string
        tier?: string
        tier_forced?: boolean
        /** The envelope's fidelity flag: no reviewable files, no usable manifest for the changed
         *  models, OR a surfaced finding whose engine analysis was undecidable. It does NOT mean
         *  merely "no warehouse". */
        degraded?: boolean
        stale_manifest?: boolean
        critical?: number
        warning?: number
        suggestion?: number
        /** JSON object of the 14-value ReviewCategory enum, zero-filled. Counts surfaced findings
         *  after dedupe, rubric exclusion and severity threshold — not raw rule detections, and
         *  not rule-level: `Finding` does not retain a rule key. */
        by_category?: Record<string, number>
        /** Present when status is `failed`. */
        reason?: "config_error" | "git_error" | "error"
      }
    | {
        type: "review_post_outcome"
        timestamp: number
        session_id: string
        /** `partial` covers every "not fully posted as attempted" state PostResult can express —
         *  inline comments fell back, a post error was recorded, or no review id came back. The
         *  shape cannot distinguish finer outcomes than that. */
        /** `not_attempted`: publication was requested, but the invocation died between the
         *  completed review and the post attempt (a bad `--output` path, a stdout write error).
         *  Emitted from the caller's `finally` so a completed review always carries exactly one
         *  post outcome. */
        outcome: "not_requested" | "not_attempted" | "target_unresolved" | "full" | "partial" | "summary_failed"
        duration_ms: number
      }
  // altimate_change end

  /** SHA256 hash a masked error message for anonymous grouping. */
  // altimate_change start — provider identity for the onboarding funnel.
  //
  // Public provider ids only. `sync.data.provider` also contains anything the user declared in
  // their own config, and those names are frequently a company or team name — so an id that is
  // not on this list is reported as `other` with no raw value attached.
  const KNOWN_PROVIDER_IDS = new Set([
    "altimate-backend",
    "anthropic",
    "openai",
    "google",
    "opencode",
    "opencode-go",
    "github-copilot",
    "azure",
    "amazon-bedrock",
    "openrouter",
    "mistral",
    "groq",
    "deepseek",
    "xai",
    "digitalocean",
    "cerebras",
    "together",
    "fireworks",
    "vercel",
    "huggingface",
    "ollama",
    "lmstudio",
    "snowflake-cortex",
    "databricks",
  ])

  /** The curated picker's own rows map to named enum values; everything else is `other`. */
  // Null-prototype: a plain literal resolves ["constructor"], ["toString"] and ["valueOf"] to
  // truthy functions, and normalizeCustomProviderID permits lowercase letters — so a provider id of
  // `constructor` would be assigned straight to `provider` and shipped, bypassing the allowlist
  // this function exists to enforce.
  const CURATED_PROVIDER_ENUM: Record<string, string> = Object.assign(Object.create(null), {
    "altimate-backend": "altimate_gateway",
    anthropic: "anthropic",
    openai: "openai",
    google: "google",
  })

  /** Classify a provider id for `provider_selected`. Returns the enum value plus the raw id when
   *  it is safe to send. */
  export function classifyProvider(
    providerID: string,
    modelID?: string,
  ): { provider: string; provider_id?: string } {
    if (providerID === "opencode" && modelID === "big-pickle") return { provider: "big_pickle", provider_id: providerID }
    const curated = CURATED_PROVIDER_ENUM[providerID]
    if (curated) return { provider: curated, provider_id: providerID }
    return KNOWN_PROVIDER_IDS.has(providerID) ? { provider: "other", provider_id: providerID } : { provider: "other" }
  }
  // altimate_change end

  export function hashError(maskedMessage: string): string {
    return createHash("sha256").update(maskedMessage).digest("hex").slice(0, 16)
  }

  /** Classify user intent from the first message text.
   *  Pure regex/keyword matcher — zero LLM cost, <1ms. */
  export function classifyTaskIntent(text: string): { intent: string; confidence: number } {
    const lower = text.slice(0, 2000).toLowerCase()

    // Order matters: more specific patterns first
    const patterns: Array<{ intent: string; strong: RegExp[]; weak: RegExp[] }> = [
      {
        intent: "debug_dbt",
        strong: [/dbt\s+.*?(error|fail|bug|issue|broken|fix|debug|not\s+work)/],
        weak: [/dbt\s+(run|build|test|compile|parse)/, /dbt_project/, /ref\s*\(/, /source\s*\(/],
      },
      {
        intent: "build_model",
        strong: [
          /(?:create|build|write|add|new)\s+.*?(?:dbt\s+)?model/,
          /(?:create|build)\s+.*?(?:staging|mart|dim|fact)/,
        ],
        weak: [/\bmodel\b/, /materialization/, /incremental/],
      },
      {
        intent: "optimize_query",
        strong: [/optimiz|performance|slow\s+query|speed\s+up|make.*faster|too\s+slow|query\s+cost/],
        weak: [/index|partition|cluster|explain\s+plan/],
      },
      {
        intent: "write_sql",
        strong: [
          /(?:write|create|build|generate)\s+(?:a\s+)?(?:sql|query)/,
          /(?:write|create)\s+(?:a\s+)?(?:select|insert|update|delete)/,
        ],
        weak: [/\bsql\b/, /\bquery\b/, /\bjoin\b/, /\bwhere\b/],
      },
      {
        intent: "analyze_lineage",
        strong: [/lineage|upstream|downstream|dependency|depends\s+on|impact\s+analysis/],
        weak: [/dag|graph|flow|trace/],
      },
      {
        intent: "explore_schema",
        strong: [
          /(?:show|list|describe|inspect|explore)\s+.*?(?:schema|tables?|columns?|database)/,
          /what\s+.*?(?:tables|columns|schemas)/,
        ],
        weak: [/\bschema\b/, /\btable\b/, /\bcolumn\b/, /introspect/],
      },
      {
        intent: "migrate_sql",
        strong: [
          /migrat|convert.*(?:to|from)\s+.*?(?:snowflake|bigquery|postgres|redshift|databricks)/,
          /translate.*(?:sql|dialect)/,
        ],
        weak: [/dialect|transpile|port\s+(?:to|from)/],
      },
      {
        intent: "manage_warehouse",
        strong: [
          /(?:connect|setup|configure|add|test)\s+.*?(?:warehouse|connection|database)/,
          /warehouse.*(?:config|setting)/,
        ],
        weak: [/\bwarehouse\b/, /connection\s+string/, /\bcredentials\b/],
      },
      {
        intent: "finops",
        strong: [/cost|spend|bill|credits|usage|expensive\s+quer|warehouse\s+size/],
        weak: [/resource|utilization|idle/],
      },
    ]

    for (const { intent, strong, weak } of patterns) {
      if (strong.some((r) => r.test(lower))) return { intent, confidence: 1.0 }
    }
    for (const { intent, weak } of patterns) {
      if (weak.some((r) => r.test(lower))) return { intent, confidence: 0.5 }
    }
    return { intent: "general", confidence: 1.0 }
  }

  /** Derive a quality signal from the agent outcome.
   *  Exported so tests can verify the derivation logic without
   *  duplicating the implementation. */
  export function deriveQualitySignal(
    outcome: "completed" | "abandoned" | "aborted" | "error",
  ): "accepted" | "error" | "abandoned" | "cancelled" {
    switch (outcome) {
      case "abandoned":
        return "abandoned"
      case "aborted":
        return "cancelled"
      case "error":
        return "error"
      case "completed":
        return "accepted"
    }
  }

  // altimate_change start — agent_outcome diagnostic field derivation
  /** Derive diagnostic fields for the agent_outcome telemetry event.
   *  Pure helper so the logic is unit-testable without standing up a full session.
   *
   *  Why: today the agent_outcome event ships with empty reason/final_tool/error_class
   *  for every non-completed outcome, leaving ~30% of builder failures undiagnosable
   *  in telemetry. This concentrates the rules in one place and gives us a guarantee
   *  that the three fields are always populated (with explicit empty strings when
   *  the outcome carries no diagnostic info — e.g. completed sessions).
   */
  export function deriveAgentOutcomeReason(input: {
    outcome: "completed" | "abandoned" | "aborted" | "error"
    lastToolName: string | null
    lastMessageError: string | null
    abortReason: string | null
    lastErrorClass: string
  }): { final_tool: string; error_class: string; reason: string } {
    const final_tool = input.lastToolName ?? ""
    switch (input.outcome) {
      case "completed":
        return { final_tool, error_class: "", reason: "" }
      case "abandoned":
        return { final_tool, error_class: "", reason: "no_tools_invoked" }
      case "aborted": {
        const reason = maskString(input.abortReason ?? "user_cancelled").slice(0, 200)
        return { final_tool, error_class: input.lastErrorClass, reason }
      }
      case "error": {
        const msg = input.lastMessageError ?? ""
        const masked = maskString(msg).slice(0, 500)
        return {
          final_tool,
          error_class: msg ? classifyError(msg) : "unknown",
          reason: masked,
        }
      }
    }
  }
  // altimate_change end

  // altimate_change start — expanded error classification patterns for better triage
  // Order matters: earlier patterns take priority. Use specific phrases, not
  // single words, to avoid false positives (e.g., "connection refused" not "connection").
  const ERROR_PATTERNS: Array<{
    class: Telemetry.Event & { type: "core_failure" } extends { error_class: infer C } ? C : never
    keywords: string[]
  }> = [
    { class: "parse_error", keywords: ["parse", "syntax", "binder", "unexpected token", "sqlglot"] },
    {
      class: "connection",
      keywords: [
        "econnrefused",
        "enotfound",
        "econnreset",
        "connection refused",
        "connection reset",
        "connection closed",
        "connect failed",
        "connect etimedout",
        "socket hang up",
        "sasl",
        "scram",
        "password must be",
      ],
    },
    // altimate_change start — split not_configured out of connection for clearer triage
    {
      class: "not_configured",
      keywords: [
        "no warehouse configured",
        "driver not installed",
        "not found. available:",
        "unsupported database type",
        "warehouse not configured",
        "connection not configured",
      ],
    },
    // altimate_change end
    // altimate_change start — file_not_found class for file system errors
    {
      class: "file_not_found",
      keywords: [
        "file not found",
        "no such file",
        "enoent",
        "directory not found",
        "path not found",
        "file does not exist",
      ],
    },
    // altimate_change end
    // altimate_change start — edit_mismatch class for edit tool failures
    {
      class: "edit_mismatch",
      keywords: ["could not find oldstring", "no changes to apply", "oldstring and newstring are identical"],
    },
    // altimate_change end
    { class: "timeout", keywords: ["timeout", "etimedout", "bridge timeout", "timed out"] },
    {
      class: "permission",
      keywords: ["permission", "access denied", "permission denied", "unauthorized", "forbidden", "authentication"],
    },
    // altimate_change start — http_error before validation to prevent "HTTP 404" matching "invalid"/"missing"
    {
      class: "http_error",
      keywords: [
        "status code: 4",
        "status code: 5",
        "request failed with status",
        "http 404",
        "http 410",
        "http 429",
        "http 451",
        "http 403",
        // R3 audit: real provider 5xx + rate-limit messages don't carry "status code:" prefix.
        // Add bare phrases so 503 / 502 / 504 + Retry-After / "rate limit exceeded" classify
        // out of "unknown" into http_error (preserving diagnostic specificity in agent_outcome.error_class).
        "service unavailable",
        "rate limit",
        "rate_limit",
        "retry after",
        "too many requests",
        "503",
        "502",
        "504",
      ],
    },
    // altimate_change end
    // altimate_change start — split file_stale out of validation for cleaner triage
    {
      class: "file_stale",
      keywords: ["must read file", "has been modified since", "before overwriting"],
    },
    {
      class: "validation",
      keywords: ["invalid params", "invalid", "missing", "required", "does not exist"],
    },
    // altimate_change end
    { class: "internal", keywords: ["internal", "assertion"] },
    // altimate_change start — resource_exhausted class for OOM/quota errors
    {
      class: "resource_exhausted",
      keywords: ["out of memory", "resource limit", "quota exceeded", "disk i/o", "enomem", "heap out of memory"],
    },
    // altimate_change end
  ]
  // altimate_change end

  export function classifyError(
    message: string,
  ): Telemetry.Event & { type: "core_failure" } extends { error_class: infer C } ? C : never {
    const lower = message.toLowerCase()
    for (const { class: cls, keywords } of ERROR_PATTERNS) {
      if (keywords.some((kw) => lower.includes(kw))) return cls
    }
    return "unknown"
  }

  export function computeInputSignature(args: Record<string, unknown>): string {
    const sig: Record<string, string> = {}
    for (const [k, v] of Object.entries(args)) {
      // altimate_change start — redact sensitive keys in input signatures
      if (isSensitiveKey(k)) {
        sig[k] = "****"
        continue
      }
      // altimate_change end
      if (v === null || v === undefined) {
        sig[k] = "null"
      } else if (typeof v === "string") {
        sig[k] = `string:${v.length}`
      } else if (typeof v === "number") {
        sig[k] = "number"
      } else if (typeof v === "boolean") {
        sig[k] = "boolean"
      } else if (Array.isArray(v)) {
        sig[k] = `array:${v.length}`
      } else if (typeof v === "object") {
        sig[k] = `object:${Object.keys(v).length}`
      } else {
        sig[k] = typeof v
      }
    }
    const result = JSON.stringify(sig)
    if (result.length <= 1000) return result
    // Drop keys from the end until the JSON fits, preserving valid JSON structure
    const keys = Object.keys(sig)
    while (keys.length > 0) {
      keys.pop()
      const truncated: Record<string, string> = {}
      for (const k of keys) truncated[k] = sig[k]
      truncated["..."] = `${Object.keys(sig).length - keys.length} more`
      const out = JSON.stringify(truncated)
      if (out.length <= 1000) return out
    }
    return JSON.stringify({ "...": `${Object.keys(sig).length} keys` })
  }

  // Mirrors altimate-sdk (Rust) SENSITIVE_KEYS — keep in sync.
  const SENSITIVE_KEYS: string[] = [
    "key",
    "api_key",
    "apikey",
    "apiKey",
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "secret_key",
    "password",
    "passwd",
    "pwd",
    "credential",
    "credentials",
    "authorization",
    "auth",
    "signature",
    "sig",
    "private_key",
    "connection_string",
    // camelCase variants not caught by prefix/suffix matching
    "authtoken",
    "accesstoken",
    "refreshtoken",
    "bearertoken",
    "jwttoken",
    "jwtsecret",
    "clientsecret",
    "appsecret",
  ]

  function isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase()
    return SENSITIVE_KEYS.some((k) => lower === k || lower.endsWith(`_${k}`) || lower.startsWith(`${k}_`))
  }

  // Order matters: strip API-key/bearer patterns BEFORE quote masking so a
  // key inside quotes still gets normalized (the quote rule replaces the
  // whole quoted span with `?`, but a key in an unquoted error message would
  // otherwise survive). Patterns chosen for the providers we ship:
  //   sk-ant-…   Anthropic
  //   sk-…       OpenAI / OpenRouter (any 20+ char trailing token)
  //   Bearer …   Authorization headers leaked in error text
  // Each match replaces with a fixed redaction so length-based fingerprinting
  // can't reconstruct the original token.

  export function maskString(s: string): string {
    // Consumers truncate masked output to <= 2000 chars; masking beyond 8 KB
    // buys nothing, and unbounded input is what turns any super-linear rule
    // into a stall. Input is cut FIRST so every rule — the linear credential/
    // quote passes included — does bounded work, and the cut must never fail
    // a rule open across the boundary. No floor gates any of this: a floor is
    // a leak past the floor.
    if (s.length <= PM_CAP) return pmMask(s)
    // the head ends at whitespace of any kind, so no token straddles it (a
    // head with no whitespace at all is one token: nothing is emitted)
    const ws = s.slice(0, PM_CAP).search(/\s\S*$/)
    const at = ws >= 0 ? ws : 0
    // a quote the cut left half-open is closed (escape-aware, mirroring the
    // quote rules, in their order) so the quote rule collapses the value
    // instead of emitting it verbatim
    let head = s.slice(0, at)
    if (pmQuoteOpen(head, "'")) head += "'"
    if (pmQuoteOpen(head.replace(/'(?:[^'\\]|\\.)*'/g, "?"), '"')) head += '"'
    // Every rule proves a path by what FOLLOWS it — a spaced component whose
    // proving separator falls past the cut would otherwise leak its words.
    // So the head is masked twice: alone, and with the text past the cut in
    // view. Only the prefix on which both agree is emitted: text the rules
    // masked the same way with and without the continuation, cut back to
    // whitespace. Whatever the continuation changes is dropped, never
    // emitted half-proven.
    const alone = pmMask(head)
    const seen = pmMask(s.slice(0, at + PM_LOOKAHEAD))
    let n = 0
    while (n < alone.length && alone[n] === seen[n]) n++
    if (n === alone.length) return alone
    const back = alone.slice(0, n).search(/\s\S*$/)
    return back >= 0 ? alone.slice(0, back).trimEnd() : ""
  }

  // the masking chain proper, on bounded input (see maskString)
  function pmMask(s: string): string {
    let out = s
      // ANSI CSI sequences (colored subprocess stderr) would otherwise split
      // tokens so neither credential nor path rules can see them
      .replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, "")
      .replace(/sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, "sk-***")
      .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer ***")
      .replace(/'(?:[^'\\]|\\.)*'/g, "?")
      .replace(/"(?:[^"\\]|\\.)*"/g, "?")
    // Fast path: a string with no separator cannot contain a path — skip the
    // whole path stack (most telemetry strings carry no path at all).
    if (out.includes("/") || out.includes("\\") || /(?<![A-Za-z0-9])[A-Z]:[^\s:\\\/]{1,255}\.[A-Za-z]/.test(out)) {
      out = out
      // altimate_change start — mask filesystem paths in error text
      // Six masking rules (cloud URIs, Windows home, Windows/UNC incl. .\ and
      // ..\, POSIX home, POSIX incl. ./ and ../, ~ incl. ~username), composed from shared
      // fragments below (PATH_RULES) — one source of truth after repeated
      // lockstep edits drifted (see PR history). Ordered after the credential
      // rules and BEFORE the email/internal-host rules so whole URIs mask
      // before userinfo can fragment into <email>. Public URL interiors are
      // structurally safe: after "https:" comes "//", which cannot start a
      // segment chain. Doctrine: over-masking is the correct failure mode.
      // HOME-ROOTED paths and CLOUD URIs consume one unconditional trailing
      // word (spaced usernames / object keys — the high-PII classes),
      // suppressed after a dotted extension so "x.sql was deleted" prose
      // survives; other rules consume a trailing word only at end-of-string /
      // before punctuation — except spaced terminal FILENAMES, which may span
      // interior words when the run ends in a dotted extension (up to 4 words
      // on deep paths, 12 on explicit shallow ./-style paths). Residue (by design): one prose word may be
      // over-masked after extensionless home/cloud paths; a non-home,
      // non-cloud path's terminal spaced component can leak ONE structure
      // word mid-sentence (no personal names in that class); a delimiter
      // followed by neither a further separator nor a dotted terminal
      // filename is a permanent boundary.
      .replace(/(^|[\s"'`=(,[{:;<|>)\]}&])[\\/]{4,}(?=$|[\s"'`,;)\]}<>|&])/g, "$1<path>")
      .replace(PATH_RULES.cloud, "$1<path>")
      // the windows rules carry the widest opener alternation — they cannot
      // match without a backslash, a boundary drive-colon, or a non-scheme //
      // both home rules REQUIRE a home-root literal, and they are the two
      // heaviest patterns: skip them unless one is present
      const hasHomeRoot = /users|homes?|documents and settings/i.test(out)
      if (out.includes("\\") || /(?<![A-Za-z0-9])[A-Za-z]:/.test(out) || /(?<!:)\/\//.test(out)) {
        if (hasHomeRoot) out = out.replace(PATH_RULES.windowsHome, "$1<path>")
        out = out.replace(PATH_RULES.windows, "$1<path>")
      }
      if (hasHomeRoot) out = out.replace(PATH_RULES.posixHome, "$1<path>")
      out = out
      .replace(PATH_RULES.posix, "$1<path>")
        .replace(PATH_RULES.tilde, "$1<path>")
      for (const re of pmKnownPrefixes()) out = out.replace(re, "<path>")
      out = out
        // a literal-prefix mask followed by a structurally-masked remainder
        // collapses to one marker
        .replace(/<path>(?:[\\/]?<path>)+/g, "<path>")
    }
    return out
      // altimate_change end
      // Email addresses — providers occasionally echo caller identity in error text.
      .replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
      // Internal hostnames in URLs — keeps parity with `parseAPICallError`'s
      // `maskInternalHost` so an error message containing the same URL doesn't
      // leak through telemetry while metadata.url is masked. Covers:
      //   *.local / *.internal / *.localhost
      //   RFC1918 IPv4: 10/8, 172.16/12, 192.168/16, plus 127/8 loopback
      //   AWS IMDS / link-local IPv4: 169.254/16
      //   IPv6 in brackets: [::1] loopback, [fc??::/[fd??:: ULA, [fe80:: link-local
      // Char class includes `+`, `#`, `,`, `;` so secrets in query/fragment
      // don't survive past the redaction marker. Over-masking is the correct
      // failure mode here.
      .replace(
        // `(?:[^\/\s@]+@)?` allows optional basic-auth userinfo
        // (`user:pass@`) before the host so URLs like
        // `https://admin:hunter2@10.0.0.5/x` are still recognized as internal
        // and redacted whole. The credential goes with the host into <internal-host>.
        /\bhttps?:\/\/(?:[^\/\s@]+@)?(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[(?:::1|fc[0-9a-f]{2}:[^\]]*|fd[0-9a-f]{2}:[^\]]*|fe80:[^\]]*)\]|[A-Za-z0-9.-]+\.(?:local|internal|localhost))(?::\d+)?[\w/.?=&%+#,;~!*'()@:-]*/gi,
        "<internal-host>",
      )
      .replace(/\s+/g, " ")
      .trim()
  }

  function maskValue(value: unknown, key?: string): unknown {
    if (key && isSensitiveKey(key)) return "****"
    if (typeof value === "string") return maskString(value)
    if (Array.isArray(value)) return value.map((v) => maskValue(v, key))
    if (value !== null && typeof value === "object") {
      const masked: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        masked[k] = maskValue(v, k)
      }
      return masked
    }
    return value
  }

  /** PII-mask tool arguments for failure telemetry.
   *  Mirrors altimate-sdk mask_value: sensitive keys → "****",
   *  string literals in SQL → ?, whitespace collapsed. Truncates to 2000 chars. */
  export function maskArgs(args: Record<string, unknown>): string {
    const masked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      masked[k] = maskValue(v, k)
    }
    const result = JSON.stringify(masked)
    if (result.length <= 2000) return result
    // Drop keys from the end until valid JSON fits, same approach as computeInputSignature
    const keys = Object.keys(masked)
    while (keys.length > 0) {
      keys.pop()
      const truncated: Record<string, unknown> = {}
      for (const k of keys) truncated[k] = masked[k]
      truncated["..."] = `${Object.keys(masked).length - keys.length} more`
      const out = JSON.stringify(truncated)
      if (out.length <= 2000) return out
    }
    return JSON.stringify({ "...": `${Object.keys(masked).length} keys` })
  }

  const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "bash"])

  // Order matters: more specific patterns (e.g. "warehouse_usage") are checked
  // before broader ones (e.g. "warehouse") to avoid miscategorization.
  const CATEGORY_PATTERNS: Array<{ category: string; keywords: string[] }> = [
    { category: "finops", keywords: ["cost", "finops", "warehouse_usage"] },
    { category: "sql", keywords: ["sql", "query"] },
    { category: "schema", keywords: ["schema", "column", "table"] },
    { category: "dbt", keywords: ["dbt"] },
    { category: "warehouse", keywords: ["warehouse", "connection"] },
    { category: "lineage", keywords: ["lineage", "dag"] },
    { category: "memory", keywords: ["memory"] },
  ]

  export function categorizeToolName(name: string, type: "standard" | "mcp"): string {
    if (type === "mcp") return "mcp"
    const n = name.toLowerCase()
    if (FILE_TOOLS.has(n)) return "file"
    for (const { category, keywords } of CATEGORY_PATTERNS) {
      if (keywords.some((kw) => n.includes(kw))) return category
    }
    return "standard"
  }

  // altimate_change start — classify how a skill was triggered for discovery analytics
  export function classifySkillTrigger(extra?: {
    [key: string]: any
  }): "user_command" | "llm_selected" | "auto_suggested" | "unknown" {
    if (!extra) return "llm_selected"
    if (extra.trigger === "user_command") return "user_command"
    if (extra.trigger === "auto_suggested") return "auto_suggested"
    if (extra.trigger === "llm_selected") return "llm_selected"
    return "unknown"
  }
  // altimate_change end

  export function bucketCount(n: number): string {
    if (n <= 0) return "0"
    if (n <= 10) return "1-10"
    if (n <= 50) return "10-50"
    if (n <= 200) return "50-200"
    return "200+"
  }

  type AppInsightsConfig = {
    iKey: string
    endpoint: string // e.g. https://xxx.applicationinsights.azure.com/v2/track
  }

  let enabled = false
  let buffer: Event[] = []
  let flushTimer: ReturnType<typeof setInterval> | undefined
  let userEmail = ""
  let machineId = ""
  let sessionId = ""
  let projectId = ""
  let appInsights: AppInsightsConfig | undefined
  let droppedEvents = 0
  let initPromise: Promise<void> | undefined
  let initDone = false
  // altimate_change — shutdown needs to cancel a flush already in flight, not just stop waiting
  // for it: `flush()` chains through inFlightFlush, so a timed-out drain still had its final
  // flush queue behind the very request it gave up on. `shuttingDown` additionally suppresses
  // the retry write-back, which would otherwise re-insert events into a buffer about to be
  // cleared and ship them under the NEXT lifecycle.
  let activeFlushAbort: AbortController | undefined
  let shuttingDown = false
  // altimate_change — in-flight shutdown, declared with the rest of the module state so init()
  // above can consult it. See shutdown() for why concurrent shutdowns must be serialized.
  let shutdownPromise: Promise<void> | undefined
  // altimate_change — init chained onto an in-flight shutdown; see init().
  let reinitPromise: Promise<void> | undefined
  // altimate_change — the currently running flush, so shutdown waits rather than racing it.
  let inFlightFlush: Promise<void> | undefined

  // altimate_change start — per-launch correlation id, shared across threads via the environment.
  // The TUI worker is spawned after the CLI middleware has already initialised telemetry on the
  // main thread, and a Worker inherits a copy of process.env, so whichever thread runs first
  // publishes the value and the other reads it. Lazy rather than module-init so importing the
  // telemetry module (in tests, tooling) does not mint ids nobody uses.
  // One id per process launch, shared with the TUI's server Worker through its environment.
  //
  // It has to be handed over explicitly at Worker construction (see cli/cmd/tui.ts). Two things
  // that look like they would work do not, both confirmed end to end:
  //   - mutating process.env after startup: a Bun Worker does not observe it, so the worker mints
  //     its own id and the two halves of the funnel become unjoinable;
  //   - deriving it from the process (pid + start time): process.uptime() is per-THREAD in Bun,
  //     so the worker computes a different start time than the main thread.
  const LAUNCH_ID_ENV = "ALTIMATE_LAUNCH_ID"

  let cachedLaunchId: string | undefined

  /** Test seam — the cache is intentionally process-lifetime, so shutdown() does not clear it. */
  export function resetLaunchIdForTest() {
    cachedLaunchId = undefined
  }

  export function launchId(): string {
    // The worker reads the value the TUI handed it through WorkerOptions.env; the main thread
    // generates it. Cached in module scope rather than written back to process.env — the worker
    // is given it explicitly, so writing it would only leak the id into every subprocess the CLI
    // spawns, for no benefit.
    if (!cachedLaunchId) cachedLaunchId = process.env[LAUNCH_ID_ENV] || randomUUID()
    return cachedLaunchId
  }
  // altimate_change end

  function parseConnectionString(cs: string): AppInsightsConfig | undefined {
    const parts: Record<string, string> = {}
    for (const segment of cs.split(";")) {
      const idx = segment.indexOf("=")
      if (idx === -1) continue
      parts[segment.slice(0, idx).trim()] = segment.slice(idx + 1).trim()
    }
    const iKey = parts["InstrumentationKey"]
    const ingestionEndpoint = parts["IngestionEndpoint"]
    if (!iKey || !ingestionEndpoint) return undefined
    const base = ingestionEndpoint.endsWith("/") ? ingestionEndpoint : ingestionEndpoint + "/"
    return { iKey, endpoint: `${base}v2/track` }
  }

  function toAppInsightsEnvelopes(events: Event[], cfg: AppInsightsConfig): object[] {
    // Process-level client, read live from the env flag (defaults to "cli") so events
    // emitted before any prompt runs — startup, connection setup, standalone CLI
    // subcommands — are labelled correctly instead of stuck at a hardcoded default.
    // Any event that already carries its own `source` field overrides this via the field
    // loop below — session_start (the per-session client, from session.metadata.source) and
    // a few pre-existing events (skill_*, connections) whose `source` means something else
    // (cli/tui, connection origin). Events without their own `source` report this value.
    const clientSource = Flag.ALTIMATE_CLI_CLIENT
    return events.map((event) => {
      const { type, timestamp, ...fields } = event as any
      const sid: string = fields.session_id ?? sessionId

      const properties: Record<string, string> = {
        cli_version: InstallationVersion,
        source: clientSource,
        project_id: fields.project_id ?? projectId,
        ...(machineId && { machine_id: machineId }),
        // altimate_change — groups every event from one process launch. The onboarding funnel
        // spans the TUI main thread and the server worker, and most of it runs before any chat
        // session exists, so `session_id` is empty for the first half and real for the second —
        // leaving no key to join a single run on. This is not persisted, not derived from the
        // machine or the user, and not reused across launches; it only says "same run".
        launch_id: launchId(),
      }
      const measurements: Record<string, number> = {}

      for (const [k, v] of Object.entries(fields)) {
        if (k === "session_id" || k === "project_id" || k === "_retried") continue
        if (typeof v === "number") {
          measurements[k] = v
        } else if (v !== undefined && v !== null) {
          properties[k] = typeof v === "object" ? JSON.stringify(v) : String(v)
        }
      }

      return {
        name: `Microsoft.ApplicationInsights.${cfg.iKey}.Event`,
        time: new Date(timestamp).toISOString(),
        iKey: cfg.iKey,
        tags: {
          "ai.session.id": sid || "startup",
          // altimate_change start — use machine_id as fallback for anonymous user identification
          // This IMPROVES privacy: previously all anonymous users shared ai.user.id=""
          // which made them appear as one mega-user in analytics. Using the random UUID
          // (already sent as a custom property) gives each machine a distinct identity
          // without any PII. machine_id is a crypto.randomUUID() stored locally.
          "ai.user.id": userEmail || machineId || "",
          // altimate_change end
          "ai.cloud.role": "altimate",
          "ai.application.ver": InstallationVersion,
        },
        data: {
          baseType: "EventData",
          baseData: {
            ver: 2,
            name: type,
            properties,
            measurements,
          },
        },
      }
    })
  }

  // Instrumentation key is intentionally public — safe to hardcode in client-side tooling.
  // Override with APPLICATIONINSIGHTS_CONNECTION_STRING env var for local dev / testing.
  const DEFAULT_CONNECTION_STRING =
    "InstrumentationKey=5095f5e6-477e-4262-b7ae-2118de18550d;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=6564474f-329b-4b7d-849e-e70cb4181294"

  // Deduplicates concurrent calls: non-awaited init() in middleware/worker
  // won't race with await init() in session prompt.
  export function init(): Promise<void> {
    // altimate_change start — never re-init across an in-flight shutdown.
    //
    // session/prompt.ts init()s at the start of every session loop and shutdown()s at the end, so a
    // new session routinely begins while the previous shutdown is still awaiting flush().
    //
    // The shutdown check must come FIRST. An earlier version tested it inside `if (!initPromise)`,
    // but doShutdown() leaves initPromise set for its whole duration — it is cleared only after
    // `await flush()`. So during the very window this protects against, the old code took the other
    // branch, handed back the stale resolved promise, and the caller tracked into a buffer that
    // doShutdown() then emptied. The guard was unreachable and the event loss was live.
    //
    // Chaining onto shutdownPromise keeps the generations separate: callers arriving mid-shutdown
    // wait for the new init rather than joining the dying one.
    if (shutdownPromise) {
      if (!reinitPromise) {
        reinitPromise = shutdownPromise
          .catch(() => {})
          .then(doInit)
          .finally(() => {
            reinitPromise = undefined
          })
        // Publish it as initPromise too. Without this, a caller arriving after the shutdown had
        // settled — but before this chained doInit() finished — saw an empty initPromise and
        // started a SECOND one, replacing the flush timer and racing over the buffer.
        initPromise = reinitPromise
        // Publishing it also makes the outgoing doShutdown()'s `initPromise === initPromiseAtShutdown`
        // reset guard miss, which used to leave initDone stuck at `true` from the dying generation
        // while shutdown had already set `enabled = false`. track()'s "initialized and disabled →
        // drop" rule then silently discarded every event emitted during the reinit — the exact
        // window this path exists to keep. Hand the new generation a pre-init state so those
        // events buffer and flush once doInit() re-enables.
        initDone = false
      }
      return reinitPromise
    }
    return (initPromise ??= doInit())
    // altimate_change end
  }

  async function doInit() {
    try {
      // altimate_change — accept "true"/"TRUE"/"1" (case-insensitive) via truthyEnv,
      // and honor the OPENCODE_DISABLE_TELEMETRY fallback promised by v0.9.4's CHANGELOG
      // (previously only wired in test fixtures, silent no-op in product).
      if (Flag.truthyEnv("ALTIMATE_TELEMETRY_DISABLED") || Flag.truthyEnv("OPENCODE_DISABLE_TELEMETRY")) {
        buffer = []
        return
      }
      // Config.get() may throw outside Instance context (e.g. CLI middleware
      // before Instance.provide()). Treat config failures as "not disabled" —
      // the env var check above is the early-init escape hatch.
      try {
        const userConfig = (await Config.get()) as any
        if (userConfig.telemetry?.disabled) {
          buffer = []
          return
        }
      } catch {
        // Config unavailable — proceed with telemetry enabled
      }
      // App Insights: env var overrides default (for dev/testing), otherwise use the baked-in key.
      // The baked-in key is refused under a test runner so suites never ship to the production
      // resource. Note this deliberately does NOT key on CI — see isAutomatedRun.
      // Telemetry's own tests set APPLICATIONINSIGHTS_CONNECTION_STRING explicitly and are unaffected —
      // only the implicit production sink is withheld. 1,020 of 3,135 machine ids in a 14-day window
      // were test processes, which regenerate their machine id every run — inflating every install
      // and active-machine metric by ~33%.
      const explicit = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      if (!explicit && isAutomatedRun()) {
        buffer = []
        return
      }
      const connectionString = explicit ?? DEFAULT_CONNECTION_STRING
      const cfg = parseConnectionString(connectionString)
      if (!cfg) {
        buffer = []
        return
      }
      appInsights = cfg
      try {
        // altimate_change start — bridge merge: Account.active() became async in v1.4.0
        const account = await Account.active()
        if (account?.email) {
          userEmail = createHash("sha256").update(account.email.toLowerCase().trim()).digest("hex")
        }
        // altimate_change end
      } catch {
        // Account unavailable — proceed without user ID
      }
      // altimate_change — use shared getOrCreateMachineId() from util/machine-id.ts.
      // Returns "" on all error conditions (ENOENT: mints new UUID; EACCES/corrupt/oversized:
      // logs + returns ""). No try/catch needed — all paths are handled inside.
      machineId = getOrCreateMachineId()
      enabled = true
      log.info("telemetry initialized", { mode: "appinsights" })
      // altimate_change — clear any existing interval before installing a new one. doInit() can
      // run more than once per process (init/shutdown cycles per session in prompt.ts), and
      // without this each extra run strands the previous timer: shutdown() only ever clears the
      // current handle, so orphans accumulate for the life of a `serve` process.
      if (flushTimer) clearInterval(flushTimer)
      const timer = setInterval(flush, FLUSH_INTERVAL_MS)
      if (typeof timer === "object" && timer && "unref" in timer) (timer as any).unref()
      flushTimer = timer
    } catch {
      buffer = []
    } finally {
      initDone = true
    }
  }

  export function setContext(opts: { sessionId: string; projectId: string }) {
    sessionId = opts.sessionId
    projectId = opts.projectId
  }

  export function getContext() {
    return { sessionId, projectId }
  }

  /** Returns true only after init() has completed and telemetry is enabled. */
  export function isEnabled(): boolean {
    return initDone && enabled
  }

  export function track(event: Event) {
    // Before init completes: buffer (flushed once init enables, or cleared if disabled).
    // After init completed and disabled telemetry: drop silently.
    if (initDone && !enabled) return
    buffer.push(event)
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.shift()
      droppedEvents++
    }
  }

  // altimate_change — `timeoutMs` lets exit paths bound the flush from the INSIDE. Racing
  // flush() against an external timer does not cancel the fetch: the losing promise keeps
  // running and can reset module state after the caller has moved on. Threading the deadline
  // into the existing AbortController actually aborts the request.
  export async function flush(timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<void> {
    // altimate_change start — serialize flushes.
    //
    // Serializing shutdown() alone was not enough: the 5s interval timer can already have spliced
    // `buffer` and be awaiting fetch when a shutdown begins. Shutdown's own flush then finds an
    // empty buffer, resets module state and returns — and in the TUI worker, terminate() follows
    // immediately, killing the timer's request mid-send. Worse, if that request fails first, its
    // retry path re-inserts events into a buffer shutdown has already cleared, and a later init()
    // ships them under the next lifecycle.
    //
    // Chaining every flush through one promise means shutdown waits for an in-flight batch instead
    // of racing it.
    inFlightFlush = (inFlightFlush ?? Promise.resolve()).then(() => doFlush(timeoutMs)).catch(() => {})
    return inFlightFlush
    // altimate_change end
  }

  async function doFlush(timeoutMs: number) {
    if (!enabled || buffer.length === 0 || !appInsights) return

    const events = buffer.splice(0, buffer.length)

    if (droppedEvents > 0) {
      events.push({
        type: "error",
        timestamp: Date.now(),
        session_id: sessionId,
        error_name: "TelemetryBufferOverflow",
        error_message: `${droppedEvents} events dropped due to buffer overflow`,
        context: "telemetry",
      } as Event)
      droppedEvents = 0
    }

    const controller = new AbortController()
    activeFlushAbort = controller
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(appInsights.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toAppInsightsEnvelopes(events, appInsights)),
        signal: controller.signal,
      })
      if (!response.ok) {
        log.debug("telemetry flush failed", { status: response.status })
      }
    } catch {
      // altimate_change — no write-back during shutdown. The buffer is cleared a few lines later
      // regardless, so re-inserting here does not save these events; it only leaves them to be
      // shipped by whatever lifecycle comes next, under a different launch id.
      if (shuttingDown) return
      // Re-add events that haven't been retried yet to avoid data loss
      const retriable = events.filter((e) => !(e as any)._retried)
      for (const e of retriable) {
        ;(e as any)._retried = true
      }
      const space = Math.max(0, MAX_BUFFER_SIZE - buffer.length)
      buffer.unshift(...retriable.slice(0, space))
    } finally {
      clearTimeout(timeout)
      if (activeFlushAbort === controller) activeFlushAbort = undefined
    }
  }

  // altimate_change start — sql quality telemetry types
  /** Lightweight finding record for quality telemetry. Only category — never SQL content. */
  export interface Finding {
    category: string
  }

  /** Aggregate an array of findings into category counts suitable for the sql_quality event. */
  export function aggregateFindings(findings: Finding[]): Record<string, number> {
    const by_category: Record<string, number> = {}
    for (const f of findings) {
      by_category[f.category] = (by_category[f.category] ?? 0) + 1
    }
    return by_category
  }
  // altimate_change end

  // altimate_change start — serialize concurrent shutdowns, and let callers bound the flush.
  //
  // shutdown() is called from several independent paths (session/prompt.ts at the end of each
  // session loop, the CLI's outer finally, and — for onboarding telemetry — the TUI exit path
  // and the TUI worker's rpc.shutdown). Two overlapping calls would both enter flush(), which
  // splices the shared buffer, so one caller can post a half-empty batch while the other drops
  // events. The in-flight promise is cleared on settle, so a later init/shutdown cycle (the
  // per-session pattern in prompt.ts) still works.
  //
  // `timeoutMs` bounds the flush from the inside. Racing shutdown() against an external timer
  // does NOT cancel it: the losing promise keeps running and resets module state after the
  // caller has already moved on. Exit paths pass a budget so the fetch itself is aborted.
  export async function shutdown(opts?: { timeoutMs?: number }) {
    if (shutdownPromise) {
      // An earlier caller is mid-flush, possibly on the default 10s budget. Returning its promise
      // unchanged would silently ignore this caller's deadline and make the exit path wait past
      // it — after which the worker is terminated anyway and the buffer is lost regardless. We
      // cannot shorten the in-flight flush, but we can stop making the caller wait for it.
      const budget = opts?.timeoutMs
      if (budget === undefined) return shutdownPromise
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        shutdownPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, budget)
        }),
      ]).catch(() => {})
      if (timer) clearTimeout(timer)
      return
    }
    shutdownPromise = doShutdown(opts?.timeoutMs).finally(() => {
      shutdownPromise = undefined
    })
    return shutdownPromise
  }

  async function doShutdown(timeoutMs?: number) {
    const initPromiseAtShutdown = initPromise
    // Wait for init to complete so we know whether telemetry is enabled
    // and have a valid endpoint to flush to.  init() is fire-and-forget
    // in CLI middleware, so it may still be in-flight when shutdown runs.
    if (initPromise) {
      try {
        await initPromise
      } catch {
        // init failed — nothing to flush
      }
    }
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = undefined
    }
    // altimate_change — drain any flush already running before the final one, so a timer batch
    // in mid-request is not abandoned and cannot write back into a buffer we are about to clear.
    const deadline = Date.now() + (timeoutMs ?? REQUEST_TIMEOUT_MS)
    shuttingDown = true
    if (inFlightFlush) {
      // Bounded: a flush already in flight uses the DEFAULT request timeout, so awaiting it
      // unbounded could burn 10s before the bounded flush below even starts — well past the 5s
      // the TUI allows the whole shutdown RPC.
      //
      // One ABSOLUTE deadline covers the drain and the final flush together. Giving each the full
      // `timeoutMs` let a slow in-flight request spend the whole budget and then hand the final
      // flush a fresh copy of it, so shutdown could still take twice what the caller allowed and
      // overrun the deadline that keeps the worker's buffer from being discarded.
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      let drained = false
      await Promise.race([
        inFlightFlush.catch(() => {}).then(() => {
          drained = true
        }),
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
        }),
      ])
      if (drainTimer) clearTimeout(drainTimer)
      if (!drained) {
        // Giving up on the wait is not enough: flush() chains onto inFlightFlush, so the final
        // flush below would queue behind the very request the drain just abandoned and inherit
        // its remaining runtime — up to the full default 10s on top of the budget. Abort it.
        activeFlushAbort?.abort()
        await inFlightFlush.catch(() => {})
      }
    }
    // Whatever the drain left of the shared deadline, never below a floor that lets the request
    // actually be made.
    await flush(Math.max(250, deadline - Date.now()))
    inFlightFlush = undefined
    shuttingDown = false
    enabled = false
    appInsights = undefined
    buffer = []
    droppedEvents = 0
    sessionId = ""
    projectId = ""
    machineId = ""
    // doInit() only assigns userEmail when Account.active() returns one, so without this a
    // logout followed by a re-init in the same process kept hashing the previous account into
    // ai.user.id.
    userEmail = ""
    // NOTE: cachedLaunchId is deliberately NOT cleared here. session/prompt.ts shuts telemetry
    // down at the end of every session, so clearing it would mint a fresh launch_id per prompt in
    // a long-lived `serve` process and shatter the per-launch correlation it exists to provide.
    // Tests use resetLaunchIdForTest() instead.
    // altimate_change — only clear initPromise if it is still the one this shutdown began with.
    // init() can set `initPromise = shutdownPromise.then(doInit)`; nulling that unconditionally
    // discards a doInit() which has not run yet, so the next init() starts a second one.
    //
    // Not covered by a test: that assignment requires initPromise to be undefined while
    // shutdownPromise is still live, and those two are cleared one statement apart — a window I
    // could not reach deterministically. Kept because it is free and obviously correct; the
    // clear-before-assign in doInit() is what actually prevents an orphaned interval, whatever
    // path leads to a second doInit.
    if (initPromise === initPromiseAtShutdown) {
      initPromise = undefined
      initDone = false
    }
  }
  // altimate_change end
}
