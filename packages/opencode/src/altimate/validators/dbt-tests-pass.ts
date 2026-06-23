// altimate_change start — dbt tests-pass validator (harness-side enforcement)
/**
 * dbt tests-pass validator.
 *
 * Fires after the agent declares done. Detects which dbt models the session
 * touched, runs `altimate-dbt test --model <name>` against each, and refuses
 * to terminate if any dbt test fails or errors.
 *
 * Catches row-data correctness errors that the column-shape validator does
 * not: a model whose schema.yml matches the actual columns can still fail
 * `relationships`, `unique`, `not_null`, `accepted_values`, or AUTO_equality
 * tests because the SELECT logic produces wrong values or wrong row counts.
 *
 * The agent does not see this validator existing — it runs in the harness
 * AFTER `finishReason === "stop"`. Its output is surfaced to the agent only
 * if there are failures, via a synthetic user message the framework injects
 * to force one more turn. See types.ts header for the rationale.
 */

import { spawn } from "child_process"
import type { Validator, ValidatorContext, ValidatorResult } from "../../session/validators/types"
import {
  VALIDATOR_TIMEOUT_MS,
  VALIDATOR_CONCURRENCY,
  findDbtProjectRoot,
  modelsModifiedSince,
  modelNameFromPath,
  extractLastJsonObject,
  runWithConcurrencyLimit,
} from "./validator-utils"

export interface TestSummary {
  /** Total tests run for this model (across the dbt test invocation). */
  total: number
  /** Tests that passed. */
  pass: number
  /** Tests that errored OR failed (dbt collapses both into ERROR=N in the summary). */
  error: number
  /** Names of failing or erroring tests, captured from per-line output. */
  failingTests: string[]
}

interface TestRunOutput {
  /** Model the test was run against. */
  model: string
  /** Parsed summary, when output was parseable. */
  summary?: TestSummary
  /** Top-level error from altimate-dbt (manifest missing, compile error, etc.). */
  error?: string
}

/**
 * Parse a dbt `test` output blob into a structured summary. Looks for the
 * `Done. PASS=X WARN=Y ERROR=Z SKIP=W NO-OP=V TOTAL=N` line that dbt prints
 * at the end. Also extracts the names of failing tests from per-line output
 * (`N of M FAIL ... <test_name>` / `N of M ERROR ... <test_name>`).
 *
 * Uses named capture groups so the parser is resilient to future field
 * reordering in dbt's summary line format.
 *
 * Returns null if no summary line is found (e.g. dbt itself errored before
 * running tests, or the output was clipped).
 */
// Valid dbt test identifier: letters/digits/underscore/dot/colon. Excludes
// brackets, parens, quotes, URL schemes, commas. Used to filter regex captures
// so we don't record `Done.`, `[FAIL]`, parenthesised reasons, or quoted noise
// as "failing tests".
const VALID_TEST_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/

// Anchored summary regex: requires `Done.` at the start of a line (after
// optional timestamp/ANSI prefix), prevents mid-word matches like `Predone.`
// or `Done.` inside a paragraph. WARN, SKIP, NO-OP are all optional so the
// parser tolerates future field reorderings or omissions; PASS/ERROR/TOTAL
// are the only required fields. Always scans for the LAST summary so retries
// produce the latest authoritative numbers.
const SUMMARY_RE =
  /(?:^|\n)[^\n]*?\bDone\.\s+(?=[^\n]*\bPASS=)(?=[^\n]*\bERROR=)(?=[^\n]*\bTOTAL=)[^\n]*?\bPASS=(?<pass>\d+)\b[^\n]*?\bERROR=(?<err>\d+)\b[^\n]*?\bTOTAL=(?<total>\d+)/gi

export function parseDbtTestOutput(stdout: string): TestSummary | null {
  if (!stdout) return null
  // Strip ANSI escape sequences so colour codes don't break field matching or
  // pollute captured test names.
  const cleaned = stripAnsi(stdout)
  // Use the global flag and keep the LAST match (retries / multi-summary outputs).
  let lastMatch: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  SUMMARY_RE.lastIndex = 0
  while ((m = SUMMARY_RE.exec(cleaned)) !== null) lastMatch = m
  if (!lastMatch) return null
  // Clamp very large counts so callers don't accidentally rely on imprecise
  // floats. dbt run counts rarely exceed millions; cap at MAX_SAFE_INTEGER.
  const safeParse = (s: string): number => {
    const n = Number(s)
    if (!Number.isSafeInteger(n)) return Number.MAX_SAFE_INTEGER
    return n
  }
  const pass = safeParse(lastMatch.groups?.pass ?? "0")
  const error = safeParse(lastMatch.groups?.err ?? "0")
  const total = safeParse(lastMatch.groups?.total ?? "0")
  // Pull individual FAIL/ERROR test names. Uses a character class for the
  // captured name so the match terminates at the first non-identifier
  // character (`[`, `(`, etc.) — avoids over-capturing trailing log noise.
  const failingTests: string[] = []
  // Pattern: `\b<count> of <total> (FAIL|ERROR) [count?] <name>`. The leading
  // `\b` blocks mid-word matches. The character class bounds the test name.
  const lineRe = /\b\d+\s+of\s+\d+\s+(?:FAIL|ERROR)\b(?:\s+\d+)?[ \t]+([A-Za-z0-9_./:-]+)/g
  let lm: RegExpExecArray | null
  while ((lm = lineRe.exec(cleaned)) !== null) {
    const name = lm[1]
    if (!name) continue
    // Reject names that look like URLs (e.g. error URLs in failure messages).
    if (name.includes("://")) continue
    if (!VALID_TEST_NAME_RE.test(name)) continue
    if (!failingTests.includes(name)) failingTests.push(name)
  }
  return { total, pass, error, failingTests }
}

/** Strip ANSI CSI/colour escape sequences from a string. */
function stripAnsi(s: string): string {
  // Matches CSI sequences (most common: \x1b[...m for colours).
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}

/**
 * Run `altimate-dbt test --model <name>` and parse its summary. The altimate-dbt
 * CLI wraps dbt's stdout in a `{"stdout": "..."}` JSON envelope on success
 * (or `{"error": "..."}` on failure). We unwrap then parse the dbt text.
 *
 * Times out after ALTIMATE_VALIDATORS_TIMEOUT_MS (default 60 s) and kills the
 * subprocess to prevent the agent loop from hanging indefinitely on stalled
 * warehouse connections or DuckDB file-lock contention.
 *
 * Returns null on spawn failure so the caller can track it separately.
 */
async function runDbtTest(model: string, cwd: string): Promise<TestRunOutput | null> {
  return new Promise((resolve) => {
    const child = spawn("altimate-dbt", ["test", "--model", model], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ model, error: `timed out after ${VALIDATOR_TIMEOUT_MS}ms` })
    }, VALIDATOR_TIMEOUT_MS)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on("close", () => {
      clearTimeout(timer)
      // altimate-dbt writes its envelope JSON to stdout. The envelope itself
      // is either { "stdout": "<dbt log>" } or { "error": "...", "stdout": "..." }.
      // Find the last balanced { ... } block (the envelope tends to be at the
      // end after any leading log noise).
      const envelope = extractLastJsonObject(stdout)
      if (!envelope) {
        if (stderr) resolve({ model, error: stderr.slice(0, 500) })
        else if (stdout) resolve({ model, error: `unparseable stdout: ${stdout.slice(-400)}` })
        else resolve(null)
        return
      }
      if (typeof envelope.error === "string") {
        resolve({ model, error: envelope.error.slice(0, 500) })
        return
      }
      const dbtLog = typeof envelope.stdout === "string" ? envelope.stdout : ""
      const summary = parseDbtTestOutput(dbtLog)
      if (!summary) {
        resolve({ model, error: `no PASS/ERROR summary in dbt output: ${dbtLog.slice(-300)}` })
        return
      }
      resolve({ model, summary })
    })
  })
}

/** Format a list of failing-test runs into a single concise synthetic-message block. */
function formatFixHint(failures: TestRunOutput[]): string {
  const lines: string[] = []
  for (const f of failures) {
    if (f.summary) {
      lines.push(
        `Model \`${f.model}\` — ${f.summary.error} of ${f.summary.total} tests failed/errored:`,
      )
      if (f.summary.failingTests.length > 0) {
        for (const name of f.summary.failingTests.slice(0, 10)) {
          lines.push(`  • ${name}`)
        }
        if (f.summary.failingTests.length > 10) {
          lines.push(`  • …and ${f.summary.failingTests.length - 10} more`)
        }
      }
    } else if (f.error) {
      lines.push(`Model \`${f.model}\` — could not run tests: ${f.error.slice(0, 200)}`)
    }
  }
  return lines.join("\n")
}

export const DbtTestsPassValidator: Validator = {
  name: "dbt-tests-pass",
  description:
    "After the agent declares done, runs `altimate-dbt test` against every dbt model the agent modified during this session and refuses to terminate if any model's tests fail or error. Catches row-data correctness errors (relationships, unique, not_null, accepted_values, AUTO_*_equality) that column-shape verification cannot detect.",

  async appliesTo(ctx: ValidatorContext): Promise<boolean> {
    return (await findDbtProjectRoot(ctx.workingDirectory)) !== null
  },

  async check(ctx: ValidatorContext): Promise<ValidatorResult> {
    const startedAt = Date.now()
    const dbtRoot = await findDbtProjectRoot(ctx.workingDirectory)
    if (!dbtRoot)
      return {
        ok: true,
        details: {
          models_touched: 0,
          dbt_root: null,
          session_id: ctx.sessionID,
          elapsed_ms: Date.now() - startedAt,
        },
      }

    const touched = await modelsModifiedSince(dbtRoot, ctx.sessionStartMs)
    if (touched.length === 0) {
      return {
        ok: true,
        details: {
          models_touched: 0,
          dbt_root: dbtRoot,
          session_id: ctx.sessionID,
          elapsed_ms: Date.now() - startedAt,
        },
      }
    }

    // Run model tests with a bounded concurrency limit to prevent resource
    // contention from spawning too many simultaneous dbt processes (flaky failures).
    let spawnFailures = 0
    const outputs = await runWithConcurrencyLimit(
      touched,
      (path) => runDbtTest(modelNameFromPath(path), dbtRoot),
      VALIDATOR_CONCURRENCY,
    )
    const results: TestRunOutput[] = []
    for (const out of outputs) {
      if (out) results.push(out)
      else spawnFailures++
    }

    const failures = results.filter((r) => r.summary && r.summary.error > 0)
    const errored = results.filter((r) => r.error && !r.summary)
    const passed = results.filter((r) => r.summary && r.summary.error === 0)
    // A model with no tests at all isn't a failure — it's just nothing to verify.
    const noTests = results.filter((r) => r.summary && r.summary.total === 0)

    const baseDetails = {
      models_touched: touched.length,
      checked: results.length,
      dbt_root: dbtRoot,
      session_id: ctx.sessionID,
      concurrency_limit: VALIDATOR_CONCURRENCY,
      elapsed_ms: Date.now() - startedAt,
    }

    if (failures.length === 0 && errored.length === 0) {
      return {
        ok: true,
        details: {
          ...baseDetails,
          passed: passed.length,
          no_tests: noTests.length,
          spawn_failures: spawnFailures,
        },
      }
    }

    const hintBlocks: TestRunOutput[] = [...failures, ...errored]
    const failingNames = failures.map((f) => f.model).filter(Boolean)
    const erroredNames = errored.map((f) => f.model).filter(Boolean)
    const reason =
      failures.length > 0
        ? `${failures.length} of ${results.length} models you edited have failing dbt tests${failingNames.length ? `: ${failingNames.join(", ")}` : ""}.`
        : `${errored.length} of ${results.length} models could not be tested${erroredNames.length ? `: ${erroredNames.join(", ")}` : ""}. Investigate before declaring done.`
    return {
      ok: false,
      reason,
      fixHint:
        formatFixHint(hintBlocks) +
        `\n\nFix the model SQL (not the tests). Common causes: wrong JOIN type (LEFT vs INNER changing row counts), missing GROUP BY columns, dropped/added rows from filters, type coercion mismatch on join keys. Rebuild and the harness will re-check before declaring done.`,
      details: {
        ...baseDetails,
        passed: passed.length,
        failed: failures.length,
        errored: errored.length,
        spawn_failures: spawnFailures,
        failing_models: failingNames,
        errored_models: erroredNames,
      },
    }
  },
}
// altimate_change end
