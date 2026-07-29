// altimate_change — coverage for the onboarding funnel taxonomy.
//
// The question these answer is "does user action X emit event Y, with the right properties".
// Emission is verified by spying on Telemetry.track, so the assertions are about what would be
// sent, not about the transport.
//
// Expected values are written out literally from the product spec rather than derived from the
// implementation — a test that computes its expectation the same way the code does would pass
// even when both are wrong.
import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from "bun:test"
import { Telemetry } from "@/altimate/telemetry"
import * as Onboarding from "@/altimate/telemetry/onboarding"
import { OnboardingTelemetryPlugin } from "@/altimate/plugin/onboarding-telemetry"

type Tracked = Telemetry.Event

function captureEvents() {
  const events: Tracked[] = []
  // init() reads config and touches the filesystem; the funnel logic under test does not care.
  spyOn(Telemetry, "init").mockImplementation(async () => {})
  spyOn(Telemetry, "track").mockImplementation((event: Tracked) => {
    events.push(event)
  })
  return events
}

/** Wait for the fire-and-forget `void emit(...)` promises to settle. */
const settle = () => Bun.sleep(0)

beforeEach(() => {
  Onboarding.resetForTest()
})

afterEach(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// Abandonment — the funnel must only contain people who were actually in it
// ---------------------------------------------------------------------------
describe("onboarding abandonment", () => {
  test("a returning user who opens the picker is not in the funnel", async () => {
    const events = captureEvents()

    // No onboarding_started: this is /connect from an established user, which mounts the very
    // same picker. Reaching a stage must not enrol them.
    Onboarding.markStage("model_picker")
    await Onboarding.emitAbandonedIfIncomplete()
    await settle()

    expect(events).toEqual([])
  })

  test("quitting mid first-run reports the furthest stage reached", async () => {
    const events = captureEvents()

    await Onboarding.emit({ type: "onboarding_started" })
    await Onboarding.emit({ type: "model_picker_shown", trigger: "first_run" })
    await Onboarding.emit({ type: "provider_selected", provider: "anthropic" })
    await Onboarding.emitAbandonedIfIncomplete()
    await settle()

    const abandoned = events.filter((e) => e.type === "onboarding_abandoned")
    expect(abandoned).toHaveLength(1)
    // Picking a provider and quitting during key entry is "got as far as setting up a provider",
    // not "only ever saw the picker".
    expect((abandoned[0] as any).last_stage).toBe("provider_setup")
  })

  test("a completed onboarding is never reported as abandoned", async () => {
    const events = captureEvents()

    await Onboarding.emit({ type: "onboarding_started" })
    await Onboarding.emit({ type: "onboarding_completed" })
    await Onboarding.emitAbandonedIfIncomplete()
    await settle()

    expect(events.some((e) => e.type === "onboarding_abandoned")).toBe(false)
  })

  test("re-opening the picker later does not walk the stage backwards", async () => {
    const events = captureEvents()

    await Onboarding.emit({ type: "onboarding_started" })
    await Onboarding.emit({ type: "gateway_device_code_issued" })
    await Onboarding.emit({ type: "model_picker_shown", trigger: "big_pickle_back" })
    await Onboarding.emitAbandonedIfIncomplete()
    await settle()

    const abandoned = events.find((e) => e.type === "onboarding_abandoned")
    expect((abandoned as any).last_stage).toBe("gateway_auth")
  })

  test("abandonment fires at most once", async () => {
    const events = captureEvents()

    await Onboarding.emit({ type: "onboarding_started" })
    await Onboarding.emitAbandonedIfIncomplete()
    await Onboarding.emitAbandonedIfIncomplete()
    await settle()

    expect(events.filter((e) => e.type === "onboarding_abandoned")).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Activation — inferred from the plugin hooks
// ---------------------------------------------------------------------------
describe("activation events", () => {
  const SESSION = "ses_test"

  async function plugin() {
    return OnboardingTelemetryPlugin({} as any)
  }

  async function startOnboarding(hooks: any, args: "scan" | "skip") {
    await hooks["command.execute.before"]!({ command: "onboard-connect", sessionID: SESSION, arguments: args }, {
      parts: [],
    })
  }

  test("skipping the scan shows the no-data menu immediately", async () => {
    const events = captureEvents()
    const hooks = await plugin()

    await startOnboarding(hooks, "skip")
    await settle()

    const menu = events.filter((e) => e.type === "activation_menu_shown")
    expect(menu).toHaveLength(1)
    expect((menu[0] as any).variant).toBe("no_data")
  })

  test("a warehouse discovered from dbt profiles still counts as having a warehouse", async () => {
    const events = captureEvents()
    const hooks = await plugin()
    await startOnboarding(hooks, "scan")

    // The adversarial case: nothing is already configured, but the scan discovered a connection
    // from a dbt profile. This user HAS a warehouse and must get the warehouse menu — reading
    // only `existing` would send them down the sample-project branch.
    await hooks["tool.execute.after"]!(
      { tool: "project_scan", sessionID: SESSION, callID: "c1", args: {} },
      { title: "", output: "", metadata: { connections: { existing: 0, new_dbt: 1, new_docker: 0, new_env: 0 } } },
    )
    await settle()

    const menu = events.filter((e) => e.type === "activation_menu_shown")
    expect(menu).toHaveLength(1)
    expect((menu[0] as any).variant).toBe("warehouse")
  })

  test("a scan that finds nothing shows the no-data menu", async () => {
    const events = captureEvents()
    const hooks = await plugin()
    await startOnboarding(hooks, "scan")

    await hooks["tool.execute.after"]!(
      { tool: "project_scan", sessionID: SESSION, callID: "c1", args: {} },
      { title: "", output: "", metadata: { connections: { existing: 0, new_dbt: 0, new_docker: 0, new_env: 0 } } },
    )
    await settle()

    expect((events.find((e) => e.type === "activation_menu_shown") as any).variant).toBe("no_data")
  })

  test("loading a skill selects a job but does not complete one", async () => {
    const events = captureEvents()
    const hooks = await plugin()
    await startOnboarding(hooks, "skip")

    // The skill tool loads an instruction bundle; the analysis itself happens afterwards through
    // other tools. Reporting completion here would claim the job finished the moment the
    // instructions were read.
    await hooks["tool.execute.after"]!(
      { tool: "skill", sessionID: SESSION, callID: "c2", args: { name: "dbt-analyze" } },
      { title: "", output: "", metadata: { name: "dbt-analyze" } },
    )
    await settle()

    const selected = events.filter((e) => e.type === "activation_job_selected")
    expect(selected).toHaveLength(1)
    expect((selected[0] as any).job).toBe("breaks_downstream")
    expect(events.some((e) => e.type === "first_job_completed")).toBe(false)
  })

  test("the sample project both selects and completes a job", async () => {
    const events = captureEvents()
    const hooks = await plugin()
    await startOnboarding(hooks, "skip")

    await hooks["tool.execute.after"]!(
      { tool: "sample_setup", sessionID: SESSION, callID: "c3", args: {} },
      { title: "", output: "", metadata: { success: true } },
    )
    await settle()

    expect((events.find((e) => e.type === "activation_job_selected") as any).job).toBe("sample_duck_db")
    expect((events.find((e) => e.type === "first_job_completed") as any).job).toBe("sample_duck_db")
  })

  test("a failed sample setup counts as selected but not completed", async () => {
    const events = captureEvents()
    const hooks = await plugin()
    await startOnboarding(hooks, "skip")

    await hooks["tool.execute.after"]!(
      { tool: "sample_setup", sessionID: SESSION, callID: "c4", args: {} },
      { title: "", output: "", metadata: { success: false } },
    )
    await settle()

    expect(events.some((e) => e.type === "activation_job_selected")).toBe(true)
    expect(events.some((e) => e.type === "first_job_completed")).toBe(false)
  })

  test("only the first job counts as the activation job", async () => {
    const events = captureEvents()
    const hooks = await plugin()
    await startOnboarding(hooks, "skip")

    await hooks["tool.execute.after"]!(
      { tool: "sample_setup", sessionID: SESSION, callID: "c5", args: {} },
      { title: "", output: "", metadata: { success: true } },
    )
    await hooks["tool.execute.after"]!(
      { tool: "skill", sessionID: SESSION, callID: "c6", args: { name: "sql-review" } },
      { title: "", output: "", metadata: {} },
    )
    await settle()

    expect(events.filter((e) => e.type === "activation_job_selected")).toHaveLength(1)
  })

  test("tools run outside an onboarding session emit nothing", async () => {
    const events = captureEvents()
    const hooks = await plugin()

    // No /onboard-connect for this session — an ordinary chat where someone happens to use a
    // reviewable skill must not look like onboarding activation.
    await hooks["tool.execute.after"]!(
      { tool: "skill", sessionID: "ses_other", callID: "c7", args: { name: "sql-review" } },
      { title: "", output: "", metadata: {} },
    )
    await settle()

    expect(events).toEqual([])
  })

  test("helper tools are not mistaken for activation jobs", async () => {
    const events = captureEvents()
    const hooks = await plugin()
    await startOnboarding(hooks, "skip")

    for (const tool of ["read", "bash", "warehouse_add"]) {
      await hooks["tool.execute.after"]!(
        { tool, sessionID: SESSION, callID: tool, args: {} },
        { title: "", output: "", metadata: {} },
      )
    }
    await settle()

    expect(events.some((e) => e.type === "activation_job_selected")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Slash-command suppression, which first_prompt_sent depends on
// ---------------------------------------------------------------------------
describe("command submission tracking", () => {
  test("a command-submitted message is flagged, once", () => {
    Onboarding.noteCommandSubmission("ses_a")
    expect(Onboarding.consumeCommandSubmission("ses_a")).toBe(true)
    expect(Onboarding.consumeCommandSubmission("ses_a")).toBe(false)
  })

  test("a session that never ran a command is not flagged", () => {
    expect(Onboarding.consumeCommandSubmission("ses_never")).toBe(false)
  })

  test("the flag does not leak between sessions", () => {
    Onboarding.noteCommandSubmission("ses_a")
    expect(Onboarding.consumeCommandSubmission("ses_b")).toBe(false)
    expect(Onboarding.consumeCommandSubmission("ses_a")).toBe(true)
  })

  test("every slash command is flagged, not just /onboard-connect", async () => {
    const hooks = await OnboardingTelemetryPlugin({} as any)
    await hooks["command.execute.before"]!(
      { command: "discover", sessionID: "ses_c", arguments: "" },
      { parts: [] } as any,
    )
    expect(Onboarding.consumeCommandSubmission("ses_c")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// launch_id — added during envelope conversion, so a track() spy cannot see it
// ---------------------------------------------------------------------------
describe("launch correlation id", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  test("every event in a run carries the same launch_id", async () => {
    const origDisabled = process.env.ALTIMATE_TELEMETRY_DISABLED
    const origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const bodies: string[] = []
    const fetchMock = spyOn(global, "fetch").mockImplementation((async (_input: any, init: any) => {
      bodies.push(String(init?.body ?? ""))
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch)

    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
        "InstrumentationKey=k;IngestionEndpoint=https://example.invalid"
      await Telemetry.init()

      Telemetry.track({ type: "onboarding_started", timestamp: 1, session_id: "" })
      Telemetry.track({ type: "scan_gate_choice", timestamp: 2, session_id: "ses_1", choice: "scan" })
      await Telemetry.flush()

      // Select by name rather than by position: the telemetry buffer is module-global, so a
      // sibling test file can leave events in it and they flush alongside these.
      const envelopes = JSON.parse(bodies[0]) as any[]
      const byName = (name: string) => envelopes.find((e) => e.data.baseData.name === name)
      const preSession = byName("onboarding_started")
      const withSession = byName("scan_gate_choice")
      expect(preSession).toBeDefined()
      expect(withSession).toBeDefined()

      // The whole point: an event emitted before any session exists and one emitted with a real
      // session must still be joinable to the same run.
      expect(preSession.data.baseData.properties.launch_id).toBeTruthy()
      expect(preSession.data.baseData.properties.launch_id).toBe(withSession.data.baseData.properties.launch_id)
    } finally {
      process.env.ALTIMATE_TELEMETRY_DISABLED = origDisabled
      if (origCs !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  })
})
