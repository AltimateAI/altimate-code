import { createApp } from "./web/server"
import { loadConfig } from "./consent/consent-store"
import { runSecurityGuide } from "./consent/security-guide"
import { getTracesDir } from "./traces"
import { startNgrokTunnel } from "./web/ngrok"
import { LakeManager } from "./lake/lake-manager"
import { loadAllTraces } from "./traces"

const args = process.argv.slice(2)
const command = args[0]

if (command === "consent") {
  await runSecurityGuide({ interactive: true })
  process.exit(0)
}

if (command === "ingest") {
  const config = await ensureConsent()
  const lake = await LakeManager.create(config.lake.path)
  const traces = await loadAllTraces()
  console.log(`\n  Ingesting ${traces.length} traces into DuckDB...`)
  for (const t of traces) {
    await lake.ingest(t)
    process.stdout.write(".")
  }
  const count = await lake.getSessionCount()
  console.log(`\n  ✓ ${count} sessions in lake at ${config.lake.path}\n`)
  await lake.close()
  process.exit(0)
}

if (command === "summarize") {
  const { summarizeTrace, printTraceSummary } = await import("./summarize/trace-summarizer")
  const traces = await loadAllTraces()
  const id = args[1]
  if (id) {
    const trace = traces.find((t) => t.sessionId === id || t.sessionId.startsWith(id))
    if (!trace) { console.error(`  Trace not found: ${id}`); process.exit(1) }
    printTraceSummary(summarizeTrace(trace))
  } else {
    if (!traces.length) { console.log("  No traces found."); process.exit(0) }
    printTraceSummary(summarizeTrace(traces[0]))
  }
  process.exit(0)
}

// Default: start dashboard
const config = await ensureConsent()
const share = args.includes("--share")
const portArg = args.find((a) => a.startsWith("--port="))
const port = portArg ? parseInt(portArg.split("=")[1]) : parseInt(process.env.PORT ?? "3847")

let lake: LakeManager | undefined
try {
  lake = await LakeManager.create(config.lake.path)
  const traces = await loadAllTraces()
  console.log(`\n  Auto-ingesting ${traces.length} traces...`)
  for (const t of traces) await lake.ingest(t)
  console.log(`  ✓ ${await lake.getSessionCount()} sessions in DuckDB`)
} catch (e) {
  console.log(`  Note: DuckDB lake unavailable (${e instanceof Error ? e.message : e})`)
  console.log("  Dashboard will use in-memory analytics.\n")
}

const app = await createApp({ lake })
const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch })

console.log(`\n  Trace Manager Dashboard: http://localhost:${server.port}`)
console.log(`  Reading traces from: ${getTracesDir()}`)

if (share) {
  try {
    console.log("  Starting ngrok tunnel...")
    const url = await startNgrokTunnel(server.port ?? port)
    console.log(`  Public URL: ${url}`)
  } catch (e) {
    console.log(`  ngrok unavailable: ${e instanceof Error ? e.message : e}`)
    console.log("  Install ngrok or @ngrok/ngrok for sharing.")
  }
}

console.log("  Press Ctrl+C to stop\n")

try { const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"; Bun.spawn([openCmd, `http://localhost:${server.port}`], { stdout: "ignore", stderr: "ignore" }) } catch {}

const shutdown = async () => { if (lake) await lake.close().catch(() => {}); try { server.stop() } catch {} process.exit(0) }
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
await new Promise(() => {})

async function ensureConsent() {
  const existing = await loadConfig()
  if (existing) return existing
  return runSecurityGuide({ interactive: process.stdin.isTTY !== false })
}
