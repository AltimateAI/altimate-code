// The packaged CLI, run the way the Claude Code plugin's /savings runs it, must not contact any host
// but the customer's warehouse. A logging proxy refuses every connection and records its target; the
// control run (assessment mode off) proves the proxy would have seen Altimate's telemetry endpoint.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.join(import.meta.dir, "../..")
const snapshot = path.join(root, "src/provider/models-snapshot.ts")
const posixOnly = test.skipIf(process.platform === "win32")
// Stands in for Altimate's telemetry endpoint, so a send to it is attributable and cannot race the
// real one's availability.
const TELEMETRY_SINK = "altimate-telemetry.invalid"
const MACHINE_ID = "11111111-2222-4333-8444-555555555555"

let binary = ""
let originalSnapshot: string | undefined
let proxy: http.Server
let proxyPort = 0
let seen: string[] = []
const scratch: string[] = []

/** The ambient environment without anything that makes the CLI mistake this for a test run (which silences
 * its telemetry for its own reasons) or that redirects its settings. The build must not see it either:
 * the bundle can capture `NODE_ENV`. */
function cleanEnv(): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(NODE_ENV|BUN_TEST|VITEST|JEST_WORKER_ID|ALTIMATE_.*|OPENCODE_.*|APPLICATIONINSIGHTS_.*|XDG_.*|CLOUDSDK_CONFIG)$/.test(key)) base[key] = value
  }
  return base
}

async function packagedBinary(): Promise<string> {
  const given = process.env.ALTIMATE_PACKAGED_BIN
  if (given) return given
  // The build rewrites the tracked models snapshot; put it back afterwards.
  originalSnapshot = await readFile(snapshot, "utf8")
  const build = Bun.spawnSync([process.execPath, "run", "script/build.ts", "--single", "--skip-install"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv(),
  })
  if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`)
  const dist = path.join(root, "dist")
  for (const pkg of await readdir(path.join(dist, "@altimateai"))) {
    const bin = path.join(dist, "@altimateai", pkg, "bin", "altimate-code")
    if (await stat(bin).then(() => true, () => false)) return bin
  }
  throw new Error("no packaged binary was built")
}

beforeAll(async () => {
  if (process.platform === "win32") return
  binary = await packagedBinary()
  proxy = http.createServer((req, res) => {
    seen.push(new URL(req.url ?? "/", "http://x").host || String(req.headers.host))
    res.writeHead(502).end()
  })
  proxy.on("connect", (req, socket) => {
    seen.push(String(req.url))
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  proxyPort = (proxy.address() as AddressInfo).port
}, 120_000)

afterAll(async () => {
  proxy?.close()
  if (originalSnapshot !== undefined) await writeFile(snapshot, originalSnapshot)
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })))
})

type Run = { code: number; stdout: string; hosts: string[]; home: string }

/** Runs the packaged CLI in a fresh home that already holds a machine id (so an opt-out event could be sent). */
async function run(args: string[], env: Record<string, string>, setup?: (home: string, project: string) => Promise<void>): Promise<Run> {
  const home = await mkdtemp(path.join(tmpdir(), "assessment-egress-"))
  scratch.push(home)
  const project = path.join(home, "project")
  await mkdir(path.join(home, ".altimate"), { recursive: true })
  await mkdir(project, { recursive: true })
  await writeFile(path.join(home, ".altimate", "machine-id"), `${MACHINE_ID}\n`)
  await setup?.(home, project)
  seen = []
  const base = cleanEnv()
  const proc = Bun.spawn([binary, ...args], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 90_000,
    env: {
      ...base,
      HOME: home,
      // A PATH with nothing on it, so no ripgrep is found: without the downloader guards the CLI would fetch it from github.com.
      PATH: path.join(home, "empty-bin"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      ALTIMATE_TOOL_DAEMON: "0",
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: "",
      APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://${TELEMETRY_SINK}/`,
      ...env,
    },
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, stdout, hosts: [...new Set(seen)].sort(), home }
}

const assessment = { ALTIMATE_ASSESSMENT_MODE: "true", ALTIMATE_TELEMETRY_DISABLED: "true" }
const savings = ["tool", "run", "finops_databricks_savings", "--args", '{"confirm":true}', "--json", "--no-daemon"]

describe("assessment mode on the packaged CLI", () => {
  posixOnly("control: without assessment mode, telemetry off still sends the opt-out event to the telemetry endpoint", async () => {
    const result = await run(savings, { ALTIMATE_TELEMETRY_DISABLED: "true" })
    expect(result.hosts.some((host) => host.startsWith(TELEMETRY_SINK))).toBe(true)
  }, 120_000)

  posixOnly("failure path (no warehouse configured): no host is contacted and the run reports the failure", async () => {
    const result = await run(savings, assessment)
    expect(result.hosts).toEqual([])
    expect(JSON.parse(result.stdout).status).toBe("error")
  }, 120_000)

  posixOnly("without the user's go-ahead the check does not run and no host is contacted", async () => {
    const unconfirmed = ["tool", "run", "finops_databricks_savings", "--args", "{}", "--json", "--no-daemon"]
    const result = await run(unconfirmed, assessment)
    expect(result.hosts).toEqual([])
    expect(JSON.parse(result.stdout).output).toContain("call this tool again with confirm: true")
  }, 120_000)

  posixOnly("the Snowflake check: unconfirmed, with no warehouse, and with an unreachable one, no other host is contacted", async () => {
    const snowflake = (args: string) => ["tool", "run", "finops_snowflake_savings", "--args", args, "--json", "--no-daemon"]
    const unconfirmed = await run(snowflake("{}"), assessment)
    expect(unconfirmed.hosts).toEqual([])
    expect(JSON.parse(unconfirmed.stdout).output).toContain("call this tool again with confirm: true")

    const noWarehouse = await run(snowflake('{"confirm":true}'), assessment)
    expect(noWarehouse.hosts).toEqual([])
    expect(JSON.parse(noWarehouse.stdout).status).toBe("error")

    const account = "egress-test.invalid"
    const unreachable = await run(snowflake('{"confirm":true}'), assessment, async (_home, project) => {
      await mkdir(path.join(project, ".altimate-code"), { recursive: true })
      await writeFile(
        path.join(project, ".altimate-code", "connections.json"),
        JSON.stringify({ sf: { type: "snowflake", account, user: "u", password: "unused", warehouse: "W" } }),
      )
    })
    expect(unreachable.hosts.filter((host) => !host.includes(account))).toEqual([])
    expect(JSON.parse(unreachable.stdout).output).not.toContain("none are set up")
  }, 360_000)

  posixOnly("with the Snowflake driver installed, assessment mode keeps it off the cloud metadata services", async () => {
    const account = "egress-test"
    const args = ["tool", "run", "finops_snowflake_savings", "--args", '{"confirm":true}', "--json", "--no-daemon"]
    // The driver the packaged CLI would install, linked in with its dependencies.
    const sdk = createRequire(path.join(root, "../drivers/package.json")).resolve("snowflake-sdk/package.json")
    const dependencies = path.dirname(path.dirname(await realpath(sdk)))
    const setup = async (home: string, project: string) => {
      const drivers = path.join(home, ".local/share/altimate-code/drivers")
      await mkdir(drivers, { recursive: true })
      await writeFile(path.join(drivers, "package.json"), JSON.stringify({ name: "drivers", private: true, dependencies: { "snowflake-sdk": "*" } }))
      await symlink(dependencies, path.join(drivers, "node_modules"))
      await mkdir(path.join(project, ".altimate-code"), { recursive: true })
      await writeFile(
        path.join(project, ".altimate-code", "connections.json"),
        JSON.stringify({ sf: { type: "snowflake", account, user: "u", password: "unused", warehouse: "W" } }),
      )
    }
    const metadata = (hosts: string[]) => hosts.filter((host) => /169\.254\.169\.254|metadata\.google\.internal|sts\.|login\.microsoftonline/.test(host))

    // Control: without the mode the SDK does probe, so the proxy would see it.
    const control = await run(args, { ALTIMATE_TELEMETRY_DISABLED: "true" }, setup)
    expect(metadata(control.hosts).length).toBeGreaterThan(0)

    const result = await run(args, assessment, setup)
    expect(result.hosts.some((host) => host.includes(account))).toBe(true)
    expect(result.hosts.filter((host) => !host.includes(account))).toEqual([])
  }, 360_000)

  posixOnly("startup path (`tool list`): no host is contacted", async () => {
    const result = await run(["tool", "list"], assessment)
    expect(result.code).toBe(0)
    expect(result.hosts).toEqual([])
  }, 120_000)

  posixOnly("telemetry left on: no host is contacted either", async () => {
    const result = await run(savings, { ALTIMATE_ASSESSMENT_MODE: "true" })
    expect(result.hosts).toEqual([])
  }, 120_000)

  posixOnly("an unreachable warehouse still contacts no other host", async () => {
    const result = await run(savings, assessment, async (_home, project) => {
      await mkdir(path.join(project, ".altimate-code"), { recursive: true })
      await writeFile(
        path.join(project, ".altimate-code", "connections.json"),
        JSON.stringify({ dbx: { type: "databricks", server_hostname: "127.0.0.1", http_path: "/sql/1.0/warehouses/x", access_token: "unused" } }),
      )
    })
    expect(result.hosts.filter((host) => !host.startsWith("127.0.0.1"))).toEqual([])
    // The failure comes from the connection attempt, not from a missing warehouse.
    const output = JSON.parse(result.stdout).output as string
    expect(output).not.toContain("none are set up")
  }, 120_000)

  posixOnly("signed in to Altimate: no host is contacted", async () => {
    // The ambient PATH: with a bare one the project-binding lookup is never reached, so the case would prove nothing.
    const result = await run(savings, { ...assessment, PATH: process.env.PATH ?? "" }, async (home) => {
      await writeFile(
        path.join(home, ".altimate", "altimate.json"),
        JSON.stringify({ altimateUrl: `https://${TELEMETRY_SINK}`, altimateInstanceName: "acme", altimateApiKey: "x" }),
      )
    })
    expect(result.hosts).toEqual([])
  }, 120_000)

  posixOnly("a well-known remote config entry and project plugin sources: no host is contacted", async () => {
    const result = await run(savings, assessment, async (home, project) => {
      const data = path.join(home, ".local/share/altimate-code")
      await mkdir(data, { recursive: true })
      await writeFile(path.join(data, "auth.json"), JSON.stringify({ "https://org-config.invalid": { type: "wellknown", key: "K", token: "T" } }))
      await mkdir(path.join(project, ".opencode", "plugin"), { recursive: true })
      await writeFile(path.join(project, ".opencode", "plugin", "x.ts"), "export default async () => ({})\n")
    })
    expect(result.hosts).toEqual([])
  }, 120_000)

  posixOnly("any non-empty value turns the mode on (`yes` must not fail open)", async () => {
    const result = await run(savings, { ALTIMATE_ASSESSMENT_MODE: "yes", ALTIMATE_TELEMETRY_DISABLED: "true" })
    expect(result.hosts).toEqual([])
  }, 120_000)

  posixOnly("a tool daemon started without the mode does not serve a run that sets it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "assessment-daemon-"))
    scratch.push(dir)
    const { connectionEnvKey } = await import("../../src/altimate/tool-cli/daemon")
    expect(connectionEnvKey({ ALTIMATE_ASSESSMENT_MODE: "true" })).not.toBe(connectionEnvKey({}))
  })

  posixOnly("altimate-core's own usage event stays off too: a core-backed tool starts no core telemetry", async () => {
    // Core writes ~/.altimate/machine-id when its telemetry worker starts, and its client does not
    // go through the proxy above, so the machine id is what shows it. Telemetry is left on here:
    // assessment mode alone has to switch core off.
    const result = await run(
      ["tool", "run", "sql_analyze", "--args", JSON.stringify({ sql: "select a from t where b = 1", dialect: "snowflake" }), "--json", "--no-daemon"],
      { ALTIMATE_ASSESSMENT_MODE: "true" },
      (home) => rm(path.join(home, ".altimate", "machine-id")),
    )
    expect(JSON.parse(result.stdout).status).toBe("ok")
    expect(await readdir(path.join(result.home, ".altimate"))).toEqual([])
    expect(result.hosts).toEqual([])
  }, 120_000)

  posixOnly("the opt-out marker and machine id are untouched", async () => {
    const result = await run(savings, assessment)
    const altimate = await readdir(path.join(result.home, ".altimate"))
    expect(altimate.sort()).toEqual(["machine-id"])
    expect((await readFile(path.join(result.home, ".altimate", "machine-id"), "utf8")).trim()).toBe(MACHINE_ID)
  }, 120_000)

  posixOnly("the core ripgrep downloader refuses, and contacts no host", async () => {
    const result = await probe("fixtures/assessment-rg-probe.ts", { ALTIMATE_ASSESSMENT_MODE: "true" })
    expect(result.hosts).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false })
  }, 60_000)

  posixOnly("the sign-in context carries no machine id and an explicit catalog refresh contacts no host", async () => {
    const on = await probe("fixtures/assessment-misc-probe.ts", { ALTIMATE_ASSESSMENT_MODE: "true" })
    expect(on.hosts).toEqual([])
    expect(JSON.parse(on.stdout)).toEqual({ hasMachineId: false })
    // Control: the same probe without the mode does mint a machine id and reach the catalog host.
    const off = await probe("fixtures/assessment-misc-probe.ts", {})
    expect(JSON.parse(off.stdout)).toEqual({ hasMachineId: true })
    expect(off.hosts.some((host) => host.startsWith("models.dev"))).toBe(true)
  }, 90_000)

  posixOnly.each(["true", "1", "yes", "on"])("assessment mode `%s` turns every switch on, and off values leave them off", async (value) => {
    const on = JSON.parse((await probe("fixtures/assessment-flags-probe.ts", { ALTIMATE_ASSESSMENT_MODE: value })).stdout)
    expect(on).toEqual({ coreMode: true, coreModelsOff: true, coreWorkspaceOff: true, mode: true, modelsOff: true })
  }, 60_000)

  posixOnly.each(["", "0", "false"])("assessment mode `%s` leaves the switches off", async (value) => {
    const off = JSON.parse((await probe("fixtures/assessment-flags-probe.ts", { ALTIMATE_ASSESSMENT_MODE: value })).stdout)
    expect(off).toEqual({ coreMode: false, coreModelsOff: false, coreWorkspaceOff: false, mode: false, modelsOff: false })
  }, 60_000)
})

/** Runs a fixture script in a fresh home with the mode's environment, behind the logging proxy. */
async function probe(fixture: string, env: Record<string, string>) {
  const home = await mkdtemp(path.join(tmpdir(), "assessment-probe-"))
  scratch.push(home)
  seen = []
  const proc = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, fixture)], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 60_000,
    env: {
      PATH: path.join(home, "empty-bin"),
      HOME: home,
      XDG_DATA_HOME: path.join(home, "d"),
      XDG_CACHE_HOME: path.join(home, "c"),
      XDG_STATE_HOME: path.join(home, "s"),
      XDG_CONFIG_HOME: path.join(home, "cf"),
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      ...env,
    },
  })
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { stdout: stdout.trim().split("\n").pop() ?? "", hosts: [...new Set(seen)].sort() }
}
