/**
 * Optimizer agent — live eval (tier 2, opt-in).
 *
 * Drives the REAL compiled binary with the optimizer agent against the planted
 * fixture project and grades the scan deterministically (string matching against
 * the answer key — no LLM judge). Complements optimizer-prompt-contract.test.ts,
 * which checks the prompt text and fixture; this checks actual agent behavior.
 *
 * Opt-in because it needs a compiled binary + a live model (cost, latency,
 * nondeterminism — the repo bans flaky tests from CI). Skipped unless BOTH:
 *   - OPENCODE_TEST_CLI  points at a compiled altimate-code binary
 *   - OPTIMIZER_LIVE_EVAL=1
 *
 * Run locally:
 *   bun run build:local
 *   OPENCODE_TEST_CLI="$PWD/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate-code" \
 *   OPTIMIZER_LIVE_EVAL=1 \
 *     bun test test/altimate/optimizer-agent-eval.test.ts --timeout 600000
 *
 * Grading (answer key: fixtures/optimizer-project-answer-key.md):
 *   - finds >= 4 of the 6 planted issues (model named + category keyword nearby)
 *   - presents the candidate-list contract (Evidence + Confidence fields)
 *   - the scan leaves the working tree untouched (read-only invariant)
 */
import { describe, test, expect } from "bun:test"
import { spawnSync } from "child_process"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"

const CLI = process.env["OPENCODE_TEST_CLI"]
const ENABLED = process.env["OPTIMIZER_LIVE_EVAL"] === "1" && !!CLI
const describeIf = ENABLED ? describe : describe.skip

const FIXTURE = path.join(import.meta.dir, "fixtures/optimizer-project")

// Each planted issue passes when the transcript mentions one of `models` within
// 400 characters of one of `signals` (case-insensitive). Loose on wording,
// strict on substance: the agent must tie the RIGHT issue to the RIGHT model.
// Signals are DIRECTIONAL phrases (an agent describing the issue), not bare
// topic words — "test" alone would match "dim_customers has tests", "dry"
// would match "dry-run". Deterministic grading can't parse negation, so the
// defense is phrasing that only appears when the issue is being reported.
const PLANTED: Array<{ id: string; models: string[]; signals: string[] }> = [
  { id: "1 incremental candidate", models: ["fct_events_daily"], signals: ["incremental"] },
  {
    id: "2 dead model",
    models: ["legacy_events_backup"],
    signals: ["dead", "no downstream", "unused", "not referenced", "no consumer", "deprecat", "quarantine", "remove"],
  },
  { id: "3 select * propagation", models: ["stg_events"], signals: ["select\\s*\\*", "explicit column", "wildcard"] },
  { id: "4 order by in model", models: ["fct_events_daily"], signals: ["order by"] },
  {
    id: "5 duplicated revenue CTE",
    models: ["rpt_us", "rpt_eu", "rpt_apac", "revenue_base"],
    signals: ["duplicat", "repeated logic", "same logic", "same cte", "identical", "\\bmacro\\b", "shared model", "shared staging", "factor"],
  },
  {
    id: "6 untested/undocumented model",
    models: ["dim_customers"],
    signals: ["missing test", "no tests", "untested", "add test", "not_null", "missing description", "no description", "undocument", "add.{0,20}description"],
  },
]

// A signal match is rejected when negation wording immediately precedes it —
// "fct_events_daily is NOT an incremental candidate" must not score as a hit.
// Heuristic, not NLU: it inspects the 60 chars before the signal for a negator.
// Clause-bounded: a comma, sentence end, or newline between the negator and the
// signal breaks the association ("not a temp table, uses ORDER BY" still scores
// the ORDER BY hit), and the window is tight (40 chars) to avoid discarding
// positive reports whose explanation merely contains a negator.
const NEGATION = /\b(not|no|never|isn'?t|doesn'?t|wasn'?t|aren'?t|cannot|can'?t|rather than|instead of)\b[^.;,!?\n]{0,40}$/i

function found(transcript: string, item: (typeof PLANTED)[number]): boolean {
  const t = transcript.toLowerCase()
  for (const m of item.models) {
    let idx = t.indexOf(m.toLowerCase())
    while (idx >= 0) {
      const window = t.slice(Math.max(0, idx - 400), idx + m.length + 400)
      for (const s of item.signals) {
        // Global flag: a negated FIRST occurrence must not hide a later
        // positive occurrence of the same signal in the window.
        const re = new RegExp(s, "gi")
        let match: RegExpExecArray | null
        while ((match = re.exec(window)) !== null) {
          const preceding = window.slice(Math.max(0, match.index - 60), match.index)
          if (!NEGATION.test(preceding)) return true
          if (re.lastIndex === match.index) re.lastIndex++
        }
      }
      idx = t.indexOf(m.toLowerCase(), idx + 1)
    }
  }
  return false
}

async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const entries = (await fs.readdir(dir, { recursive: true, withFileTypes: true })) as any[]
  for (const e of entries) {
    if (!e.isFile()) continue
    const p = path.join(e.parentPath ?? e.path, e.name)
    out.set(path.relative(dir, p), await fs.readFile(p, "utf8"))
  }
  return out
}

describeIf("optimizer live eval — planted-project scan", () => {
  test(
    "scan finds >=4/6 planted issues, keeps the candidate contract, edits nothing",
    async () => {
      // Fresh copy so the eval can never dirty the checked-in fixture. `await
      // using` disposes the tmpdir on success, assertion failure, and error.
      await using tmp = await tmpdir()
      const workdir = path.join(tmp.path, "project")
      const isolatedHome = path.join(tmp.path, "home")
      await fs.mkdir(isolatedHome, { recursive: true })
      await fs.cp(FIXTURE, workdir, { recursive: true })
      const before = await snapshotTree(workdir)

      // Pin the model: the isolated HOME removes any configured default, so
      // without --model the CLI would pick whichever provider enumerates
      // first from the forwarded API keys — making results depend on ambient
      // credential order rather than a known model.
      const model = process.env["OPTIMIZER_EVAL_MODEL"] ?? "anthropic/claude-sonnet-4-5"
      const run = spawnSync(
        CLI!,
        [
          "run",
          "--model",
          model,
          "--agent",
          "dbt-optimizer",
          "Scan this dbt project for optimization candidates. Do NOT fix anything yet — scan only.",
        ],
        {
          cwd: workdir,
          encoding: "utf8",
          timeout: 540_000,
          // Isolated environment: fresh HOME/XDG so the subprocess cannot load
          // the developer's real warehouse connections, permissive overrides,
          // or custom agents — the optimizer prompt calls finops tools, and a
          // fixture eval must never query a production warehouse. Model API
          // keys are passed through explicitly; nothing else ALTIMATE_* is.
          env: {
            PATH: process.env["PATH"] ?? "",
            HOME: isolatedHome,
            XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
            XDG_DATA_HOME: path.join(isolatedHome, ".local/share"),
            XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
            ...Object.fromEntries(
              [
                // Model/provider credentials
                "ANTHROPIC_API_KEY",
                "OPENAI_API_KEY",
                "OPENROUTER_API_KEY",
                "GOOGLE_API_KEY",
                "GROQ_API_KEY",
                "MISTRAL_API_KEY",
                // NOTE: AWS_* is deliberately NOT passed through — those double
                // as warehouse credentials, contradicting the isolation goal.
                // Bedrock-model users can extend this list locally.
                // Corporate proxy / TLS interception support — without these
                // the eval fails with an opaque network error behind a proxy.
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "NO_PROXY",
                "SSL_CERT_FILE",
                "NODE_EXTRA_CA_CERTS",
              ]
                .filter((k) => process.env[k])
                .map((k) => [k, process.env[k] as string]),
            ),
            ALTIMATE_TELEMETRY_DISABLED: "true",
          },
        },
      )
      const transcript = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
      expect(run.error).toBeUndefined()
      // A nonzero exit (crash, auth failure, model error) must fail the eval —
      // an empty transcript would otherwise just read as "0 issues found".
      expect(run.status).toBe(0)

      // --- Grade 1: planted-issue recall -----------------------------------
      const hits = PLANTED.filter((p) => found(transcript, p))
      const misses = PLANTED.filter((p) => !found(transcript, p)).map((p) => p.id)
      console.log(`[optimizer-eval] found ${hits.length}/6 planted issues; missed: ${misses.join(", ") || "none"}`)
      expect(hits.length).toBeGreaterThanOrEqual(4)

      // --- Grade 2: candidate-list contract --------------------------------
      expect(transcript.toLowerCase()).toContain("evidence")
      expect(transcript.toLowerCase()).toContain("confidence")

      // --- Grade 3: scan is read-only --------------------------------------
      // Three distinct checks: modified (in both, content differs), removed
      // (in before only), added (in after only, minus dbt/duckdb scratch).
      const after = await snapshotTree(workdir)
      const isScratch = (k: string) =>
        k.endsWith(".duckdb") || k.endsWith(".duckdb.wal") || k.split(path.sep).some((seg) => seg === "target" || seg === "logs" || seg === "dbt_packages")
      const modified = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k))
      const removed = [...before.keys()].filter((k) => !after.has(k))
      const added = [...after.keys()].filter((k) => !before.has(k) && !isScratch(k))
      expect(modified).toEqual([])
      expect(removed).toEqual([])
      expect(added).toEqual([])

    },
    600_000,
  )
})
