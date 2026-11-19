import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  PLUGIN_FEATURES,
  PLUGIN_OS,
  PLUGIN_OUTCOMES,
  REPORT_ACTIONS,
  reportEvent,
} from "../../../src/altimate/tool-cli/report-event"

const SESSION = "claude:3f6c2a10-7b2e-4c1d-9a55-0e1f2a3b4c5d"
const INSTALL = "0f3c2a1e-6b7d-4c8e-9f10-1a2b3c4d5e6f"

describe("tool report-event", () => {
  test("an action and a Claude Code session make one event with nothing else in it", () => {
    expect(REPORT_ACTIONS).toEqual(["summary_shown", "open_pressed", "command_run", "built", "build_failed", "no_browser"])
    for (const action of REPORT_ACTIONS) {
      expect(reportEvent(action, "claude:3f6c2a10-7b2e-4c1d-9a55-0e1f2a3b4c5d", 1000)).toEqual({
        type: "lineage_report",
        timestamp: 1000,
        session_id: "claude:3f6c2a10-7b2e-4c1d-9a55-0e1f2a3b4c5d",
        action,
      })
    }
  })

  test("an action outside the list is refused", () => {
    for (const action of ["clicked_column", "", undefined, "built; rm -rf /", "plugin_installed"])
      expect(reportEvent(action, "claude:abc")).toHaveProperty("error")
  })

  test("a session that is not claude:<id> is refused, so no path or name can ride along", () => {
    for (const session of ["abc", "codex:abc", "claude:", "claude:/home/someone/project", "claude:a b", `claude:${"x".repeat(129)}`, undefined])
      expect(reportEvent("built", session)).toHaveProperty("error")
  })

  test("a lineage report step takes only its action and session: a plugin field with it is refused", () => {
    expect(reportEvent("built", SESSION, 7, {})).toEqual({ type: "lineage_report", timestamp: 7, session_id: SESSION, action: "built" })
    expect(reportEvent("built", SESSION, 7, { pluginVersion: "1.8.2", installId: INSTALL })).toEqual({ error: "built does not take --plugin-version, --install-id" })
  })
})

describe("tool report-event: the plugin's usage", () => {
  test("a session start carries the plugin and altimate-code versions, the OS and the install id, and nothing else", () => {
    for (const os of PLUGIN_OS) {
      expect(reportEvent("plugin_session_start", SESSION, 1000, { pluginVersion: "1.8.2", installId: INSTALL, os }, "0.13.4")).toEqual({
        type: "plugin_session_start",
        timestamp: 1000,
        session_id: SESSION,
        plugin_version: "1.8.2",
        altimate_code_version: "0.13.4",
        os,
        install_id: INSTALL,
      })
    }
  })

  test("a feature used carries the feature and its outcome, and nothing else", () => {
    expect(PLUGIN_FEATURES).toEqual([
      "lineage",
      "dbt_show",
      "profile_ctes",
      "scan_cost",
      "comments",
      "sql_graph",
      "health",
      "runs",
      "to_model",
      "cost_gate",
      "health_push_gate",
    ])
    expect(PLUGIN_OUTCOMES).toEqual(["opened", "failed", "held", "allowed"])
    for (const feature of PLUGIN_FEATURES)
      for (const outcome of PLUGIN_OUTCOMES)
        expect(reportEvent("plugin_feature_used", SESSION, 1000, { pluginVersion: "1.8.2-beta.1", installId: INSTALL, feature, outcome })).toEqual({
          type: "plugin_feature_used",
          timestamp: 1000,
          session_id: SESSION,
          plugin_version: "1.8.2-beta.1",
          install_id: INSTALL,
          feature,
          outcome,
        })
  })

  test("a plugin version that is not a semver is refused, so no name or path rides in it", () => {
    for (const pluginVersion of [
      "",
      "1.8",
      "1.8.2 /Users/me/project",
      "/opt/plugin",
      "v1.8.2",
      "01.8.2",
      "1.8.2-",
      "1.8.2-..",
      "1.8.2-foo..bar",
      "1.8.2-01",
      "1.8.2+",
      "1.8.2+a..b",
      "1.8.2-" + "x".repeat(60),
      undefined,
      182,
    ])
      expect({ pluginVersion, event: reportEvent("plugin_session_start", SESSION, 1, { pluginVersion, installId: INSTALL, os: "macos" }) }).toMatchObject({
        pluginVersion,
        event: { error: expect.any(String) },
      })
    for (const pluginVersion of ["unknown", "0.0.0", "1.8.2", "1.8.2-beta.1", "1.8.2-0.3.7", "1.8.2-x-y.7z", "1.8.2+build.7", "1.8.2-rc.1+sha.5114f85"])
      expect(reportEvent("plugin_session_start", SESSION, 1, { pluginVersion, installId: INSTALL, os: "macos" })).not.toHaveProperty("error")
  })

  test("each plugin action refuses a field it does not take", () => {
    expect(reportEvent("plugin_session_start", SESSION, 1, { pluginVersion: "1.8.2", installId: INSTALL, os: "macos", feature: "lineage" })).toEqual({
      error: "plugin_session_start does not take --feature",
    })
    expect(reportEvent("plugin_feature_used", SESSION, 1, { pluginVersion: "1.8.2", installId: INSTALL, os: "macos", feature: "lineage", outcome: "opened" })).toEqual({
      error: "plugin_feature_used does not take --os",
    })
  })

  test("an install id that is not a lowercase UUID is refused", () => {
    // Version 0 and a non-RFC variant are not what crypto.randomUUID makes.
    for (const installId of ["", "machine", "orders_model", INSTALL.toUpperCase(), `${INSTALL}x`, "../../etc/passwd", "0f3c2a1e-6b7d-0c8e-9f10-1a2b3c4d5e6f", "0f3c2a1e-6b7d-4c8e-7f10-1a2b3c4d5e6f", undefined])
      expect(reportEvent("plugin_feature_used", SESSION, 1, { pluginVersion: "1.8.2", installId, feature: "health", outcome: "opened" })).toHaveProperty("error")
  })

  test("an OS, feature or outcome outside its list is refused", () => {
    for (const os of ["darwin", "Linux", "", undefined, "macos; select 1"])
      expect(reportEvent("plugin_session_start", SESSION, 1, { pluginVersion: "1.8.2", installId: INSTALL, os })).toHaveProperty("error")
    for (const feature of ["fct_orders", "select * from t", "lineage-report", "", undefined])
      expect(reportEvent("plugin_feature_used", SESSION, 1, { pluginVersion: "1.8.2", installId: INSTALL, feature, outcome: "opened" })).toHaveProperty("error")
    for (const outcome of ["clicked", "", undefined, "opened /repo/models"])
      expect(reportEvent("plugin_feature_used", SESSION, 1, { pluginVersion: "1.8.2", installId: INSTALL, feature: "runs", outcome })).toHaveProperty("error")
  })
})

// The real CLI, its telemetry pointed at a local sink: what reaches Application Insights, and that the opt-out sends nothing.
describe("tool report-event through the CLI's telemetry", () => {
  const cliEntry = path.resolve(import.meta.dir, "../../../src/index.ts")
  let root: string
  let server: ReturnType<typeof Bun.serve>
  let received: any[] = []

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "report-event-"))
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/v2/track") {
          const body = await req.json().catch(() => [])
          received.push(...(Array.isArray(body) ? body : [body]))
        }
        return Response.json({ itemsReceived: 1, itemsAccepted: 1, errors: [] })
      },
    })
  })

  afterAll(async () => {
    server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  })

  async function run(args: string[], extra: Record<string, string> = {}) {
    const home = await fs.mkdtemp(path.join(root, "home-"))
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      OPENCODE_TEST_HOME: home,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=http://127.0.0.1:${server.port}/`,
      ...extra,
    }
    delete env.ALTIMATE_TELEMETRY_DISABLED
    delete env.OPENCODE_DISABLE_TELEMETRY
    Object.assign(env, extra)
    const proc = Bun.spawn(["bun", "run", "--conditions=browser", cliEntry, "tool", "report-event", ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" })
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    return { exitCode, stderr }
  }

  const plugin = () => received.filter((one) => String(one?.data?.baseData?.name ?? "").startsWith("plugin_"))

  test(
    "a session start and a feature used each send one event, with the allowed fields only",
    async () => {
      received = []
      const start = await run(["plugin_session_start", "--session", SESSION, "--plugin-version", "1.8.2", "--install-id", INSTALL, "--os", "macos"])
      expect(start.exitCode).toBe(0)
      const used = await run(["plugin_feature_used", "--session", SESSION, "--plugin-version", "1.8.2", "--install-id", INSTALL, "--feature", "cost_gate", "--outcome", "held"])
      expect(used.exitCode).toBe(0)
      const events = plugin()
      expect(events.map((one) => one.data.baseData.name)).toEqual(["plugin_session_start", "plugin_feature_used"])
      // The envelope's own keys, and the event's allow-listed fields: nothing else.
      const ENVELOPE = ["cli_version", "client", "source", "project_id", "machine_id", "launch_id"]
      const [startEvent, usedEvent] = events.map((one) => one.data.baseData.properties as Record<string, string>)
      expect(Object.keys(startEvent!).sort()).toEqual([...ENVELOPE, "plugin_version", "altimate_code_version", "os", "install_id"].sort())
      expect(Object.keys(usedEvent!).sort()).toEqual([...ENVELOPE, "plugin_version", "install_id", "feature", "outcome"].sort())
      expect(startEvent).toMatchObject({ plugin_version: "1.8.2", os: "macos", install_id: INSTALL, project_id: "" })
      expect(startEvent!.altimate_code_version).toBe(startEvent!.cli_version)
      expect(usedEvent).toMatchObject({ feature: "cost_gate", outcome: "held", install_id: INSTALL })
      for (const one of events) {
        expect(one.tags["ai.session.id"]).toBe(SESSION)
        expect(JSON.stringify(one)).not.toMatch(/report-event-/)
      }
    },
    60_000,
  )

  test(
    "with ALTIMATE_TELEMETRY_DISABLED, or telemetry off in the config, nothing is sent",
    async () => {
      received = []
      const args = ["plugin_feature_used", "--session", SESSION, "--plugin-version", "1.8.2", "--install-id", INSTALL, "--feature", "lineage", "--outcome", "opened"]
      expect((await run(args, { ALTIMATE_TELEMETRY_DISABLED: "true" })).exitCode).toBe(0)
      expect((await run(args, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ telemetry: { disabled: true } }) })).exitCode).toBe(0)
      expect(plugin()).toEqual([])
    },
    60_000,
  )

  test(
    "a value outside the allow-list, or a field the event does not take, sends nothing and says why",
    async () => {
      received = []
      const ok = ["plugin_feature_used", "--session", SESSION, "--plugin-version", "1.8.2", "--install-id", INSTALL]
      const bad = await run([...ok, "--feature", "fct_orders", "--outcome", "opened"])
      expect(bad.exitCode).toBe(1)
      expect(bad.stderr).toContain("--feature must be one of")
      const extra = await run([...ok, "--feature", "lineage", "--outcome", "opened", "--sql", "select secret from t"])
      expect(extra.exitCode).toBe(1)
      expect(plugin()).toEqual([])
      expect(JSON.stringify(received)).not.toContain("select secret")
    },
    60_000,
  )
})
