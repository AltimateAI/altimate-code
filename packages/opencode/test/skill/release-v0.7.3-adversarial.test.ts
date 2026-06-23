/**
 * Adversarial tests for v0.7.3 release.
 *
 * Release content (5 telemetry-driven P0 fixes merged + 10 pre-release fixes
 * applied during multi-persona review):
 *
 *   1. finops_* tools auto-pick a warehouse when omitted (#828). Resolver
 *      lives in altimate/native/finops/warehouse-resolver.ts, used by all
 *      6 native finops handlers. Trim, case-insensitive, named DEFAULT
 *      type list, actionable error enumeration.
 *
 *   2. project_scan defensive spawn (#831). safeSpawnSync catches "binary
 *      missing" Bun throws; GitInfo.gitAvailable + gitError surface the
 *      three states (missing / corrupted / not-a-repo) distinctly. remoteUrl
 *      now strips embedded HTTPS userinfo (creds-leak hardening, pre-release).
 *      gitError.stderr is masked via Telemetry.maskString before persisting
 *      (PII hardening, pre-release).
 *
 *   3. build agent name normalization (#833). normalizeAgentName helper at
 *      session/prompt.ts. Pre-release hardening: control-char strip + NFKC
 *      + 64-char cap before the case-insensitive legacy-name compare.
 *
 *   4. tokens_input_total always-emitted + token semantics (#837). Clamp
 *      adjustedInputTokens at zero so inconsistent provider counts can't
 *      produce negative cost.
 *
 *   5. webfetch 404/410/451 failure cache (#839). 30-min TTL for permanent
 *      failures, 5-min for 451 (observer-conditional). URL normalization
 *      strips userinfo + tracking params. Pre-release: strips auth-bearing
 *      query params from the cache KEY (presigned-URL safety) and prefixes
 *      cache-hit errors with "(cached failure, Nm ago)" so an LLM can tell
 *      cache vs network apart.
 *
 * Focus: invariants a support engineer or future-release-skill run would
 * want pinned so this class of bug (P0 telemetry fix, half-shipped doc, or
 * privacy regression) can never recur silently.
 */

import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { normalizeUrlForCache } from "../../src/tool/webfetch"
import { resolveFinopsWarehouse, DEFAULT_FINOPS_TYPES } from "../../src/altimate/native/finops/warehouse-resolver"
import * as Registry from "../../src/altimate/native/connections/registry"

const REPO_ROOT = join(import.meta.dir, "../../../..")

const FINOPS_TOOLS_DOC = readFileSync(
  join(REPO_ROOT, "docs/docs/data-engineering/tools/finops-tools.md"),
  "utf-8",
)
const FINOPS_ANALYZE_CREDITS_SRC = readFileSync(
  join(REPO_ROOT, "packages/opencode/src/altimate/tools/finops-analyze-credits.ts"),
  "utf-8",
)
const FINOPS_QUERY_HISTORY_SRC = readFileSync(
  join(REPO_ROOT, "packages/opencode/src/altimate/tools/finops-query-history.ts"),
  "utf-8",
)
const PROJECT_SCAN_SRC = readFileSync(
  join(REPO_ROOT, "packages/opencode/src/altimate/tools/project-scan.ts"),
  "utf-8",
)
const PROMPT_SRC = readFileSync(
  join(REPO_ROOT, "packages/opencode/src/session/prompt.ts"),
  "utf-8",
)
const WEBFETCH_SRC = readFileSync(
  join(REPO_ROOT, "packages/opencode/src/tool/webfetch.ts"),
  "utf-8",
)
const CHANGELOG = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf-8")

// ---------------------------------------------------------------------------
// 1. finops auto-pick — code/doc/tool description alignment
// ---------------------------------------------------------------------------

describe("finops_* auto-pick — code matches docs matches tool descriptions", () => {
  test("finops-tools.md no longer says 'warehouse (required)'", () => {
    // PM persona flagged the doc/code contradiction as P0 pre-release.
    // Pin it gone so a future docs refresh can't silently put it back.
    expect(FINOPS_TOOLS_DOC).not.toMatch(/warehouse.*\(required\)/i)
  })

  test("finops-tools.md surfaces the v0.7.3+ auto-pick note", () => {
    expect(FINOPS_TOOLS_DOC).toMatch(/v0\.7\.3\+.*warehouse parameter is now optional/i)
  })

  test("finops-tools.md shows the bare (no-warehouse) form in at least one example", () => {
    // Doc should walk a user through the new ergonomic path; pre-release the
    // doc only showed `finops_analyze_credits prod-snowflake --days 30`.
    expect(FINOPS_TOOLS_DOC).toMatch(/finops_analyze_credits\s+--days/)
  })

  test("tool descriptions for finops_analyze_credits + finops_query_history say 'optional'", () => {
    expect(FINOPS_ANALYZE_CREDITS_SRC).toMatch(
      /warehouse.*Optional.*first configured.*Snowflake.*BigQuery.*Databricks/s,
    )
    expect(FINOPS_QUERY_HISTORY_SRC).toMatch(/Optional.*first configured/s)
  })

  test("warehouse_filter description disambiguates from `warehouse` (avoids LLM confusion)", () => {
    // End User persona flagged that the previous "Filter to a specific
    // Snowflake warehouse" description for warehouse_filter clashed with the
    // newly-optional `warehouse` connection param. Pin the disambiguation.
    for (const src of [FINOPS_ANALYZE_CREDITS_SRC, FINOPS_QUERY_HISTORY_SRC]) {
      expect(src).toMatch(/in-warehouse.*compute.*NOT the connection name/i)
      expect(src).toMatch(/Snowflake only/i)
    }
  })

  test("DEFAULT_FINOPS_TYPES is a single source of truth (no duplicate triples)", () => {
    // Tech Lead flagged the triplicated `["snowflake","bigquery","databricks"]`
    // literal. Pin the constant exists and is the canonical list.
    expect(DEFAULT_FINOPS_TYPES).toEqual(["snowflake", "bigquery", "databricks"])
  })

  test("resolver trims whitespace on requested name", () => {
    Registry.setConfigs({
      prod_sf: { type: "snowflake", account: "x", user: "u", password: "p" } as any,
    })
    try {
      for (const requested of ["  prod_sf", "prod_sf  ", "\tprod_sf\n", " prod_sf "]) {
        const r = resolveFinopsWarehouse({
          requested,
          supportedTypes: DEFAULT_FINOPS_TYPES,
          operationName: "Credit analysis",
        })
        expect(r.kind).toBe("ok")
        if (r.kind === "ok") expect(r.warehouse).toBe("prod_sf")
      }
    } finally {
      Registry.setConfigs({})
    }
  })

  test("resolver auto-picks on empty/undefined/whitespace requested", () => {
    Registry.setConfigs({
      prod_sf: { type: "snowflake", account: "x", user: "u", password: "p" } as any,
    })
    try {
      for (const requested of [undefined, "", "   ", "\t\n"]) {
        const r = resolveFinopsWarehouse({
          requested,
          supportedTypes: DEFAULT_FINOPS_TYPES,
          operationName: "Credit analysis",
        })
        expect(r.kind).toBe("ok")
        if (r.kind === "ok") {
          expect(r.warehouse).toBe("prod_sf")
          expect(r.autoPicked).toBe(true)
        }
      }
    } finally {
      Registry.setConfigs({})
    }
  })
})

// ---------------------------------------------------------------------------
// 2. project_scan — credential strip + stderr masking
// ---------------------------------------------------------------------------

describe("project_scan privacy hardening", () => {
  test("stripGitRemoteCredentials removes HTTPS basic-auth from remote URLs", () => {
    // Chaos / Compliance persona P1. git remote get-url returns the URL
    // verbatim including embedded creds — these flow to LLM-visible metadata
    // and persisted transcripts.
    expect(PROJECT_SCAN_SRC).toMatch(/stripGitRemoteCredentials/)
    expect(PROJECT_SCAN_SRC).toMatch(/parsed\.username\s*=\s*""/)
    expect(PROJECT_SCAN_SRC).toMatch(/parsed\.password\s*=\s*""/)
  })

  test("gitError.stderr is masked via Telemetry.maskString before persisting", () => {
    // Raw git stderr contains paths-with-usernames, commit emails on bad-object
    // errors, and unmasked HTTPS remote URLs on auth failures. Pre-release
    // fix routes it through the existing masker.
    expect(PROJECT_SCAN_SRC).toMatch(/Telemetry\.maskString\(\s*isRepoResult\.stderr/)
  })

  test("gitError.stderr is length-capped after masking (not before)", () => {
    // Mask first, then slice — otherwise we could slice mid-mask-replacement
    // and surface a half-redacted email. The mask replacements can shift
    // length minimally so the order matters.
    const block = PROJECT_SCAN_SRC.match(/maskedStderr[\s\S]{0,300}/)?.[0] ?? ""
    expect(block).toMatch(/maskString[\s\S]*?\.slice\(/) // slice comes AFTER mask
  })

  test("safeSpawnSync returns null on missing binary (no throw escapes)", () => {
    // Existing contract; pin so a refactor can't reintroduce the original
    // 437-user "Executable not found in $PATH: ?" bug.
    expect(PROJECT_SCAN_SRC).toMatch(/export function safeSpawnSync/)
    expect(PROJECT_SCAN_SRC).toMatch(/Bun\.spawnSync/)
    expect(PROJECT_SCAN_SRC).toMatch(/return null/)
  })

  test("GitInfo.gitAvailable + gitError distinguish three states", () => {
    expect(PROJECT_SCAN_SRC).toMatch(/gitAvailable\?:\s*boolean/)
    expect(PROJECT_SCAN_SRC).toMatch(/gitError\?:\s*\{\s*exitCode/)
  })

  test("project_scan output line distinguishes 'binary missing' from 'not a repo'", () => {
    expect(PROJECT_SCAN_SRC).toMatch(/git binary not found in PATH/)
    expect(PROJECT_SCAN_SRC).toMatch(/git error \(exit/)
    expect(PROJECT_SCAN_SRC).toMatch(/Not a git repository/)
  })
})

// ---------------------------------------------------------------------------
// 3. normalizeAgentName — adversarial input hardening
// ---------------------------------------------------------------------------

describe("normalizeAgentName adversarial input", () => {
  test("helper exists at exactly one site (single source of truth)", () => {
    const matches = PROMPT_SRC.match(/function\s+normalizeAgentName\s*\(/g) ?? []
    expect(matches.length).toBe(1)
  })

  test("body case-folds before comparing to 'build'", () => {
    expect(PROMPT_SRC).toMatch(/\.toLowerCase\(\)\s*===\s*"build"/)
  })

  test("body strips C0 control characters (log-injection guard)", () => {
    // \x00-\x1f covers \n, \r, \t, NUL, etc. Without this, an agent name like
    // `"x\nfake_event=hello"` would split App Insights events.
    expect(PROMPT_SRC).toMatch(/normalizeAgentName[\s\S]{0,1500}\[\\x00-\\x1f/)
  })

  test("body NFKC-normalizes (collapses fullwidth/homoglyph buckets)", () => {
    expect(PROMPT_SRC).toMatch(/normalizeAgentName[\s\S]{0,1500}normalize\(\s*["']NFKC["']\s*\)/)
  })

  test("body length-caps before persisting (cardinality bomb guard)", () => {
    // A 50KB agent name flowing into telemetry's `agent` field would create
    // a cardinality bomb on the App Insights backend. Cap with .slice(0, 64).
    expect(PROMPT_SRC).toMatch(/normalizeAgentName[\s\S]{0,1500}\.slice\(\s*0\s*,\s*64\s*\)/)
  })

  test("session_start and agent_outcome both route through the helper", () => {
    expect(PROMPT_SRC).toMatch(/normalizeAgentName\(\s*lastUser\.agent\s*\)/)
    expect(PROMPT_SRC).toMatch(/normalizeAgentName\(\s*sessionAgentName\s*\)/)
  })
})

// ---------------------------------------------------------------------------
// 4. webfetch failure cache — auth-param strip + cache-hit signal
// ---------------------------------------------------------------------------

describe("webfetch cache key — auth-bearing param strip", () => {
  test("AUTH_PARAMS_FOR_CACHE_KEY enumerates the high-risk param names", () => {
    // Pin the explicit list so a refactor can't quietly drop one. Failing
    // here means a presigned-URL token (or similar) is sitting verbatim in
    // an in-memory Map for 30 min — a compliance regression.
    for (const param of [
      "token",
      "access_token",
      "api_key",
      "apikey",
      "signature",
      "sig",
      "x-amz-signature",
      "x-amz-credential",
      "x-goog-signature",
    ]) {
      expect(WEBFETCH_SRC).toContain(`"${param}"`)
    }
  })

  test("auth-bearing query params collapse to a clean cache key", () => {
    // S3 presigned URL — should normalize to the bare path so two different
    // signatures over the same path hit one cache slot.
    const sig1 = normalizeUrlForCache(
      "https://bucket.s3.amazonaws.com/key.json?x-amz-signature=AAAA&x-amz-credential=BBBB",
    )
    const sig2 = normalizeUrlForCache(
      "https://bucket.s3.amazonaws.com/key.json?x-amz-signature=CCCC&x-amz-credential=DDDD",
    )
    expect(sig1).toBe(sig2)
    expect(sig1).toBe("https://bucket.s3.amazonaws.com/key.json")
  })

  test("api_key / token / signature variants all collapse", () => {
    const variants = [
      "https://api.example.com/data?token=abc123",
      "https://api.example.com/data?access_token=xyz",
      "https://api.example.com/data?api_key=foo",
      "https://api.example.com/data?signature=bar",
      "https://api.example.com/data", // bare
    ]
    const normalized = new Set(variants.map(normalizeUrlForCache))
    expect(normalized.size).toBe(1)
  })

  test("functional params (page, q, id) are NOT stripped", () => {
    // Regression guard: don't over-strip into TRACKING_PARAMS territory.
    const a = normalizeUrlForCache("https://api.example.com/data?page=1")
    const b = normalizeUrlForCache("https://api.example.com/data?page=2")
    expect(a).not.toBe(b)
    expect(a).toContain("page=1")
    expect(b).toContain("page=2")
  })

  test("auth-param strip is case-insensitive (X-Amz-Signature vs x-amz-signature)", () => {
    // Real-world AWS SDK emits PascalCase; our list is lowercase; the strip
    // should normalize before comparing.
    const a = normalizeUrlForCache("https://s3.amazonaws.com/x?X-Amz-Signature=A&X-Amz-Credential=B")
    const b = normalizeUrlForCache("https://s3.amazonaws.com/x?x-amz-signature=A&x-amz-credential=B")
    expect(a).toBe(b)
    expect(a).toBe("https://s3.amazonaws.com/x")
  })

  test("cache-hit error message is distinguishable from a live failure", () => {
    // End User persona flagged that a cache-hit looked identical to a live
    // 404, blocking debug. Pin the prefix wording.
    expect(WEBFETCH_SRC).toMatch(/\(cached failure,\s*\$\{ageMin\}m ago\)/)
  })

  test("isUrlCachedFailure exposes ageMs alongside status", () => {
    expect(WEBFETCH_SRC).toMatch(/status:\s*entry\.status,\s*ageMs/)
  })

  test("451 uses a shorter TTL than 404/410 (observer-conditional)", () => {
    expect(WEBFETCH_SRC).toMatch(/FAILURE_CACHE_TTL_451\s*=\s*5\s*\*\s*60\s*\*\s*1000/)
    expect(WEBFETCH_SRC).toMatch(/FAILURE_CACHE_TTL\s*=\s*30\s*\*\s*60\s*\*\s*1000/)
    expect(WEBFETCH_SRC).toMatch(/function ttlForStatus/)
  })
})

// ---------------------------------------------------------------------------
// 5. URL normalization — privacy/hygiene invariants
// ---------------------------------------------------------------------------

describe("URL normalization — privacy invariants", () => {
  test("userinfo is stripped from cache key", () => {
    expect(normalizeUrlForCache("https://user:pass@example.com/x")).toBe(
      "https://example.com/x",
    )
  })

  test("tracking params collapse same URL across utm_* / fbclid / mc_*", () => {
    const a = normalizeUrlForCache("https://example.com/docs?utm_source=twitter&fbclid=abc")
    const b = normalizeUrlForCache("https://example.com/docs?mc_cid=email&utm_id=xyz")
    expect(a).toBe(b)
    expect(a).toBe("https://example.com/docs")
  })

  test("normalization is idempotent (no churn across repeated passes)", () => {
    const once = normalizeUrlForCache("https://example.com/x?utm_source=a&token=b&q=c")
    const twice = normalizeUrlForCache(once)
    expect(once).toBe(twice)
  })

  test("invalid URL passes through verbatim instead of throwing", () => {
    expect(normalizeUrlForCache("not a url")).toBe("not a url")
  })
})

// ---------------------------------------------------------------------------
// 6. CHANGELOG presence — release-skill backstop
// ---------------------------------------------------------------------------

describe("release artifacts", () => {
  test("CHANGELOG.md has a v0.7.3 entry", () => {
    expect(CHANGELOG).toMatch(/##\s*\[0\.7\.3\]/)
  })

  test("CHANGELOG.md v0.7.3 entry references all 5 merged PRs", () => {
    // PR numbers from `git log v0.7.2..HEAD --oneline --no-merges`:
    //   828 finops, 831 project_scan, 833 build-agent, 837 tokens_input, 839 webfetch
    for (const pr of ["#828", "#831", "#833", "#837", "#839"]) {
      expect(CHANGELOG).toContain(pr)
    }
  })
})
