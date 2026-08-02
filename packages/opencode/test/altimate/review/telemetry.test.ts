// altimate_change — review feature telemetry.
//
// The load-bearing test here is the last one: caller attribution works only because these events
// do NOT declare a `source` field, so the envelope's process-level value survives. That is
// invisible to a Telemetry.track spy — it only appears after serialization — so it is asserted at
// the transport level.
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
    summary: { critical: 1, warning: 2, suggestion: 0, degraded: false },
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

describe("failure classification", () => {
  test("the config loader's fixed prefix", () => {
    expect(classifyReviewFailure(new Error("Failed to load .altimate/review.yml: bad yaml"))).toBe("config_error")
  })

  test("a git child-process failure by spawn identity, not message text", () => {
    const err = Object.assign(new Error("Command failed"), { cmd: "git diff --name-status" })
    expect(classifyReviewFailure(err)).toBe("git_error")
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
      await Telemetry.init()

      emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", envelope: envelope() })
      emitReviewPostOutcome({ outcome: "not_requested", durationMs: 0, sessionID: "" })
      await Telemetry.flush()

      const envelopes = JSON.parse(bodies[0]) as any[]
      const run = envelopes.find((e) => e.data.baseData.name === "review_run")
      const post = envelopes.find((e) => e.data.baseData.name === "review_post_outcome")
      expect(run.data.baseData.properties.source).toBe("plugin:claude-code")
      expect(post.data.baseData.properties.source).toBe("plugin:claude-code")
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origDisabled
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      if (origClient !== undefined) process.env.ALTIMATE_CLI_CLIENT = origClient
      else delete process.env.ALTIMATE_CLI_CLIENT
      fetchMock.mockRestore()
    }
  })
})
