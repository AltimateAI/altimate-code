// altimate_change — review feature telemetry.
//
// The load-bearing test here is the last one: caller attribution works only because these events
// do NOT declare a `source` field, so the envelope's process-level value survives. That is
// invisible to a Telemetry.track spy — it only appears after serialization — so it is asserted at
// the transport level.
import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, test, afterEach, spyOn, mock } from "bun:test"
import { Telemetry } from "@/altimate/telemetry"
import {
  classifyPostOutcome,
  classifyReviewFailure,
  emitReviewPostOutcome,
  emitReviewRun,
} from "@/altimate/review/telemetry"
import { ReviewCategory } from "@/altimate/review/finding"

function captureEvents() {
  const events: Telemetry.Event[] = []
  spyOn(Telemetry, "track").mockImplementation((e: Telemetry.Event) => {
    events.push(e)
  })
  return events
}

/** Minimal envelope with only what the emitter reads. */
function envelope(over: Record<string, any> = {}) {
  return {
    verdict: "COMMENT",
    idealVerdict: "REQUEST_CHANGES",
    mode: "comment",
    tier: "full",
    summary: {
      critical: 1,
      warning: 2,
      suggestion: 0,
      degraded: false,
      lintOnly: false,
      undecidableFindings: 0,
      artifactHints: [],
      aiReview: { status: "ok", findings: 2, model: "altimate-gateway/altimate-base" },
    },
    findings: [
      { category: "join_risk", severity: "critical" },
      { category: "join_risk", severity: "warning" },
      { category: "sql_quality", severity: "warning" },
    ],
    ...over,
  } as any
}

afterEach(() => mock.restore())

describe("review_run", () => {
  test("a completed run reports the envelope's own values", () => {
    const events = captureEvents()
    emitReviewRun({ invocation: "cli", durationMs: 1234, sessionID: "", envelope: envelope() })

    const e = events[0] as any
    expect(e.type).toBe("review_run")
    expect(e.status).toBe("completed")
    expect(e.invocation).toBe("cli")
    expect(e.verdict).toBe("COMMENT")
    // The pre-gating verdict is what shows whether `comment` mode softened a block.
    expect(e.ideal_verdict).toBe("REQUEST_CHANGES")
    expect(e.critical).toBe(1)
    expect(e.duration_ms).toBe(1234)
    expect(e.ai_status).toBe("ok")
    expect(e.ai_model).toBe("altimate-gateway/altimate-base")
    expect(e.ai_findings).toBe(2)
    expect(e.undecidable_findings).toBe(0)
    expect(e.lint_only).toBe(false)
    expect(e.empty_scope).toBe(false)
  })

  test("tier_forced normalises absent to false", () => {
    // The schema allows only `true` or absent — `false` is explicitly invalid — so copying the
    // raw field would put `undefined` in the event for the common case.
    const events = captureEvents()
    emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", envelope: envelope() })
    expect((events[0] as any).tier_forced).toBe(false)

    events.length = 0
    emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", envelope: envelope({ tierForced: true }) })
    expect((events[0] as any).tier_forced).toBe(true)
  })

  test("by_category is zero-filled across the whole enum", () => {
    const events = captureEvents()
    emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", envelope: envelope() })

    const byCategory = (events[0] as any).by_category
    // Zero-filled so "this rule never fired" is distinguishable from "this rule was not possible".
    expect(Object.keys(byCategory).sort()).toEqual([...ReviewCategory.options].sort())
    expect(byCategory.join_risk).toBe(2)
    expect(byCategory.sql_quality).toBe(1)
    expect(byCategory.pii_exposure).toBe(0)
  })

  test("an unrecognised category cannot create a new dimension", () => {
    const events = captureEvents()
    emitReviewRun({
      invocation: "cli",
      durationMs: 1,
      sessionID: "",
      envelope: envelope({ findings: [{ category: "not_a_real_category", severity: "warning" }] }),
    })

    const byCategory = (events[0] as any).by_category
    expect(byCategory.not_a_real_category).toBeUndefined()
    expect(Object.keys(byCategory)).toHaveLength(ReviewCategory.options.length)
  })

  test("a category naming an Object.prototype member cannot slip past the guard", () => {
    // The ordinary-string case above cannot catch this: `{}` plus `in` returns true for every
    // prototype member, so `toString` both minted a dimension AND made `counts[k] += 1` evaluate
    // `<native function> + 1` — a string inside a Record<string, number>. Fails before the
    // Object.create(null) / Object.hasOwn fix.
    const events = captureEvents()
    emitReviewRun({
      invocation: "cli",
      durationMs: 1,
      sessionID: "",
      envelope: envelope({
        findings: [
          { category: "toString", severity: "warning" },
          { category: "constructor", severity: "warning" },
          { category: "valueOf", severity: "warning" },
          { category: "__proto__", severity: "warning" },
        ],
      }),
    })

    const byCategory = (events[0] as any).by_category
    expect(Object.keys(byCategory)).toHaveLength(ReviewCategory.options.length)
    for (const v of Object.values(byCategory)) expect(typeof v).toBe("number")
  })

  test("stale_manifest and run-level degraded states are carried from the envelope", () => {
    // Same `=== true` normalisation as tier_forced, which has its own test; these two had none,
    // and the shared envelope() helper omits staleManifest so every other test covers only the
    // undefined case.
    const events = captureEvents()
    emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", envelope: envelope() })
    expect((events[0] as any).stale_manifest).toBe(false)
    expect((events[0] as any).degraded).toBe(false)
    expect((events[0] as any).lint_only).toBe(false)
    expect((events[0] as any).empty_scope).toBe(false)

    events.length = 0
    emitReviewRun({
      invocation: "cli",
      durationMs: 1,
      sessionID: "",
      envelope: envelope({
        staleManifest: true,
        summary: {
          critical: 0,
          warning: 0,
          suggestion: 0,
          degraded: true,
          lintOnly: true,
          undecidableFindings: 0,
          artifactHints: [],
        },
      }),
    })
    expect((events[0] as any).stale_manifest).toBe(true)
    expect((events[0] as any).degraded).toBe(true)
    expect((events[0] as any).lint_only).toBe(true)
    expect((events[0] as any).empty_scope).toBe(false)

    events.length = 0
    emitReviewRun({
      invocation: "cli",
      durationMs: 1,
      sessionID: "",
      envelope: envelope({
        summary: {
          critical: 0,
          warning: 0,
          suggestion: 0,
          degraded: true,
          lintOnly: false,
          emptyScope: true,
          undecidableFindings: 0,
          artifactHints: [],
        },
      }),
    })
    expect((events[0] as any).degraded).toBe(true)
    expect((events[0] as any).lint_only).toBe(false)
    expect((events[0] as any).empty_scope).toBe(true)

    events.length = 0
    emitReviewRun({
      invocation: "cli",
      durationMs: 1,
      sessionID: "",
      envelope: envelope({
        summary: {
          critical: 0,
          warning: 0,
          suggestion: 0,
          degraded: true,
          emptyScope: true,
          undecidableFindings: 0,
          artifactHints: [],
        },
      }),
    })
    expect((events[0] as any).lint_only).toBe(false)
    expect((events[0] as any).empty_scope).toBe(true)

    events.length = 0
    emitReviewRun({
      invocation: "cli",
      durationMs: 1,
      sessionID: "",
      envelope: envelope({
        summary: {
          critical: 0,
          warning: 0,
          suggestion: 0,
          degraded: true,
          undecidableFindings: 0,
          artifactHints: [],
        },
      }),
    })
    expect((events[0] as any).lint_only).toBe(true)
    expect((events[0] as any).empty_scope).toBe(false)
  })

  test("undecidable findings do not turn review_run degraded", () => {
    const events = captureEvents()
    emitReviewRun({
      invocation: "cli",
      durationMs: 1,
      sessionID: "",
      envelope: envelope({
        summary: {
          critical: 0,
          warning: 1,
          suggestion: 0,
          degraded: false,
          lintOnly: false,
          undecidableFindings: 1,
          artifactHints: [],
          aiReview: { status: "timeout", reason: "timed out after 62s", findings: 0 },
        },
      }),
    })

    expect((events[0] as any).degraded).toBe(false)
    expect((events[0] as any).undecidable_findings).toBe(1)
    expect((events[0] as any).ai_status).toBe("timeout")
    expect((events[0] as any).ai_findings).toBe(0)
  })

  test("undecidable findings fall back to degraded findings for compatibility envelopes", () => {
    const events = captureEvents()
    const env = envelope()
    delete env.summary.undecidableFindings
    env.findings = [
      { category: "semantic_change", severity: "warning", degraded: true },
      { category: "sql_quality", severity: "warning", degraded: false },
    ]

    emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", envelope: env })

    expect((events[0] as any).undecidable_findings).toBe(1)
  })

  test("the tool path carries its session, the CLI path does not", () => {
    const events = captureEvents()
    emitReviewRun({ invocation: "tool", durationMs: 1, sessionID: "ses_abc", envelope: envelope() })
    expect((events[0] as any).session_id).toBe("ses_abc")
    expect((events[0] as any).invocation).toBe("tool")
  })

  test("a failed run reports a reason and no envelope fields", () => {
    const events = captureEvents()
    emitReviewRun({ invocation: "cli", durationMs: 5, sessionID: "", error: new Error("boom") })

    const e = events[0] as any
    expect(e.status).toBe("failed")
    expect(e.reason).toBe("error")
    expect(e.verdict).toBeUndefined()
    expect(e.by_category).toBeUndefined()
  })

  test("no schema identifier reaches the event", () => {
    const events = captureEvents()
    emitReviewRun({
      invocation: "cli",
      durationMs: 1,
      sessionID: "",
      envelope: envelope({
        findings: [
          {
            category: "pii_exposure",
            severity: "critical",
            file: "models/marts/customers.sql",
            model: "customers",
            column: "email",
            title: "PII exposed",
            body: "column email is now selected",
          },
        ],
      }),
    })

    // Review findings are about customer schema; the serialized event must contain none of it.
    const serialized = JSON.stringify(events[0])
    for (const leak of ["models/marts", "customers", "email", "PII exposed", "now selected"]) {
      expect(serialized).not.toContain(leak)
    }
  })
})

describe("telemetry failure isolation", () => {
  // The two empty catch blocks in the emitters are the "observability must never break
  // functionality" guarantee. Removing either one fails these and nothing else.
  test("a throwing Telemetry.track cannot propagate out of either emitter", () => {
    spyOn(Telemetry, "track").mockImplementation(() => {
      throw new Error("buffer full")
    })

    expect(() =>
      emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", envelope: envelope() }),
    ).not.toThrow()
    expect(() => emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", error: new Error("x") })).not.toThrow()
    expect(() => emitReviewPostOutcome({ outcome: "not_requested", durationMs: 0, sessionID: "" })).not.toThrow()
  })
})

describe("failure classification", () => {
  test("the config loader's fixed prefix", () => {
    expect(classifyReviewFailure(new Error("Failed to load .altimate/review.yml: bad yaml"))).toBe("config_error")
  })

  test("a git child-process failure by spawn identity, not message text", () => {
    const err = Object.assign(new Error("Command failed"), { cmd: "git diff --name-status" })
    expect(classifyReviewFailure(err)).toBe("git_error")
  })

  test("a git-shaped message without a cmd is not a git error", () => {
    // The message fallback that used to classify this was unreachable for the real git path
    // (execFile always sets `cmd`, and its message starts "Command failed: ") and contradicted
    // the docstring's promise not to substring-match. Removed.
    expect(classifyReviewFailure(new Error("git diff exploded"))).toBe("error")
  })

  test("anything else is `error` rather than an invented bucket", () => {
    // The engine degrades rather than throwing for missing manifests, dispatcher failures and the
    // AI lane, so there are no buckets for those — they never arrive here.
    expect(classifyReviewFailure(new Error("something unexpected"))).toBe("error")
    expect(classifyReviewFailure("not even an error")).toBe("error")
  })
})

describe("post outcome", () => {
  test("a clean post is full", () => {
    expect(classifyPostOutcome({ reviewId: 1, inlineFellBack: false })).toBe("full")
  })

  test("every degraded state collapses to partial", () => {
    // PostResult cannot distinguish these: postError is not cleared when the retry succeeds, and
    // an inline fallback coexists with a real reviewId. Claiming finer resolution would be a lie.
    expect(classifyPostOutcome({ reviewId: 1, inlineFellBack: true })).toBe("partial")
    expect(classifyPostOutcome({ reviewId: 1, inlineFellBack: false, postError: "429" })).toBe("partial")
    expect(classifyPostOutcome({ inlineFellBack: false })).toBe("partial")
  })
})

describe("caller attribution", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  test("the process client source reaches the serialized event", async () => {
    // This is what makes attribution free: the events declare no `source` field, so the envelope's
    // seed survives. Asserted after serialization because a Telemetry.track spy cannot see it.
    const origDisabled = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const origClient = process.env.ALTIMATE_CLI_CLIENT
    // Before the fetch spy below, not after — restoring afterwards would remove that spy and leave
    // `bodies` empty. Every other describe in this file spies Telemetry.track, and this is the only
    // test that needs the real one plus a real init; relying on a sibling's afterEach to have
    // undone that spy makes the result depend on suite ordering.
    mock.restore()
    // Real init writes ~/.altimate/machine-id. Point HOME at a temp dir so running the unit suite
    // cannot mint an identity the developer's own CLI would then reuse.
    const origHome = process.env.HOME
    const origUserProfile = process.env.USERPROFILE
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-review-telemetry-"))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    const bodies: string[] = []
    const fetchMock = spyOn(global, "fetch").mockImplementation((async (_i: any, init: any) => {
      bodies.push(String(init?.body ?? ""))
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch)

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://example.invalid"
      process.env.ALTIMATE_CLI_CLIENT = "plugin:claude-code"
      // init() is `initPromise ??= doInit()`, so a resolved initPromise left by any earlier init in
      // this process — including one that ran while telemetry was disabled — is handed back as-is
      // and the connection string set above is ignored. shutdown() clearing initPromise is the
      // only reset seam the module exposes.
      await Telemetry.shutdown()
      await Telemetry.init()
      // Fail here with a cause rather than below on an empty batch: a surviving spy, a
      // disabled-telemetry env var and an unparseable connection string all show up as `false`.
      expect(Telemetry.isEnabled()).toBe(true)

      emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", envelope: envelope() })
      emitReviewPostOutcome({ outcome: "not_requested", durationMs: 0, sessionID: "" })
      await Telemetry.flush()

      // Across all bodies, not bodies[0]: the buffer is module-global and the periodic flush can
      // fire before this one, splitting these two events across batches.
      const envelopes = bodies.flatMap((body) => JSON.parse(body) as any[])
      const run = envelopes.find((e) => e.data.baseData.name === "review_run")
      const post = envelopes.find((e) => e.data.baseData.name === "review_post_outcome")
      expect(run.data.baseData.properties.source).toBe("plugin:claude-code")
      expect(post.data.baseData.properties.source).toBe("plugin:claude-code")
    } finally {
      // Unlike the two restores below, this was unconditional: an originally-absent variable
      // came back as the string "undefined", leaking a disabled-telemetry flag into later tests
      // and any child process they spawn.
      if (origDisabled !== undefined) process.env.ALTIMATE_TELEMETRY_DISABLED = origDisabled
      else delete process.env.ALTIMATE_TELEMETRY_DISABLED
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      if (origClient !== undefined) process.env.ALTIMATE_CLI_CLIENT = origClient
      else delete process.env.ALTIMATE_CLI_CLIENT
      if (origHome !== undefined) process.env.HOME = origHome
      else delete process.env.HOME
      if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile
      else delete process.env.USERPROFILE
      fs.rmSync(tmpHome, { recursive: true, force: true })
      fetchMock.mockRestore()
    }
  })
})
