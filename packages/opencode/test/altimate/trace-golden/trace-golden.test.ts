// trace-golden.test.ts — proves the technique described in
// docs/internal/2026-07-18-trace-golden-e2e-technique.md end-to-end:
//   1. normalize() is idempotent and stable on real recorded traces.
//   2. A normalized real trace round-trips through match() as its own golden.
//   3. match()/formatDiffs() actually DETECT a planted behavioral change and
//      produce a readable diff — this is the load-bearing guarantee: a golden
//      that can't catch a real regression is worthless. (Most important test
//      in this file.)
//   4. The full pipeline — real `opencode run` subprocess, scripted
//      TestLLMServer, real Recap tracer, real trace file on disk — is driven
//      end-to-end via driver.ts's driveScenario() against the `smoke`
//      scenario, and the result matches a committed golden.
//
// Run `TRACE_GOLDEN_UPDATE=1 bun test packages/opencode/test/altimate/trace-golden/`
// to (re)generate scenario goldens after an intentional behavior change —
// review the diff in the PR body, same convention as UI snapshot updates.
import { describe, expect, test } from "bun:test"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { TraceFile, TraceSpan } from "@/altimate/observability/tracing"
import { cliIt } from "../../lib/cli-process"
import { driveScenario, type ScriptedTurn } from "./driver"
import { formatDiffs, match } from "./match"
import { normalize, stableStringify, type NormalizedTrace } from "./normalize"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures/real-traces")
const SCENARIOS_DIR = path.join(import.meta.dir, "scenarios")
const TRACE_GOLDEN_UPDATE = process.env.TRACE_GOLDEN_UPDATE === "1"

async function loadRealTraces(): Promise<Array<{ file: string; trace: TraceFile }>> {
  const files = (await fs.readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".json")).sort()
  return Promise.all(
    files.map(async (file) => ({
      file,
      trace: JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, file), "utf-8")) as TraceFile,
    })),
  )
}

async function fileExists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}

/** Recursively replaces the `<HOME>` placeholder token in scenario fixtures with the CliFixture's actual home dir. */
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

const readJson = <T>(file: string): Effect.Effect<T, Error> =>
  Effect.tryPromise({
    try: () => fs.readFile(file, "utf-8").then((raw) => JSON.parse(raw) as T),
    catch: (cause) => new Error(`trace-golden: failed to read ${file}: ${String(cause)}`),
  })

/** Minimal, schema-valid synthetic TraceFile wrapping the given spans — for tests that need exact, hand-built topology rather than a real recording. */
function buildSyntheticTrace(spans: TraceSpan[]): TraceFile {
  return {
    version: 2,
    traceId: "trace_synthetic",
    sessionId: "ses_synthetic",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    metadata: {},
    spans,
    summary: {
      totalTokens: 0,
      totalCost: 0,
      totalToolCalls: spans.filter((s) => s.kind === "tool").length,
      totalGenerations: spans.filter((s) => s.kind === "generation").length,
      duration: 1000,
      status: "completed",
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    },
  }
}

/**
 * Discovers scenario directories under `scenarios/` (each with its own
 * `prompt.json`/`setup.json`/`model-script.json`/`golden.json`) so new S5/S7
 * scenarios are picked up automatically instead of requiring a hand-edit of
 * this file every time one is added — fixing the "only `smoke` is wired"
 * half of codex-tracegolden-code-review.md finding #1.
 *
 * Skips directories missing one of the three REQUIRED driver inputs
 * (prompt.json/setup.json/model-script.json — golden.json is intentionally
 * excluded here since fix #2 handles a missing golden as its own, explicit
 * failure mode, not as "not a scenario"). Without this filter, an in-progress
 * or abandoned scenario scaffold directory (created but never populated)
 * silently breaks every OTHER discovered scenario's test run too, since
 * discovery is a single flat list consumed by a `for` loop that registers
 * one test per name — exactly the kind of coverage gap finding #1 exists to
 * close, just one level down.
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

type GoldenAction =
  | { readonly kind: "write" }
  | { readonly kind: "compare" }
  | { readonly kind: "fail"; readonly reason: string }

/**
 * Pure decision function for what to do with a scenario's golden — kept
 * separate from the Effect-based live test body so all four branches are
 * directly unit-testable without spinning up a real subprocess.
 *
 * Fixes codex-tracegolden-code-review.md finding #2: a missing golden used
 * to self-approve (write-then-pass) even in a plain, non-update run, which
 * silently turns "compare actual to golden" into "compare actual to itself"
 * the moment a golden.json is deleted from a writable CI checkout. A missing
 * golden must FAIL unless the run explicitly opts into regenerating it via
 * `TRACE_GOLDEN_UPDATE=1` — and that opt-in is itself rejected under CI, so
 * a CI run can never silently rewrite (and thus self-approve) a golden.
 */
function resolveGoldenAction(opts: {
  goldenExists: boolean
  updateRequested: boolean
  isCI: boolean
  goldenPath: string
}): GoldenAction {
  if (opts.updateRequested) {
    if (opts.isCI) {
      return {
        kind: "fail",
        reason:
          `trace-golden: TRACE_GOLDEN_UPDATE=1 is not allowed under CI (would silently rewrite ${opts.goldenPath}). ` +
          `Regenerate goldens locally and commit the reviewed diff.`,
      }
    }
    return { kind: "write" }
  }
  if (!opts.goldenExists) {
    return {
      kind: "fail",
      reason:
        `trace-golden: golden missing at ${opts.goldenPath}. A missing golden must FAIL, not self-approve — ` +
        `run with TRACE_GOLDEN_UPDATE=1 locally to (re)generate it, then review and commit the diff.`,
    }
  }
  return { kind: "compare" }
}

describe("discoverScenarios(): scenario-directory discovery (fix #1)", () => {
  function makeCompleteScenario(dir: string) {
    fsSync.mkdirSync(dir)
    fsSync.writeFileSync(path.join(dir, "prompt.json"), "{}")
    fsSync.writeFileSync(path.join(dir, "setup.json"), "{}")
    fsSync.writeFileSync(path.join(dir, "model-script.json"), "[]")
  }

  test("finds all COMPLETE scenario subdirectories under a temp dir, sorted, excluding files", () => {
    const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "trace-golden-discover-"))
    try {
      makeCompleteScenario(path.join(tmp, "zeta"))
      makeCompleteScenario(path.join(tmp, "alpha"))
      makeCompleteScenario(path.join(tmp, "mid"))
      fsSync.writeFileSync(path.join(tmp, "not-a-scenario.json"), "{}")

      expect(discoverScenarios(tmp)).toEqual(["alpha", "mid", "zeta"])
    } finally {
      fsSync.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("excludes an INCOMPLETE scenario directory (missing driver inputs) instead of breaking discovery for its siblings", () => {
    // Regression test for a real failure this exact filter caught: an
    // abandoned/in-progress scenario scaffold directory (created, never
    // populated with prompt.json/setup.json/model-script.json) existed
    // alongside `smoke` in the real SCENARIOS_DIR and, before this filter
    // existed, caused driver.ts's live test to crash with ENOENT reading its
    // missing prompt.json — taking down the whole discovered-scenario test
    // loop, not just that one entry.
    const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "trace-golden-discover-incomplete-"))
    try {
      makeCompleteScenario(path.join(tmp, "complete-one"))
      fsSync.mkdirSync(path.join(tmp, "incomplete-scaffold")) // no files inside — simulates an abandoned scenario dir

      expect(discoverScenarios(tmp)).toEqual(["complete-one"])
    } finally {
      fsSync.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("the real SCENARIOS_DIR contains at least the smoke scenario", () => {
    const found = discoverScenarios(SCENARIOS_DIR)
    expect(found).toContain("smoke")
    expect(found.length).toBeGreaterThanOrEqual(1)
  })
})

describe("resolveGoldenAction(): golden write/compare/fail decision (fix #2)", () => {
  test("golden exists, no update requested → compare", () => {
    const action = resolveGoldenAction({ goldenExists: true, updateRequested: false, isCI: false, goldenPath: "g.json" })
    expect(action.kind).toBe("compare")
  })

  test("golden missing, no update requested → fail (this is the fix: no self-approve)", () => {
    const action = resolveGoldenAction({ goldenExists: false, updateRequested: false, isCI: false, goldenPath: "g.json" })
    expect(action.kind).toBe("fail")
    if (action.kind === "fail") expect(action.reason).toContain("golden missing")
  })

  test("golden missing, update requested, not CI → write", () => {
    const action = resolveGoldenAction({ goldenExists: false, updateRequested: true, isCI: false, goldenPath: "g.json" })
    expect(action.kind).toBe("write")
  })

  test("golden exists, update requested, not CI → write (explicit regeneration)", () => {
    const action = resolveGoldenAction({ goldenExists: true, updateRequested: true, isCI: false, goldenPath: "g.json" })
    expect(action.kind).toBe("write")
  })

  test("update requested under CI → fail regardless of golden existence", () => {
    const withGolden = resolveGoldenAction({ goldenExists: true, updateRequested: true, isCI: true, goldenPath: "g.json" })
    const withoutGolden = resolveGoldenAction({ goldenExists: false, updateRequested: true, isCI: true, goldenPath: "g.json" })
    expect(withGolden.kind).toBe("fail")
    expect(withoutGolden.kind).toBe("fail")
    if (withGolden.kind === "fail") expect(withGolden.reason).toContain("not allowed under CI")
  })
})

describe("normalize(): idempotency on real traces", () => {
  test("fixtures directory has real trace files to test against", async () => {
    const traces = await loadRealTraces()
    expect(traces.length).toBeGreaterThanOrEqual(5)
  })

  test("normalizing the same real trace twice yields byte-identical output", async () => {
    const traces = await loadRealTraces()
    expect(traces.length).toBeGreaterThan(0)
    for (const { file, trace } of traces) {
      const first = stableStringify(normalize(trace))
      const second = stableStringify(normalize(trace))
      expect(second).toBe(first)
      // Also confirm re-parsing round-trips (normalize output is valid, stable JSON).
      expect(() => JSON.parse(first)).not.toThrow()
      void file
    }
  })
})

describe("normalize() + match(): golden round-trip on a real trace", () => {
  test("a real trace normalized twice matches itself via match()", async () => {
    const traces = await loadRealTraces()
    const { trace } = traces[traces.length - 1] // pick the largest fixture (most spans, most coverage)
    const golden = normalize(trace)
    const actual = normalize(trace)
    const result = match(golden, actual)
    expect(result.pass).toBe(true)
    expect(result.diffs).toEqual([])
  })
})

describe("match(): detects a planted behavioral regression (most important test in this file)", () => {
  test("flips a span status and injects an extra span — match() must catch both", async () => {
    const traces = await loadRealTraces()
    const withMultipleSpans = traces.find(({ trace }) => trace.spans.length >= 3)
    if (!withMultipleSpans) throw new Error("expected at least one fixture with >= 3 spans")

    const golden = normalize(withMultipleSpans.trace)
    // Deep clone so mutating "actual" cannot affect "golden".
    const actual: NormalizedTrace = JSON.parse(JSON.stringify(golden))

    // Plant 1: flip an existing span's status — simulates a route that silently
    // started failing (or a deny that silently started succeeding).
    const targetIndex = Math.min(1, actual.spans.length - 1)
    const originalStatus = actual.spans[targetIndex].status
    actual.spans[targetIndex].status = originalStatus === "ok" ? "error" : "ok"

    // Plant 2: inject a phantom span — simulates an extra, unexpected tool
    // execution (e.g. a HardPolicy gap letting an execute span through after a deny).
    // rank is a value no existing sibling under this parent uses, so match()'s
    // rank-aware grouping treats it as a singleton (real, reproducible order)
    // rather than folding it into a concurrent-group multiset diff — this test
    // asserts the precise 1:1 "spans[s999]" path, not a "concurrent-rank" path.
    actual.spans.push({
      id: "s999",
      parentId: actual.spans[0].id,
      name: "phantom-tool",
      kind: "tool",
      status: "ok",
      rank: 999999,
    })

    const result = match(golden, actual)

    expect(result.pass).toBe(false)
    expect(result.diffs.length).toBeGreaterThanOrEqual(2)

    const statusDiff = result.diffs.find((d) => d.path === `spans[${golden.spans[targetIndex].id}].status`)
    expect(statusDiff).toBeDefined()
    expect(statusDiff?.kind).toBe("changed")
    expect(statusDiff?.expected).toBe(originalStatus)

    const addedDiff = result.diffs.find((d) => d.kind === "added" && d.path === "spans[s999]")
    expect(addedDiff).toBeDefined()

    // The formatted report must be readable, not a blob dump.
    const report = result.format()
    expect(report).toContain("trace-golden mismatch")
    expect(report).toContain(`spans[${golden.spans[targetIndex].id}].status`)
    expect(report).toContain("+ spans[s999]")
    expect(report.length).toBeLessThan(2000) // minimal diff, not a 600KB blob

    // formatDiffs() is the same function match().format() delegates to — confirm parity.
    expect(formatDiffs(result.diffs)).toBe(report)
  })
})

describe("computeRanks/buildDfsOrdinals: concurrent-sibling ordinal stability (fix #1)", () => {
  // Two sibling `kind: "tool"` spans under one `kind: "generation"` parent,
  // dispatched the way Batch (`Promise.all`, batch.ts:158) and the parallel
  // session/prompt.ts resolver actually dispatch tool calls: SAME name (so
  // an old (kind, name)-only tiebreak ties and falls through to array
  // position) but DIFFERENT input (so the two spans are genuinely distinct
  // logical tool calls, not indistinguishable duplicates), with identical
  // start/end times (so even the old startTime/endTime-overlap rank scheme
  // would have clustered them into the same "concurrent" group). The only
  // thing that differs between the two traces below is which of the two
  // spans appears FIRST in the raw `spans` array — a difference that is
  // exactly what a real race between two `Promise.all`-dispatched tool
  // calls produces on two runs of the identical scenario.
  //
  // This test must FAIL if buildDfsOrdinals is reverted to numbering
  // same-rank siblings by raw array/original-index order instead of by
  // toolContentKey: with array-order numbering, the span appearing first in
  // the array always gets the lower ordinal, so the two traces below would
  // normalize to different span identities/order (`s1` denoting `a.txt` in
  // one and `b.txt` in the other) and this test's deep-equal assertion
  // would fail.
  const parent: TraceSpan = {
    spanId: "gen1",
    parentSpanId: null,
    name: "generation-abc123",
    kind: "generation",
    startTime: 1000,
    endTime: 3000,
    status: "ok",
  }
  const toolA: TraceSpan = {
    spanId: "toolA",
    parentSpanId: "gen1",
    name: "read_file",
    kind: "tool",
    startTime: 1000,
    endTime: 2000,
    status: "ok",
    input: { path: "/repo/a.txt" },
  }
  const toolB: TraceSpan = {
    spanId: "toolB",
    parentSpanId: "gen1",
    name: "read_file",
    kind: "tool",
    startTime: 1000,
    endTime: 2000,
    status: "ok",
    input: { path: "/repo/b.txt" },
  }

  test("normalize() produces byte-identical output regardless of which concurrent sibling was recorded first", () => {
    const traceOrderAB = buildSyntheticTrace([parent, toolA, toolB])
    const traceOrderBA = buildSyntheticTrace([parent, toolB, toolA])

    const normalizedAB = stableStringify(normalize(traceOrderAB))
    const normalizedBA = stableStringify(normalize(traceOrderBA))

    expect(normalizedAB).toBe(normalizedBA)
  })

  test("match() reports zero diffs between the two array orderings", () => {
    const traceOrderAB = buildSyntheticTrace([parent, toolA, toolB])
    const traceOrderBA = buildSyntheticTrace([parent, toolB, toolA])

    const result = match(normalize(traceOrderAB), normalize(traceOrderBA))

    expect(result.pass).toBe(true)
    expect(result.diffs).toEqual([])
  })
})

describe("computeRanks: structural rank is timing-independent (fix #1b — cross-order AND cross-timing)", () => {
  // Closes a gap in the fix #1 block above: that test kept startTime/endTime
  // IDENTICAL across both compared traces, so it could not distinguish a
  // genuinely structural (kind-only) rank scheme from a wall-clock-overlap
  // scheme that happens to see the same overlap in both variants. This test
  // varies the WALL-CLOCK RELATIONSHIP itself: one variant's two tool
  // siblings overlap in time (as a real Promise.all race often does), the
  // other variant's two tool siblings are jittered so they do NOT overlap
  // (one fully completes before the other starts) — and their array order is
  // also swapped, so the ONLY invariant across both variants is "these are
  // two `kind: tool` siblings under the same parent, with the same names and
  // inputs." Under a wall-clock overlap-based rank scheme these two variants
  // would land in different rank shapes (one clustered as concurrent, the
  // other split into two distinct ordered ranks); under the current kind-only
  // structural scheme (see normalize.ts's computeRanks) they must normalize
  // identically regardless of timing.
  const parent: TraceSpan = {
    spanId: "gen1",
    parentSpanId: null,
    name: "generation-abc123",
    kind: "generation",
    startTime: 1000,
    endTime: 5000,
    status: "ok",
  }
  // Different name AND different input — distinguishable regardless of the
  // toolContentKey tiebreak, so a mismatch can't hide behind ambiguous input.
  const readTool: TraceSpan = {
    spanId: "toolRead",
    parentSpanId: "gen1",
    name: "read_file",
    kind: "tool",
    startTime: 1000,
    endTime: 2000,
    status: "ok",
    input: { path: "/repo/a.txt" },
  }
  const writeTool: TraceSpan = {
    spanId: "toolWrite",
    parentSpanId: "gen1",
    name: "write_file",
    kind: "tool",
    startTime: 1500,
    endTime: 2500,
    status: "ok",
    input: { path: "/repo/b.txt" },
  }

  // Variant 1: array order [read, write]; times OVERLAP (1000-2000 vs 1500-2500).
  const overlapping = buildSyntheticTrace([parent, readTool, writeTool])

  // Variant 2: array order SWAPPED [write, read]; times jittered so they do
  // NOT overlap — write fully completes (3000-3500) before read starts
  // (4000-4500). Only each span's own kind/name/input survives from variant
  // 1; every timing value and the array position differ.
  const nonOverlappingSwapped = buildSyntheticTrace([
    parent,
    { ...writeTool, startTime: 3000, endTime: 3500 },
    { ...readTool, startTime: 4000, endTime: 4500 },
  ])

  test("normalize() is byte-identical whether the two tool siblings overlap in time or not (swapped order + non-overlapping times)", () => {
    const normalizedOverlap = stableStringify(normalize(overlapping))
    const normalizedNonOverlap = stableStringify(normalize(nonOverlappingSwapped))

    expect(normalizedOverlap).toBe(normalizedNonOverlap)
  })

  test("match() reports zero diffs between the overlapping and non-overlapping variants", () => {
    const result = match(normalize(overlapping), normalize(nonOverlappingSwapped))

    expect(result.pass).toBe(true)
    expect(result.diffs).toEqual([])
  })

  test("NEGATIVE control: changing one sibling's input produces exactly one add/remove pair scoped to the concurrent group, not spurious churn on the unchanged sibling", () => {
    const mutated = buildSyntheticTrace([parent, readTool, { ...writeTool, input: { path: "/repo/CHANGED.txt" } }])

    const result = match(normalize(overlapping), normalize(mutated))

    expect(result.pass).toBe(false)
    // Exactly one logical change manifests as one "removed" (old writeTool
    // signature no longer present) + one "added" (new writeTool signature) —
    // both scoped to the concurrent-rank group. If ordinal renumbering ever
    // leaked timing or array-position into the rank or tiebreak, the
    // unchanged readTool sibling would ALSO show up as a spurious diff, and
    // this exact-count assertion (2, not 3+) would catch it.
    expect(result.diffs.length).toBe(2)

    const removed = result.diffs.find((d) => d.kind === "removed")
    const added = result.diffs.find((d) => d.kind === "added")
    expect(removed).toBeDefined()
    expect(added).toBeDefined()
    expect(removed?.path).toContain("concurrent-rank")
    expect(added?.path).toContain("concurrent-rank")

    // The unchanged readTool sibling must not appear in either diff's payload.
    for (const d of result.diffs) {
      const payload = JSON.stringify(d.expected ?? d.actual ?? {})
      expect(payload).not.toContain("/repo/a.txt")
    }
  })
})

describe("toolContentKey: output-based tiebreak for identical-input concurrent siblings (fix #3)", () => {
  // Codex review finding #3: toolContentKey only used kind/name/input, so two
  // concurrent tool siblings with the SAME name/input but DIFFERENT output —
  // a real, distinguishable pair (e.g. two identical reads against a file
  // that changed between calls) — fell through to the raw-array-position
  // (originalIndex) tiebreak. Recorded in opposite completion order across
  // two runs of the identical scenario, that produced spurious add/remove
  // diffs even though nothing behaviorally different happened. Adding output
  // to toolContentKey (normalize.ts) fixes this: these tests must FAIL if
  // output is ever dropped back out of toolContentKey.
  const parent: TraceSpan = {
    spanId: "gen3",
    parentSpanId: null,
    name: "generation-samekey",
    kind: "generation",
    startTime: 1000,
    endTime: 3000,
    status: "ok",
  }
  const toolSameKeyA: TraceSpan = {
    spanId: "sameA",
    parentSpanId: "gen3",
    name: "read_file",
    kind: "tool",
    startTime: 1000,
    endTime: 2000,
    status: "ok",
    input: { path: "/repo/x.txt" },
    output: { content: "AAA" },
  }
  const toolSameKeyB: TraceSpan = {
    spanId: "sameB",
    parentSpanId: "gen3",
    name: "read_file",
    kind: "tool",
    startTime: 1000,
    endTime: 2000,
    status: "ok",
    input: { path: "/repo/x.txt" },
    output: { content: "BBB" },
  }

  test("normalize() is byte-identical regardless of which same-name/same-input/different-output sibling completed first", () => {
    const traceOrderAB = buildSyntheticTrace([parent, toolSameKeyA, toolSameKeyB])
    const traceOrderBA = buildSyntheticTrace([parent, toolSameKeyB, toolSameKeyA])

    expect(stableStringify(normalize(traceOrderAB))).toBe(stableStringify(normalize(traceOrderBA)))
  })

  test("match() reports zero diffs between the two completion orderings", () => {
    const traceOrderAB = buildSyntheticTrace([parent, toolSameKeyA, toolSameKeyB])
    const traceOrderBA = buildSyntheticTrace([parent, toolSameKeyB, toolSameKeyA])

    const result = match(normalize(traceOrderAB), normalize(traceOrderBA))

    expect(result.pass).toBe(true)
    expect(result.diffs).toEqual([])
  })
})

describe("computeRanks: root-attached tool preserves real sibling order (fix #4a)", () => {
  // Codex review finding #4 (half A): every kind:"tool" sibling used to get
  // rank -1 (the concurrent bucket) regardless of its parent's kind. But
  // logToolCall only races when a generation is active — with none active it
  // attaches the tool directly to the session root (tracing.ts:928), right
  // alongside genuinely ORDERED siblings like user-message/generation. Under
  // the old rule, reordering such a root-attached tool around its ordered
  // siblings normalized byte-identically and matchPass: true, silently
  // erasing a real, reproducible order. The fix scopes the concurrent bucket
  // to tools whose parent is itself a generation span; every other tool
  // parent (including the session root) gets a real, increasing rank. These
  // tests must FAIL if that scoping is reverted.
  const root: TraceSpan = {
    spanId: "root1",
    parentSpanId: null,
    name: "ses_synthetic",
    kind: "session",
    startTime: 0,
    endTime: 10000,
    status: "ok",
  }
  const userMsg: TraceSpan = {
    spanId: "um1",
    parentSpanId: "root1",
    name: "user-message",
    kind: "user-message",
    startTime: 100,
    endTime: 100,
    status: "ok",
  }
  const rootTool: TraceSpan = {
    spanId: "rt1",
    parentSpanId: "root1",
    name: "bash",
    kind: "tool",
    startTime: 200,
    endTime: 300,
    status: "ok",
    input: { cmd: "ls" },
  }
  const gen: TraceSpan = {
    spanId: "gen1",
    parentSpanId: "root1",
    name: "generation-root-attached",
    kind: "generation",
    startTime: 400,
    endTime: 500,
    status: "ok",
  }

  // Real chronological order: user-message, then the root-attached tool, then the generation.
  const realOrder = buildSyntheticTrace([root, userMsg, rootTool, gen])
  // Reordered: the root-attached tool now precedes the user-message — a genuine topology change,
  // not a race outcome (its parent, root1, is kind "session", not "generation").
  const reordered = buildSyntheticTrace([root, rootTool, userMsg, gen])

  test("normalize() produces DIFFERENT output when a root-attached tool is reordered around ordered siblings", () => {
    expect(stableStringify(normalize(realOrder))).not.toBe(stableStringify(normalize(reordered)))
  })

  test("match() detects the reordering as a real diff, not a false pass", () => {
    const result = match(normalize(realOrder), normalize(reordered))

    expect(result.pass).toBe(false)
    expect(result.diffs.length).toBeGreaterThan(0)
  })
})

describe("canonicalSignature: ordered children within a concurrent parent are not erased by sorting (fix #4b)", () => {
  // Codex review finding #4 (half B): canonicalChildSignatures used to sort
  // ALL descendant signatures indiscriminately, discarding the real,
  // reproducible order of a concurrent parent's OWN ordered children. Two
  // accepted raw traces where an ordered child sequence's order changed
  // (without changing the multiset of signatures) normalized to different
  // bytes in normalize.ts, yet the old, fully-sorted canonicalSignature still
  // signed them identically, so match() returned pass: true on a real
  // topology change. The fix groups children by their own rank and only
  // sorts WITHIN a tied-rank group. concA below is byte-identical on both
  // sides except for which of its two ordered children came first; concB is
  // an untouched peer included only to force the outer group into the
  // concurrent (multiset) comparison path (diffConcurrentGroup requires size
  // > 1 on at least one side). This test must FAIL (report pass: true) if
  // canonicalChildSignatures is reverted to an indiscriminate full sort.
  const genX: TraceSpan = {
    spanId: "genX",
    parentSpanId: null,
    name: "generation-nested",
    kind: "generation",
    startTime: 0,
    endTime: 10000,
    status: "ok",
  }
  // concA/concB: two concurrent tool siblings under genX (both kind "tool", parent is a
  // generation) — same rank bucket, forming the outer concurrent group.
  const concA: TraceSpan = {
    spanId: "concA",
    parentSpanId: "genX",
    name: "batch",
    kind: "tool",
    startTime: 100,
    endTime: 200,
    status: "ok",
    input: { branch: "A" },
  }
  const concB: TraceSpan = {
    spanId: "concB",
    parentSpanId: "genX",
    name: "batch",
    kind: "tool",
    startTime: 100,
    endTime: 200,
    status: "ok",
    input: { branch: "B" },
  }
  // concA's own children — concA's kind is "tool", not "generation", so these get real,
  // increasing ranks in their array/original-index order, not the concurrent bucket.
  const gchild1: TraceSpan = {
    spanId: "gchild1",
    parentSpanId: "concA",
    name: "sub_one",
    kind: "tool",
    startTime: 110,
    endTime: 120,
    status: "ok",
    input: { tag: "one" },
  }
  const gchild2: TraceSpan = {
    spanId: "gchild2",
    parentSpanId: "concA",
    name: "sub_two",
    kind: "tool",
    startTime: 130,
    endTime: 140,
    status: "ok",
    input: { tag: "two" },
  }

  test("swapping which of concA's two ordered children came first is detected as a real diff, not a false pass", () => {
    const golden = normalize(buildSyntheticTrace([genX, concA, concB, gchild1, gchild2]))
    const actual = normalize(buildSyntheticTrace([genX, concA, concB, gchild2, gchild1]))

    const result = match(golden, actual)

    // Real observed shape: reordering concA's children changes concA's own
    // canonical signature, so the outer concurrent-group comparison reports
    // concA as removed+added as a whole subtree (path carries
    // "concurrent-rank"); the positional per-span walk ALSO independently
    // reports the two children as "changed" at their now-mismatched DFS
    // ordinals (s2/s3). Both signals firing together is stronger evidence the
    // fix works than either alone — the exact count is an implementation
    // detail, not the load-bearing assertion.
    expect(result.pass).toBe(false)
    expect(result.diffs.length).toBeGreaterThan(0)
    expect(result.diffs.some((d) => d.path.includes("concurrent-rank"))).toBe(true)
    expect(result.diffs.some((d) => d.kind === "removed")).toBe(true)
    expect(result.diffs.some((d) => d.kind === "added")).toBe(true)
  })

  test("NEGATIVE control: unchanged child order matches with zero diffs (proves this isn't just always failing on nested-concurrent topology)", () => {
    const golden = normalize(buildSyntheticTrace([genX, concA, concB, gchild1, gchild2]))
    const actual = normalize(buildSyntheticTrace([genX, concA, concB, gchild1, gchild2]))

    const result = match(golden, actual)

    expect(result.pass).toBe(true)
    expect(result.diffs).toEqual([])
  })
})

describe("computeToolCallIdLabels: raw callId equality/uniqueness pattern is preserved (fix #5)", () => {
  // Codex review finding #5: toolCallId used to be rewritten to the span's
  // OWN ordinal, independent of the raw provider callId value entirely. Two
  // sibling calls with genuinely DISTINCT raw ids, and two calls that
  // (incorrectly) share ONE duplicate raw id, both normalized
  // byte-identically and matched successfully — hiding an S7-relevant
  // continuation-correctness regression. The fix maps each raw callId to the
  // ordinal of its FIRST DFS occurrence, so distinct raw ids get distinct
  // labels and a shared raw id gets a shared label.
  const genY: TraceSpan = {
    spanId: "genY",
    parentSpanId: null,
    name: "generation-callid",
    kind: "generation",
    startTime: 0,
    endTime: 1000,
    status: "ok",
  }
  const toolBase1: TraceSpan = {
    spanId: "td1",
    parentSpanId: "genY",
    name: "read_file",
    kind: "tool",
    startTime: 10,
    endTime: 20,
    status: "ok",
    input: { path: "/a" },
  }
  const toolBase2: TraceSpan = {
    spanId: "td2",
    parentSpanId: "genY",
    name: "read_file",
    kind: "tool",
    startTime: 30,
    endTime: 40,
    status: "ok",
    input: { path: "/b" },
  }

  test("two spans with distinct raw callIds normalize to DIFFERENT toolCallId labels", () => {
    const distinctTrace = buildSyntheticTrace([
      genY,
      { ...toolBase1, tool: { callId: "call_AAA", durationMs: 5 } },
      { ...toolBase2, tool: { callId: "call_BBB", durationMs: 5 } },
    ])

    const normalized = normalize(distinctTrace)
    const toolSpans = normalized.spans.filter((s) => s.kind === "tool")
    expect(toolSpans.length).toBe(2)
    expect(toolSpans[0].toolCallId).toBeDefined()
    expect(toolSpans[1].toolCallId).toBeDefined()
    expect(toolSpans[0].toolCallId).not.toBe(toolSpans[1].toolCallId)
  })

  test("two spans that (incorrectly) share ONE duplicate raw callId normalize to the SAME toolCallId label", () => {
    const duplicateTrace = buildSyntheticTrace([
      genY,
      { ...toolBase1, tool: { callId: "call_SHARED", durationMs: 5 } },
      { ...toolBase2, tool: { callId: "call_SHARED", durationMs: 5 } },
    ])

    const normalized = normalize(duplicateTrace)
    const toolSpans = normalized.spans.filter((s) => s.kind === "tool")
    expect(toolSpans.length).toBe(2)
    expect(toolSpans[0].toolCallId).toBe(toolSpans[1].toolCallId)
  })

  test("match() detects a distinct-ids-vs-duplicate-ids regression (the S7-relevant case the review reproduced)", () => {
    const distinctTrace = buildSyntheticTrace([
      genY,
      { ...toolBase1, tool: { callId: "call_AAA", durationMs: 5 } },
      { ...toolBase2, tool: { callId: "call_BBB", durationMs: 5 } },
    ])
    const duplicateTrace = buildSyntheticTrace([
      genY,
      { ...toolBase1, tool: { callId: "call_SHARED", durationMs: 5 } },
      { ...toolBase2, tool: { callId: "call_SHARED", durationMs: 5 } },
    ])

    const result = match(normalize(distinctTrace), normalize(duplicateTrace))

    // The two tool spans sit in the same concurrent-rank bucket, so match()
    // reports the mismatched one as a whole-object removed/added pair (path
    // is the span id, not a "toolCallId" field path) — assert on the
    // embedded object payload rather than the diff path string.
    expect(result.pass).toBe(false)
    expect(result.diffs.length).toBeGreaterThan(0)
    expect(JSON.stringify(result.diffs)).toContain("toolCallId")
    const toolCallIds = result.diffs.flatMap((d) =>
      [d.expected, d.actual].filter((v): v is { toolCallId?: string } => typeof v === "object" && v !== null && "toolCallId" in v),
    )
    expect(toolCallIds.length).toBeGreaterThan(0)
  })
})

describe("loop summary determinism: hash stripped, loops order-independent (fix #6)", () => {
  // Codex review finding #6: loop descriptions embed a base-36
  // `simpleHash().toString(36)` value as literal text — "(hash: xyz)" — that
  // scrubDynamicTokens didn't strip, so two runs whose loop-triggering inputs
  // differed only in something irrelevant to behavior (e.g. a temp path)
  // still changed the emitted hash and flapped the golden. Multiple loops
  // also retained raw first-detection/completion order, which is not
  // reproducible. The fix adds a LOOP_HASH_PATTERN scrub and sorts loops by
  // (tool, count, description).
  function buildTraceWithLoops(
    loops: Array<{ tool: string; inputHash: string; count: number; description: string }>,
  ): TraceFile {
    const base = buildSyntheticTrace([
      {
        spanId: "loopRoot",
        parentSpanId: null,
        name: "ses_synthetic",
        kind: "session",
        startTime: 0,
        endTime: 1000,
        status: "ok",
      },
    ])
    return { ...base, summary: { ...base.summary, loops } }
  }

  test("differing (hash: ...) values in an otherwise-identical loop description normalize identically", () => {
    const traceA = buildTraceWithLoops([
      { tool: "read_file", inputHash: "a1b2c3", count: 3, description: "read_file called 3x (hash: a1b2c3)" },
    ])
    const traceB = buildTraceWithLoops([
      { tool: "read_file", inputHash: "z9y8x7", count: 3, description: "read_file called 3x (hash: z9y8x7)" },
    ])

    expect(stableStringify(normalize(traceA))).toBe(stableStringify(normalize(traceB)))
  })

  test("multiple loops normalize identically regardless of their original array order", () => {
    const loop1 = { tool: "read_file", inputHash: "h1", count: 3, description: "read_file called 3x (hash: h1)" }
    const loop2 = { tool: "write_file", inputHash: "h2", count: 2, description: "write_file called 2x (hash: h2)" }

    const traceOrder12 = buildTraceWithLoops([loop1, loop2])
    const traceOrder21 = buildTraceWithLoops([loop2, loop1])

    expect(stableStringify(normalize(traceOrder12))).toBe(stableStringify(normalize(traceOrder21)))
  })

  test("NEGATIVE control: match() still detects a genuine loop count regression", () => {
    const loop1 = { tool: "read_file", inputHash: "h1", count: 3, description: "read_file called 3x (hash: h1)" }
    const loop2 = { tool: "write_file", inputHash: "h2", count: 2, description: "write_file called 2x (hash: h2)" }

    const golden = normalize(buildTraceWithLoops([loop1, loop2]))
    const mutated = normalize(buildTraceWithLoops([{ ...loop1, count: 99 }, loop2]))

    const result = match(golden, mutated)

    expect(result.pass).toBe(false)
    expect(result.diffs.some((d) => d.path.includes("loops"))).toBe(true)
  })
})

describe("withRealpathVariants: symlink-vs-realpath home root leak (fix #7)", () => {
  // Codex review finding #7: root replacement is literal substring
  // replacement. On macOS, os.homedir()/os.tmpdir() report the SYMLINK form
  // (e.g. /var/folders/...), but some recorded strings resolve through the
  // symlink to its REALPATH form (/private/var/folders/...) — a single
  // literal-prefix root only ever catches ONE of the two forms, leaking
  // `/private<HOME>` (or the reverse) whenever the trace happens to contain
  // the other form. The fix expands every root to include its own
  // fs.realpathSync() resolution before scrubbing. This test builds a REAL
  // symlink (so it reproduces the bug's mechanism on every platform, not
  // just macOS) rather than relying on the test runner's own OS to happen to
  // have symlinked temp dirs.
  test("both the symlink form and its realpath form scrub to the identical <HOME> output", () => {
    const tmpBase = fsSync.mkdtempSync(path.join(os.tmpdir(), "trace-golden-realpath-"))
    try {
      const realTarget = path.join(tmpBase, "real-target")
      fsSync.mkdirSync(realTarget)
      const symlinkHome = path.join(tmpBase, "home-symlink")
      fsSync.symlinkSync(realTarget, symlinkHome, "dir")
      const resolvedHome = fsSync.realpathSync(symlinkHome)

      // Sanity precondition: the symlink must actually resolve to a DIFFERENT
      // literal string, or this test would pass trivially without exercising
      // the fix at all.
      expect(resolvedHome).not.toBe(symlinkHome)

      const spanSymlinkForm: TraceSpan = {
        spanId: "s1",
        parentSpanId: null,
        name: "ses_synthetic",
        kind: "session",
        startTime: 0,
        endTime: 1000,
        status: "ok",
        input: { path: path.join(symlinkHome, "file.txt") },
      }
      const spanRealpathForm: TraceSpan = {
        ...spanSymlinkForm,
        input: { path: path.join(resolvedHome, "file.txt") },
      }

      // homeRoots mirrors how this is actually invoked (driver's `fixture.home`, or
      // os.homedir()) — always the symlink-style form the OS reports, never the realpath.
      const normalizedSymlink = stableStringify(
        normalize(buildSyntheticTrace([spanSymlinkForm]), { homeRoots: [symlinkHome] }),
      )
      const normalizedRealpath = stableStringify(
        normalize(buildSyntheticTrace([spanRealpathForm]), { homeRoots: [symlinkHome] }),
      )

      expect(normalizedSymlink).toBe(normalizedRealpath)
      expect(normalizedSymlink).not.toContain(resolvedHome)
      expect(normalizedSymlink).not.toContain(symlinkHome)
      expect(normalizedSymlink).toContain("<HOME>")
    } finally {
      fsSync.rmSync(tmpBase, { recursive: true, force: true })
    }
  })
})

describe("normalize(): schema-drift guard on unclassified span fields (fix #2)", () => {
  const baseSpan: TraceSpan = {
    spanId: "root1",
    parentSpanId: null,
    name: "ses_synthetic",
    kind: "session",
    startTime: 1000,
    endTime: 2000,
    status: "ok",
  }

  test("throws when a span carries a field TraceSpan doesn't declare (simulated schema drift)", () => {
    // Deliberately bypasses the type system — this simulates tracing.ts's
    // TraceSpan gaining a real new field before normalize.ts's SPAN_KEYS/
    // SpanKeyLiteral have been updated to classify it. A cast is required
    // precisely because the compile-time pin next to SPAN_KEYS (see
    // normalize.ts) would otherwise catch a *declared* drift at typecheck
    // time; this test proves the runtime backstop for undeclared/dynamic
    // data (e.g. a real trace file written by an older or newer binary).
    const drifted = { ...baseSpan, plannedNewField: "simulates a future TraceSpan field" } as unknown as TraceSpan
    const trace = buildSyntheticTrace([drifted])

    expect(() => normalize(trace)).toThrow(/unknown field/)
  })

  test("does NOT throw on a span using only today's known field set (negative control, pins the other boundary)", () => {
    const fullyPopulated: TraceSpan = {
      ...baseSpan,
      statusMessage: "done",
      interrupted: false,
      model: { modelId: "m1", providerId: "p1", variant: "high" },
      finishReason: "stop",
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: 0.01,
      tool: { callId: "call_1", durationMs: 10 },
      input: { a: 1 },
      output: { b: 2 },
      attributes: { foo: "bar" },
    }
    const trace = buildSyntheticTrace([fullyPopulated])

    expect(() => normalize(trace)).not.toThrow()
  })
})

describe("CI wiring: trace-golden's live subprocess test actually runs in CI (fix #1)", () => {
  // cliIt.live (cli-process.ts) is a no-op when OPENCODE_SKIP_SUBPROCESS=1, which the main CI test
  // pass sets. CI only runs subprocess-dependent suites that are explicitly named in its dedicated
  // SUBPROCESS_PATHS list — a suite not named there silently never executes its live scenarios at
  // all (not "skipped and visible", just absent), which is exactly how "only smoke is wired and
  // even that never truly runs in CI" went unnoticed. This test fails loudly the moment that list
  // stops including this directory, instead of relying on someone noticing a coverage gap.
  test("ci.yml's SUBPROCESS_PATHS includes test/altimate/trace-golden/", () => {
    const ciYmlPath = path.join(import.meta.dir, "../../../../../.github/workflows/ci.yml")
    const ciYml = fsSync.readFileSync(ciYmlPath, "utf-8")
    const subprocessPathsLine = ciYml.split("\n").find((line) => line.includes("SUBPROCESS_PATHS="))
    expect(subprocessPathsLine).toBeDefined()
    expect(subprocessPathsLine).toContain("test/altimate/trace-golden/")
  })
})

describe("driver.ts: real headless session driven end-to-end (all discovered scenarios)", () => {
  const isCI = process.env.CI === "true" || process.env.CI === "1"

  // Discovers scenario directories rather than hard-coding `smoke`, so a new S5/S7 scenario is
  // automatically wired into both this test file AND stability-check.ts (which uses the same
  // discoverScenarios shape) the moment its directory is added — closing the other half of
  // codex-tracegolden-code-review.md finding #1 ("both the test and stability runner hard-code
  // smoke rather than discovering scenario directories").
  for (const scenarioName of discoverScenarios(SCENARIOS_DIR)) {
    const scenarioDir = path.join(SCENARIOS_DIR, scenarioName)

    cliIt.live(`${scenarioName} scenario trace matches its golden`, (fixture) =>
      Effect.gen(function* () {
        const { prompt } = yield* readJson<{ prompt: string }>(path.join(scenarioDir, "prompt.json"))
        const setup = yield* readJson<{ files?: Record<string, string> }>(path.join(scenarioDir, "setup.json"))
        const scriptRaw = yield* readJson<ScriptedTurn[]>(path.join(scenarioDir, "model-script.json"))
        const script = resolvePlaceholders(scriptRaw, fixture.home)

        for (const [name, content] of Object.entries(setup.files ?? {})) {
          yield* Effect.tryPromise({
            try: () => fs.writeFile(path.join(fixture.home, name), content, "utf-8"),
            catch: (cause) => new Error(`trace-golden: failed to write scenario fixture ${name}: ${String(cause)}`),
          })
        }

        const result = yield* driveScenario(fixture, {
          prompt,
          script,
          // Non-interactive `run` defaults every permission ask to "ask", which
          // an in-process run (no TUI, no connected client to answer) can never
          // resolve. --dangerously-skip-permissions auto-approves anything not
          // explicitly denied — see src/cli/cmd/run.ts's yolo-mode branch.
          runOpts: { extraArgs: ["--dangerously-skip-permissions"] },
        })

        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new Error(
              `${scenarioName} scenario: opencode run exited ${result.exitCode}\nstderr:\n${result.stderr.slice(-2000)}`,
            ),
          )
        }

        // The child subprocess's HOME (and therefore every home-relative path in
        // its trace) is fixture.home, NOT this test process's os.homedir() — see
        // isolatedEnv() in cli-process.ts. Must be passed explicitly or path
        // scrubbing silently no-ops on the driven session's own paths.
        const actual = normalize(result.trace, { homeRoots: [fixture.home] })
        const goldenPath = path.join(scenarioDir, "golden.json")
        const goldenExists = yield* Effect.tryPromise({
          try: () => fileExists(goldenPath),
          catch: (cause) => new Error(String(cause)),
        })

        const action = resolveGoldenAction({ goldenExists, updateRequested: TRACE_GOLDEN_UPDATE, isCI, goldenPath })

        if (action.kind === "fail") {
          return yield* Effect.fail(new Error(action.reason))
        }

        if (action.kind === "write") {
          yield* Effect.tryPromise({
            try: () => fs.writeFile(goldenPath, stableStringify(actual) + "\n", "utf-8"),
            catch: (cause) => new Error(`trace-golden: failed to write golden ${goldenPath}: ${String(cause)}`),
          })
          // eslint-disable-next-line no-console
          console.warn(`[trace-golden] wrote golden: ${goldenPath} (review this diff before committing)`)
          return
        }

        const golden = yield* readJson<NormalizedTrace>(goldenPath)
        const matchResult = match(golden, actual)
        if (!matchResult.pass) {
          return yield* Effect.fail(new Error(matchResult.format()))
        }
      }),
    )
  }
})
