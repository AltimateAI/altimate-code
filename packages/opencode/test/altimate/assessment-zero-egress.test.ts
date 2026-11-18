// The packaged CLI, run the way the Claude Code plugin's /savings runs it, must not contact any host
// but the customer's warehouse. A logging proxy refuses every connection and records its target; the
// control run (assessment mode off) proves the proxy would have seen Altimate's telemetry endpoint.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
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
    if (value !== undefined && !/^(NODE_ENV|BUN_TEST|VITEST|JEST_WORKER_ID|ALTIMATE_TELEMETRY_.*|ALTIMATE_ASSESSMENT_MODE|OPENCODE_.*|APPLICATIONINSIGHTS_.*)$/.test(key)) base[key] = value
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
const savings = ["tool", "run", "finops_databricks_savings", "--args", "{}", "--json", "--no-daemon"]

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

  posixOnly("startup path (`tool list`): no host is contacted", async () => {
    const result = await run(["tool", "list"], assessment)
    expect(result.code).toBe(0)
    expect(result.hosts).toEqual([])
  }, 120_000)

  posixOnly("opt-out by project config: no host is contacted", async () => {
    const result = await run(savings, { ALTIMATE_ASSESSMENT_MODE: "true" }, async (_home, project) => {
      await writeFile(path.join(project, "altimate-code.json"), JSON.stringify({ telemetry: { disabled: true } }))
    })
    expect(result.hosts).toEqual([])
  }, 120_000)

  posixOnly("telemetry left on: no host is contacted either", async () => {
    const result = await run(savings, { ALTIMATE_ASSESSMENT_MODE: "true" })
    expect(result.hosts).toEqual([])
  }, 120_000)

  posixOnly("an unreachable warehouse still contacts no other host", async () => {
    const result = await run(savings, assessment, async (_home, project) => {
      const connections = path.join(project, "connections.json")
      await writeFile(
        connections,
        JSON.stringify({ dbx: { type: "databricks", server_hostname: "127.0.0.1", http_path: "/sql/1.0/warehouses/x", access_token: "unused" } }),
      )
    })
    expect(result.hosts.filter((host) => !host.startsWith("127.0.0.1"))).toEqual([])
  }, 120_000)

  posixOnly("the opt-out marker and machine id are untouched", async () => {
    const result = await run(savings, assessment)
    const altimate = await readdir(path.join(result.home, ".altimate"))
    expect(altimate.sort()).toEqual(["machine-id"])
    expect((await readFile(path.join(result.home, ".altimate", "machine-id"), "utf8")).trim()).toBe(MACHINE_ID)
  }, 120_000)
})
