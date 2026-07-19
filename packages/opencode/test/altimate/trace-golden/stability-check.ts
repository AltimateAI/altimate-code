// stability-check.ts — proves the trace-golden normalizer produces a
// byte-identical hash across many INDEPENDENT real subprocess-driven runs of
// the same scenario. This is the corrective-redirect requirement (#4) that
// was still open after the partial-order matcher and allowlist-projection
// normalizer rework: "run each scenario 50-100x to prove the normalized hash
// is stable under load before accepting any golden."
//
// Deliberately a STANDALONE SCRIPT, not a bun:test file — it spawns 50-100
// real CLI subprocesses (several minutes of wall-clock time) and must never
// run automatically as part of `bun test` / CI. Invoke explicitly:
//
//   bun run packages/opencode/test/altimate/trace-golden/stability-check.ts [runs] [concurrency]
//   TRACE_GOLDEN_STABILITY_RUNS=100 bun run .../stability-check.ts
//
// Each run provisions its OWN independent CliFixture (own random-suffixed tmp
// home dir, own TestLLMServer instance, own `opencode run` subprocess) rather
// than reusing one fixture across N drives — that independence is the point.
// DRIVER-NOTES.md documents a real bug (Bug A: path-scrubbing order
// dependency) that only manifested because `fixture.home` gets a random
// per-run suffix; reusing a single fixture would silently stop exercising
// exactly the class of nondeterminism this check exists to catch.
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { withCliFixture } from "../../lib/cli-process"
import { driveScenario, type ScriptedTurn } from "./driver"
import { formatDiffs, match } from "./match"
import { normalize, stableStringify, type NormalizedTrace } from "./normalize"

const SCENARIOS_DIR = path.join(import.meta.dir, "scenarios")

/**
 * Discovers scenario directories under `scenarios/` instead of hard-coding
 * `smoke`, so a newly added S5/S7 scenario is automatically exercised by the
 * 50-100x stability check the moment its directory exists — closing the
 * other half of codex-tracegolden-code-review.md finding #1 ("both the test
 * and stability runner hard-code smoke rather than discovering scenario
 * directories"). Kept as a standalone copy (not imported from
 * trace-golden.test.ts) because this file is a standalone script, not part
 * of the bun:test module graph.
 *
 * Skips directories missing one of the three REQUIRED driver inputs — see
 * the matching filter in trace-golden.test.ts's discoverScenarios for why
 * (an incomplete scaffold directory must not break every other scenario's
 * stability run).
 */
function discoverScenarios(dir: string): string[] {
  const REQUIRED_FILES = ["prompt.json", "setup.json", "model-script.json"]
  return fsSync
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => REQUIRED_FILES.every((f) => fsSync.existsSync(path.join(dir, e.name, f))))
    .map((e) => e.name)
    .sort()
}

const RUNS = Number(process.argv[2] ?? process.env.TRACE_GOLDEN_STABILITY_RUNS ?? 60)
const CONCURRENCY = Number(process.argv[3] ?? process.env.TRACE_GOLDEN_STABILITY_CONCURRENCY ?? 4)

function resolvePlaceholders<T>(value: T, home: string): T {
  if (typeof value === "string") return value.replaceAll("<HOME>", home) as unknown as T
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, home)) as unknown as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolvePlaceholders(v, home)
    return out as T
  }
  return value
}

type RunOutcome =
  | { readonly index: number; readonly ok: true; readonly hash: string; readonly durationMs: number }
  | { readonly index: number; readonly ok: false; readonly error: string; readonly durationMs: number }

async function runOnce(scenarioDir: string, index: number): Promise<RunOutcome> {
  const start = Date.now()
  try {
    const hash = await Effect.runPromise(
      Effect.scoped(
        withCliFixture((fixture) =>
          Effect.gen(function* () {
            const [promptRaw, setupRaw, scriptRaw] = yield* Effect.all([
              Effect.tryPromise(() => fs.readFile(path.join(scenarioDir, "prompt.json"), "utf-8")),
              Effect.tryPromise(() => fs.readFile(path.join(scenarioDir, "setup.json"), "utf-8")),
              Effect.tryPromise(() => fs.readFile(path.join(scenarioDir, "model-script.json"), "utf-8")),
            ])
            const { prompt } = JSON.parse(promptRaw) as { prompt: string }
            const setup = JSON.parse(setupRaw) as { files?: Record<string, string> }
            const script = resolvePlaceholders(JSON.parse(scriptRaw) as ScriptedTurn[], fixture.home)

            for (const [name, content] of Object.entries(setup.files ?? {})) {
              yield* Effect.tryPromise(() => fs.writeFile(path.join(fixture.home, name), content, "utf-8"))
            }

            const result = yield* driveScenario(fixture, {
              prompt,
              script,
              runOpts: { extraArgs: ["--dangerously-skip-permissions"] },
            })

            if (result.exitCode !== 0) {
              return yield* Effect.fail(
                new Error(
                  `run ${index}: opencode run exited ${result.exitCode}\nstderr (last 1500):\n${result.stderr.slice(-1500)}`,
                ),
              )
            }

            const actual = normalize(result.trace, { homeRoots: [fixture.home] })
            return stableStringify(actual)
          }),
        ),
      ),
    )
    return { index, ok: true, hash, durationMs: Date.now() - start }
  } catch (cause) {
    return { index, ok: false, error: String(cause), durationMs: Date.now() - start }
  }
}

async function runPool<T>(n: number, concurrency: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(n)
  let next = 0
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= n) return
      results[i] = await fn(i)
      // eslint-disable-next-line no-console
      console.log(`[stability-check] run ${i + 1}/${n} done`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, () => worker()))
  return results
}

/**
 * Drives a single scenario RUNS times and reports whether its normalized
 * hash is stable and matches the committed golden. Returns `true` iff this
 * scenario is fully stable, so `main()` can aggregate pass/fail across every
 * discovered scenario rather than only ever checking `smoke`.
 */
async function checkScenario(name: string, dir: string): Promise<boolean> {
  // eslint-disable-next-line no-console
  console.log(`[stability-check] driving '${name}' scenario ${RUNS}x real subprocess runs (concurrency ${CONCURRENCY})`)
  const overallStart = Date.now()

  const goldenPath = path.join(dir, "golden.json")
  const golden = JSON.parse(await fs.readFile(goldenPath, "utf-8")) as NormalizedTrace
  const goldenHash = stableStringify(golden)

  const outcomes = await runPool(RUNS, CONCURRENCY, (i) => runOnce(dir, i))

  const failures = outcomes.filter((o): o is Extract<RunOutcome, { ok: false }> => !o.ok)
  const successes = outcomes.filter((o): o is Extract<RunOutcome, { ok: true }> => o.ok)
  const uniqueHashes = new Set(successes.map((o) => o.hash))
  const totalMs = Date.now() - overallStart
  const avgMs = outcomes.reduce((sum, o) => sum + o.durationMs, 0) / outcomes.length

  // eslint-disable-next-line no-console
  console.log("")
  // eslint-disable-next-line no-console
  console.log(`=== stability-check summary: ${name} ===`)
  // eslint-disable-next-line no-console
  console.log(`runs requested:   ${RUNS}`)
  // eslint-disable-next-line no-console
  console.log(`runs succeeded:   ${successes.length}`)
  // eslint-disable-next-line no-console
  console.log(`runs failed:      ${failures.length}`)
  // eslint-disable-next-line no-console
  console.log(`unique hashes:    ${uniqueHashes.size} (1 = fully stable)`)
  // eslint-disable-next-line no-console
  console.log(`matches golden:   ${uniqueHashes.size === 1 && uniqueHashes.has(goldenHash)}`)
  // eslint-disable-next-line no-console
  console.log(`total wall time:  ${(totalMs / 1000).toFixed(1)}s`)
  // eslint-disable-next-line no-console
  console.log(`avg run time:     ${avgMs.toFixed(0)}ms`)

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.log("")
    // eslint-disable-next-line no-console
    console.log("--- failures ---")
    for (const f of failures.slice(0, 5)) {
      // eslint-disable-next-line no-console
      console.log(`run ${f.index}: ${f.error.slice(0, 500)}`)
    }
  }

  if (uniqueHashes.size > 1) {
    // eslint-disable-next-line no-console
    console.log("")
    // eslint-disable-next-line no-console
    console.log("--- INSTABILITY DETECTED: diff between first two distinct normalized outputs ---")
    const [firstHash, secondHash] = [...uniqueHashes]
    const a = successes.find((o) => o.hash === firstHash)!
    const b = successes.find((o) => o.hash === secondHash)!
    const diffs = match(JSON.parse(a.hash) as NormalizedTrace, JSON.parse(b.hash) as NormalizedTrace).diffs
    // eslint-disable-next-line no-console
    console.log(formatDiffs(diffs))
  } else if (successes.length > 0 && !uniqueHashes.has(goldenHash)) {
    // eslint-disable-next-line no-console
    console.log("")
    // eslint-disable-next-line no-console
    console.log("--- runs are mutually stable but diverge from the COMMITTED golden ---")
    const actual = JSON.parse(successes[0].hash) as NormalizedTrace
    const diffs = match(golden, actual).diffs
    // eslint-disable-next-line no-console
    console.log(formatDiffs(diffs))
  }

  const stable = failures.length === 0 && uniqueHashes.size === 1 && uniqueHashes.has(goldenHash)
  // eslint-disable-next-line no-console
  console.log("")
  // eslint-disable-next-line no-console
  console.log(
    stable
      ? `[stability-check] PASS: '${name}' normalized hash is stable and matches golden.`
      : `[stability-check] FAIL: '${name}' — see above.`,
  )
  return stable
}

async function main() {
  if (!Number.isFinite(RUNS) || RUNS < 1) throw new Error(`stability-check: invalid RUNS=${RUNS}`)
  if (!Number.isFinite(CONCURRENCY) || CONCURRENCY < 1) throw new Error(`stability-check: invalid CONCURRENCY=${CONCURRENCY}`)

  const scenarioNames = discoverScenarios(SCENARIOS_DIR)
  if (scenarioNames.length === 0) throw new Error(`stability-check: no scenario directories found under ${SCENARIOS_DIR}`)

  // eslint-disable-next-line no-console
  console.log(`[stability-check] discovered ${scenarioNames.length} scenario(s): ${scenarioNames.join(", ")}`)

  const results: Array<{ name: string; stable: boolean }> = []
  for (const name of scenarioNames) {
    // eslint-disable-next-line no-console
    console.log("")
    const stable = await checkScenario(name, path.join(SCENARIOS_DIR, name))
    results.push({ name, stable })
  }

  // eslint-disable-next-line no-console
  console.log("")
  // eslint-disable-next-line no-console
  console.log("=== overall stability-check summary ===")
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.stable ? "PASS" : "FAIL"}  ${r.name}`)
  }

  const allStable = results.every((r) => r.stable)
  // eslint-disable-next-line no-console
  console.log(
    allStable
      ? "[stability-check] PASS: all scenarios are stable and match their goldens."
      : "[stability-check] FAIL: at least one scenario is unstable or diverges from its golden — see above.",
  )
  process.exit(allStable ? 0 : 1)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[stability-check] fatal error:", err)
  process.exit(1)
})
