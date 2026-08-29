// — write-starvation circuit breaker + loop detection (corrected mechanism).
// Gates covered here (unit level):
//   - ships ANNOTATE-ONLY by default (resolveConfig default mode is "annotate")
//   - read-only-deliverable task NON-FIRING probe (the misfire class the bench
//     cannot see: analysis-only sessions must not be pushed into fabricated edits
//     below threshold, and above threshold the directive must carry the DONE
//     alternative — never an unconditional "produce the edit now")
//   - generic mutating-call classifier with NO vertical tokens (source-scan guard)
//   - content-hash unchanged-read annotation: annotate never suppress; generated
//     paths exempt
//   - repeat_signature = hash(tool + normalized args + touched files + failure
//     message) loop detection
//   - doom-loop guard re-keyed on (toolName + normalized args) with the
//     nudge → status-check → stop escalation ladder; varied-args repetition
//     (the old per-NAME false-positive class) never climbs the ladder
//   - polling patterns get a raised threshold, not an exemption
//   - nudge arbiter: at most ONE directive per turn, fixed precedence
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { SessionStarvation } from "../../src/session/starvation"
import { NudgeArbiter } from "../../src/session/nudge"

const cfg = SessionStarvation.resolveConfig(undefined)

function tracker(overrides: Partial<SessionStarvation.ResolvedConfig> = {}) {
  return SessionStarvation.createTracker({ ...cfg, ...overrides })
}

// altimate_change start — upstream_fix regression tests
describe("resolveConfig clamps non-positive thresholds to their default", () => {
  test("doom_loop_threshold: 0 does not immediately trip the breaker on the first call", () => {
    const resolved = SessionStarvation.resolveConfig({ doom_loop_threshold: 0 })
    expect(resolved.doomLoopThreshold).toBe(SessionStarvation.resolveConfig(undefined).doomLoopThreshold)
  })

  test("negative and non-finite values also fall back to the default", () => {
    expect(SessionStarvation.resolveConfig({ polling_threshold_multiplier: -3 }).pollingThresholdMultiplier).toBe(
      SessionStarvation.resolveConfig(undefined).pollingThresholdMultiplier,
    )
    expect(SessionStarvation.resolveConfig({ max_turns_without_mutation: Number.NaN }).maxTurnsWithoutMutation).toBe(
      SessionStarvation.resolveConfig(undefined).maxTurnsWithoutMutation,
    )
  })

  test("a valid positive override is still honored", () => {
    expect(SessionStarvation.resolveConfig({ doom_loop_threshold: 7 }).doomLoopThreshold).toBe(7)
  })

  test("mode: 'off' remains the only way to disable starvation", () => {
    expect(SessionStarvation.resolveConfig({ mode: "off" }).mode).toBe("off")
  })
})

describe("normalizeArgs — shared (non-circular) references are not mislabeled circular", () => {
  test("a DAG-shaped object (same reference reused, not nested in itself) normalizes both occurrences", () => {
    const shared = { a: 1 }
    const result = SessionStarvation.normalizeArgs({ x: shared, y: shared })
    expect(result).toBe(JSON.stringify({ x: { a: 1 }, y: { a: 1 } }))
  })

  test("a genuinely circular reference is still caught", () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(SessionStarvation.normalizeArgs(circular)).toBe(JSON.stringify({ a: 1, self: "[circular]" }))
  })
})
// altimate_change end

describe("config defaults (annotate-only ships by default)", () => {
  test("default mode is annotate — directives and hard consequences are OFF until bench-validated", () => {
    expect(cfg.mode).toBe("annotate")
  })

  test("plan/review agents are exempt by default", () => {
    expect(cfg.exemptAgents).toContain("plan")
    expect(cfg.exemptAgents).toContain("review")
  })

  test("thresholds are config-exposed and overridable", () => {
    const resolved = SessionStarvation.resolveConfig({
      mode: "armed",
      max_turns_without_mutation: 5,
      repeat_signature_threshold: 2,
      doom_loop_threshold: 4,
      polling_threshold_multiplier: 10,
      exempt_agents: ["explore"],
      generated_path_patterns: ["gen/"],
    })
    expect(resolved.mode).toBe("armed")
    expect(resolved.maxTurnsWithoutMutation).toBe(5)
    expect(resolved.repeatSignatureThreshold).toBe(2)
    expect(resolved.doomLoopThreshold).toBe(4)
    expect(resolved.pollingThresholdMultiplier).toBe(10)
    expect(resolved.exemptAgents).toEqual(["explore"])
    expect(resolved.generatedPathPatterns).toEqual(["gen/"])
  })
})

describe("applyReadAnnotation — output mutation is run-mode-only", () => {
  test("run mode appends the annotation to the tool output", () => {
    const out = SessionStarvation.applyReadAnnotation("file contents", "[harness note: unchanged]", true)
    expect(out).toBe("file contents\n\n[harness note: unchanged]")
  })

  test("interactive session: output stays byte-identical (telemetry-only shadow)", () => {
    const out = SessionStarvation.applyReadAnnotation("file contents", "[harness note: unchanged]", false)
    expect(out).toBe("file contents")
  })
})

describe("no vertical tokens in generic classifiers (leak-lens hard requirement)", () => {
  test("starvation.ts contains no dbt/warehouse vertical tokens", () => {
    const source = readFileSync(path.join(import.meta.dir, "../../src/session/starvation.ts"), "utf8")
    // Hard requirement: no dbt/altimate-dbt string matching inside any generic
    // classifier, and no bench task command strings in product code.
    expect(/\bdbt\b/i.test(source)).toBe(false)
    expect(/snowflake|bigquery|redshift|databricks/i.test(source)).toBe(false)
    expect(source.includes("--profiles-dir")).toBe(false)
  })

  test("classifier is generic: unknown tools are 'unknown', never assumed mutating or read-only", () => {
    expect(SessionStarvation.classifyToolCall("some_mcp_tool")).toBe("unknown")
    expect(SessionStarvation.classifyToolCall("bash")).toBe("unknown")
    expect(SessionStarvation.classifyToolCall("write")).toBe("mutating")
    expect(SessionStarvation.classifyToolCall("edit")).toBe("mutating")
    expect(SessionStarvation.classifyToolCall("apply_patch")).toBe("mutating")
    expect(SessionStarvation.classifyToolCall("read")).toBe("read-only")
    expect(SessionStarvation.classifyToolCall("grep")).toBe("read-only")
  })
})

describe("read-only-deliverable task: non-firing probe", () => {
  test("a varied read-only session below threshold never fires anything", () => {
    const t = tracker()
    for (let step = 0; step < cfg.maxTurnsWithoutMutation - 1; step++) {
      const call = t.onToolCall({ tool: "read", input: { filePath: `/repo/file${step}.sql` } })
      expect(call.doomLoop).toBeUndefined()
      const result = t.onToolResult({
        tool: "read",
        input: { filePath: `/repo/file${step}.sql` },
        output: `content ${step}`,
      })
      expect(result.readAnnotation).toBeUndefined()
      expect(result.repeatLoop).toBeUndefined()
      const stepOutcome = t.onStepFinish({ mutatedFiles: [] })
      expect(stepOutcome.starvation).toBeUndefined()
    }
  })

  test("at threshold the directive is outcome-neutral with a DONE alternative — never an unconditional edit demand", () => {
    const t = tracker()
    let fired: string | undefined
    for (let step = 0; step < cfg.maxTurnsWithoutMutation; step++) {
      const out = t.onStepFinish({ mutatedFiles: [] })
      if (out.starvation) fired = out.starvation.directive
    }
    expect(fired).toBeDefined()
    expect(fired!).toContain("If this task requires an edit")
    expect(fired!).toContain("analysis with no file changes")
    expect(fired!).toContain("DONE")
    // must not be the unconditional form
    expect(fired!.startsWith("Produce the edit")).toBe(false)
  })

  test("re-fires every threshold turns, not every turn (no directive spam)", () => {
    const t = tracker({ maxTurnsWithoutMutation: 3 })
    const firedAt: number[] = []
    for (let step = 1; step <= 9; step++) {
      const out = t.onStepFinish({ mutatedFiles: [] })
      if (out.starvation) firedAt.push(step)
    }
    expect(firedAt).toEqual([3, 6, 9])
  })
})

describe("mutation evidence resets the starvation counter (command-agnostic)", () => {
  test("write/edit tool completion counts as mutation", () => {
    const t = tracker({ maxTurnsWithoutMutation: 3 })
    t.onStepFinish({ mutatedFiles: [] })
    t.onStepFinish({ mutatedFiles: [] })
    t.onToolResult({ tool: "write", input: { filePath: "/repo/model.sql", content: "x" } })
    const out = t.onStepFinish({ mutatedFiles: [] })
    expect(out.turnsWithoutMutation).toBe(0)
    expect(out.starvation).toBeUndefined()
  })

  test("bash-mediated mutation (snapshot patch files) counts — no command parsing needed", () => {
    const t = tracker({ maxTurnsWithoutMutation: 3 })
    t.onStepFinish({ mutatedFiles: [] })
    t.onStepFinish({ mutatedFiles: [] })
    // e.g. `sed -i` via bash: no edit event, but the step snapshot diff sees it
    const out = t.onStepFinish({ mutatedFiles: ["models/some_file.sql"] })
    expect(out.turnsWithoutMutation).toBe(0)
    expect(out.starvation).toBeUndefined()
  })
})

describe("mutation credit requires success, never the call alone", () => {
  test("a FAILED mutating tool call does not reset the starvation counter", () => {
    const t = tracker({ maxTurnsWithoutMutation: 3 })
    t.onStepFinish({ mutatedFiles: [] })
    t.onStepFinish({ mutatedFiles: [] })
    // Call is issued but the result fails: no snapshot diff, no success.
    t.onToolCall({ tool: "edit", input: { filePath: "/repo/model.sql" } })
    t.onToolResult({ tool: "edit", input: { filePath: "/repo/model.sql" }, failureMessage: "oldString not found" })
    const out = t.onStepFinish({ mutatedFiles: [] })
    expect(out.turnsWithoutMutation).toBe(3)
    expect(out.starvation).toBeDefined()
  })

  test("a successful mutating tool result still resets the counter", () => {
    const t = tracker({ maxTurnsWithoutMutation: 3 })
    t.onStepFinish({ mutatedFiles: [] })
    t.onStepFinish({ mutatedFiles: [] })
    t.onToolCall({ tool: "edit", input: { filePath: "/repo/model.sql" } })
    t.onToolResult({ tool: "edit", input: { filePath: "/repo/model.sql" } })
    const out = t.onStepFinish({ mutatedFiles: [] })
    expect(out.turnsWithoutMutation).toBe(0)
    expect(out.starvation).toBeUndefined()
  })
})

describe("doom-loop stop latch", () => {
  test("stop fires exactly once per completed ladder run, then the ladder resets", () => {
    const t = tracker({ doomLoopThreshold: 3 })
    const input = { command: "make check" }
    const stops: number[] = []
    for (let i = 1; i <= 20; i++) {
      const call = t.onToolCall({ tool: "bash", input })
      if (call.doomLoop?.escalation === "stop") stops.push(i)
    }
    // First full run stops at 9; the ladder then restarts from zero, so the
    // next stop needs another full run (9 more calls, with nudge/status-check
    // rungs in between) — never a stop on every subsequent call.
    expect(stops).toEqual([9, 18])
  })

  test("after a latched stop, a retried session climbs the full ladder again", () => {
    const t = tracker({ doomLoopThreshold: 3 })
    const input = { command: "make check" }
    for (let i = 1; i <= 9; i++) t.onToolCall({ tool: "bash", input })
    // Retry: first repeated call after the stop is NOT an instant stop.
    const call = t.onToolCall({ tool: "bash", input })
    expect(call.doomLoop).toBeUndefined()
    // The nudge rung comes back at the threshold, as in a fresh session.
    t.onToolCall({ tool: "bash", input })
    const third = t.onToolCall({ tool: "bash", input })
    expect(third.doomLoop?.escalation).toBe("nudge")
  })
})

describe("unchanged-read annotation (content hash; annotate never suppress)", () => {
  test("re-reading identical content yields an informational annotation", () => {
    const t = tracker()
    const input = { filePath: "/repo/models/a.sql" }
    expect(t.onToolResult({ tool: "read", input, output: "select 1" }).readAnnotation).toBeUndefined()
    const second = t.onToolResult({ tool: "read", input, output: "select 1" })
    expect(second.readAnnotation).toBeDefined()
    expect(second.readAnnotation!).toContain("/repo/models/a.sql")
    expect(second.readAnnotation!).toContain("unchanged")
    // annotation is informational — it must not instruct suppression or forbid re-reading
    expect(/do not (re-)?read/i.test(second.readAnnotation!)).toBe(false)
  })

  test("changed content does not annotate", () => {
    const t = tracker()
    const input = { filePath: "/repo/models/a.sql" }
    t.onToolResult({ tool: "read", input, output: "select 1" })
    const second = t.onToolResult({ tool: "read", input, output: "select 2" })
    expect(second.readAnnotation).toBeUndefined()
  })

  test("generated paths are exempt (they regenerate across builds)", () => {
    const t = tracker()
    for (const filePath of ["/repo/target/compiled/model.sql", "/repo/dev.duckdb", "/repo/logs/run.log"]) {
      const input = { filePath }
      t.onToolResult({ tool: "read", input, output: "same" })
      const second = t.onToolResult({ tool: "read", input, output: "same" })
      expect(second.readAnnotation).toBeUndefined()
    }
  })

  test("failed reads never annotate", () => {
    const t = tracker()
    const input = { filePath: "/repo/models/a.sql" }
    t.onToolResult({ tool: "read", input, output: "select 1" })
    const failed = t.onToolResult({ tool: "read", input, failureMessage: "EACCES" })
    expect(failed.readAnnotation).toBeUndefined()
  })
})

describe("repeat_signature loop detection", () => {
  test("three identical (tool+args+failure) signatures fire the diagnostic directive", () => {
    const t = tracker()
    const attempt = { tool: "edit", input: { filePath: "/repo/a.sql", oldString: "x", newString: "y" } }
    const fail = "oldString not found in file"
    expect(t.onToolResult({ ...attempt, failureMessage: fail }).repeatLoop).toBeUndefined()
    expect(t.onToolResult({ ...attempt, failureMessage: fail }).repeatLoop).toBeUndefined()
    const third = t.onToolResult({ ...attempt, failureMessage: fail })
    expect(third.repeatLoop).toBeDefined()
    expect(third.repeatLoop!.count).toBe(3)
    expect(third.repeatLoop!.directive).toContain("DONE")
    expect(third.repeatLoop!.directive).toContain("different action")
  })

  test("a different failure message breaks the signature chain (progress is being made)", () => {
    const t = tracker()
    const attempt = { tool: "edit", input: { filePath: "/repo/a.sql", oldString: "x", newString: "y" } }
    t.onToolResult({ ...attempt, failureMessage: "error A" })
    t.onToolResult({ ...attempt, failureMessage: "error B" })
    const third = t.onToolResult({ ...attempt, failureMessage: "error C" })
    expect(third.repeatLoop).toBeUndefined()
  })

  test("signature includes touched files and normalized args (order-insensitive, whitespace-insensitive)", () => {
    const a = SessionStarvation.repeatSignature({
      tool: "edit",
      args: { filePath: "/a.sql", oldString: "select  1" },
      touchedFiles: ["/a.sql"],
      failureMessage: "not  found",
    })
    const b = SessionStarvation.repeatSignature({
      tool: "edit",
      args: { oldString: "select 1", filePath: "/a.sql" },
      touchedFiles: ["/a.sql"],
      failureMessage: "not found",
    })
    expect(a).toBe(b)
    const c = SessionStarvation.repeatSignature({
      tool: "edit",
      args: { oldString: "select 1", filePath: "/a.sql" },
      touchedFiles: ["/b.sql"],
      failureMessage: "not found",
    })
    expect(c).not.toBe(a)
  })
})

describe("doom-loop escalation ladder — re-keyed on (toolName + normalized args)", () => {
  test("varied-args repetition of the SAME tool never climbs the ladder (the old per-NAME false positive)", () => {
    const t = tracker()
    for (let i = 0; i < 50; i++) {
      const call = t.onToolCall({ tool: "bash", input: { command: `echo ${i}` } })
      expect(call.doomLoop).toBeUndefined()
    }
  })

  test("identical (tool+args) calls escalate nudge → status_check → stop, never straight to stop", () => {
    const t = tracker({ doomLoopThreshold: 3 })
    const input = { command: "make check" }
    const rungs: Array<[number, string]> = []
    for (let i = 1; i <= 9; i++) {
      const call = t.onToolCall({ tool: "bash", input })
      if (call.doomLoop) rungs.push([i, call.doomLoop.escalation])
    }
    expect(rungs).toEqual([
      [3, "nudge"],
      [6, "status_check"],
      [9, "stop"],
    ])
  })

  test("a different call resets the consecutive counter", () => {
    const t = tracker({ doomLoopThreshold: 3 })
    t.onToolCall({ tool: "bash", input: { command: "make check" } })
    t.onToolCall({ tool: "bash", input: { command: "make check" } })
    t.onToolCall({ tool: "bash", input: { command: "ls" } })
    const call = t.onToolCall({ tool: "bash", input: { command: "make check" } })
    expect(call.doomLoop).toBeUndefined()
  })

  test("normalized-args keying: key order and whitespace do not defeat the counter", () => {
    const t = tracker({ doomLoopThreshold: 3 })
    t.onToolCall({ tool: "grep", input: { pattern: "foo", path: "/repo" } })
    t.onToolCall({ tool: "grep", input: { path: "/repo", pattern: "foo" } })
    const call = t.onToolCall({ tool: "grep", input: { pattern: " foo ", path: "/repo" } })
    expect(call.doomLoop).toBeDefined()
    expect(call.doomLoop!.escalation).toBe("nudge")
  })

  test("polling patterns raise the threshold (multiplier), not an exemption", () => {
    const t = tracker({ doomLoopThreshold: 3, pollingThresholdMultiplier: 5 })
    const input = { command: "sleep 5 && curl -s localhost:8080/health" }
    let firstRung: number | undefined
    for (let i = 1; i <= 20; i++) {
      const call = t.onToolCall({ tool: "bash", input })
      if (call.doomLoop && firstRung === undefined) firstRung = i
    }
    expect(firstRung).toBe(15) // 3 * 5, not 3 — and a ceiling still exists
  })

  test("directive text at every rung carries the DONE alternative", () => {
    const t = tracker({ doomLoopThreshold: 3 })
    const input = { command: "make check" }
    for (let i = 1; i <= 9; i++) {
      const call = t.onToolCall({ tool: "bash", input })
      if (call.doomLoop) expect(call.doomLoop.directive).toContain("DONE")
    }
  })
})

describe("armed gating logic (run-mode-only, exempt agents)", () => {
  // Mirrors the gate expression in processor.ts:
  //   sbExempt = exemptAgents.includes(agent) || assistantMessage.summary
  //   sbArmed  = mode === "armed" && runMode && !sbExempt
  //   starvation tracker is created only when mode !== "off" && !sbExempt
  function exempt(resolved: SessionStarvation.ResolvedConfig, agent: string, summary: boolean) {
    return resolved.exemptAgents.includes(agent) || summary
  }
  function armed(mode: SessionStarvation.Mode, runMode: boolean, agent: string, summary = false) {
    const resolved = SessionStarvation.resolveConfig({ mode })
    return mode === "armed" && runMode && !exempt(resolved, agent, summary)
  }
  /** Whether the per-session tracker is wired at all (and so can accumulate steps). */
  function tracks(mode: SessionStarvation.Mode, agent: string, summary = false) {
    const resolved = SessionStarvation.resolveConfig({ mode })
    return mode !== "off" && !exempt(resolved, agent, summary)
  }

  test("annotate mode (the default) never arms — even in run mode", () => {
    expect(armed("annotate", true, "build")).toBe(false)
  })
  test("armed mode outside run mode (TUI/serve) never arms", () => {
    expect(armed("armed", false, "build")).toBe(false)
  })
  test("armed + run mode arms for build agents", () => {
    expect(armed("armed", true, "build")).toBe(true)
  })
  test("armed + run mode stays off for plan/review-class agents", () => {
    expect(armed("armed", true, "plan")).toBe(false)
    expect(armed("armed", true, "review")).toBe(false)
  })

  // The compaction summarizer runs through the same processor under the session's
  // OWN id, so without an exemption its single mutation-free step would advance
  // the working agent's shared tracker.
  test("the compaction summarizer is exempt: no tracker is wired for a summary message", () => {
    expect(tracks("annotate", "build", true)).toBe(false)
    expect(tracks("armed", "build", true)).toBe(false)
    // a normal working step on the same session still tracks
    expect(tracks("annotate", "build", false)).toBe(true)
  })

  test("the compaction summarizer never arms, even in armed run mode", () => {
    expect(armed("armed", true, "build", true)).toBe(false)
    expect(armed("armed", true, "build", false)).toBe(true)
  })

  test("mode 'off' wires no tracker at all", () => {
    expect(tracks("off", "build")).toBe(false)
  })
})

describe("nudge arbiter (one-directive-per-turn contract)", () => {
  test("at most one directive per turn — highest precedence wins, rest dropped", () => {
    const sid = "ses_arbiter_1"
    NudgeArbiter.clear(sid)
    NudgeArbiter.register(sid, { source: "budget_reminder", kind: "budget_60", text: "turn N of M" })
    NudgeArbiter.register(sid, { source: "starvation_breaker", kind: "starvation", text: "starvation directive" })
    NudgeArbiter.register(sid, { source: "termination_challenge", kind: "challenge", text: "confirm DONE" })
    const winner = NudgeArbiter.take(sid)
    expect(winner?.source).toBe("termination_challenge")
    // everything cleared — the turn gets exactly one directive
    expect(NudgeArbiter.take(sid)).toBeUndefined()
  })

  test("precedence: starvation breaker beats budget reminder", () => {
    const sid = "ses_arbiter_2"
    NudgeArbiter.clear(sid)
    NudgeArbiter.register(sid, { source: "budget_reminder", kind: "budget_85", text: "b" })
    NudgeArbiter.register(sid, { source: "starvation_breaker", kind: "repeat_signature", text: "s" })
    expect(NudgeArbiter.take(sid)?.source).toBe("starvation_breaker")
  })

  test("same source+kind replaces rather than stacks", () => {
    const sid = "ses_arbiter_3"
    NudgeArbiter.clear(sid)
    NudgeArbiter.register(sid, { source: "starvation_breaker", kind: "starvation", text: "v1" })
    NudgeArbiter.register(sid, { source: "starvation_breaker", kind: "starvation", text: "v2" })
    expect(NudgeArbiter.pending(sid)).toHaveLength(1)
    expect(NudgeArbiter.take(sid)?.text).toBe("v2")
  })

  test("sessions are isolated", () => {
    NudgeArbiter.clear("ses_a")
    NudgeArbiter.clear("ses_b")
    NudgeArbiter.register("ses_a", { source: "starvation_breaker", kind: "starvation", text: "a" })
    expect(NudgeArbiter.take("ses_b")).toBeUndefined()
    expect(NudgeArbiter.take("ses_a")?.text).toBe("a")
  })
})

describe("session-scoped tracker store", () => {
  test("trackers persist across processor instances (per-step create) for the same session", () => {
    const resolved = SessionStarvation.resolveConfig({ max_turns_without_mutation: 3 })
    SessionStarvation.clear("ses_store_1")
    const first = SessionStarvation.forSession("ses_store_1", resolved)
    first.onStepFinish({ mutatedFiles: [] })
    first.onStepFinish({ mutatedFiles: [] })
    // a new processor for the next step must see the accumulated state
    const second = SessionStarvation.forSession("ses_store_1", resolved)
    const out = second.onStepFinish({ mutatedFiles: [] })
    expect(out.starvation).toBeDefined()
    SessionStarvation.clear("ses_store_1")
  })
})

describe("forSession LRU eviction", () => {
  test("an active session's tracker survives churn from newer sessions", () => {
    const prefix = "ses_lru_starve_"
    const first = SessionStarvation.forSession(`${prefix}0`, cfg)
    for (let i = 1; i < 128; i++) SessionStarvation.forSession(`${prefix}${i}`, cfg)
    // Access #0 again: recency refreshed, same tracker returned.
    expect(SessionStarvation.forSession(`${prefix}0`, cfg)).toBe(first)
    // A new session evicts the least-recently-used (#1), never the active #0.
    SessionStarvation.forSession(`${prefix}extra`, cfg)
    expect(SessionStarvation.forSession(`${prefix}0`, cfg)).toBe(first)
    // Cleanup so this suite leaves no global state behind.
    for (let i = 0; i < 128; i++) SessionStarvation.clear(`${prefix}${i}`)
    SessionStarvation.clear(`${prefix}extra`)
  })
})
