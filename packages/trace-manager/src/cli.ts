import type { Argv, CommandModule } from "yargs"

export const TraceManageCommand: CommandModule = {
  command: "trace-manage [action]",
  describe: "Trace Manager — PII review, publish, summarize, analytics dashboard",
  builder: (yargs: Argv) => {
    return yargs
      .positional("action", {
        describe: "action to perform",
        type: "string",
        choices: ["dashboard", "consent", "summarize", "publish", "analyze", "ingest"] as const,
        default: "dashboard",
      })
      .option("port", {
        type: "number",
        describe: "port for dashboard server",
        default: 3847,
      })
      .option("share", {
        type: "boolean",
        describe: "create ngrok tunnel for sharing the dashboard",
        default: false,
      })
      .option("id", {
        type: "string",
        describe: "session ID (for summarize/publish)",
      })
      .option("endpoint", {
        type: "string",
        describe: "HTTP endpoint URL (for publish)",
      })
      .option("yes", {
        alias: "y",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      })
  },
  handler: async (args: any) => {
    const action = args.action || "dashboard"

    if (action === "consent") {
      const { runSecurityGuide } = await import("./consent/security-guide")
      await runSecurityGuide({ interactive: true })
      return
    }

    if (action === "summarize") {
      const { loadAllTraces } = await import("./traces")
      const { summarizeTrace, printTraceSummary } = await import("./summarize/trace-summarizer")
      const traces = await loadAllTraces()
      const trace = args.id
        ? traces.find((t: any) => t.sessionId === args.id || t.sessionId.startsWith(args.id))
        : traces[0]
      if (!trace) {
        console.error("  No trace found" + (args.id ? ` for ${args.id}` : ""))
        process.exit(1)
      }
      printTraceSummary(summarizeTrace(trace))

      const { detectPIIInTrace } = await import("./pii/detector")
      const findings = detectPIIInTrace(trace)
      if (findings.length) {
        const { loadOrCreateConfig } = await import("./consent/consent-store")
        const cfg = await loadOrCreateConfig()
        console.log(`  PII detected: ${findings.length} item(s)`)
        for (const f of findings) {
          const act = cfg.consent.piiCategories[f.category] ?? "redact"
          console.log(`    • ${f.category} in ${f.field} → will be ${act}ed`)
        }
        console.log("")
      }
      return
    }

    if (action === "publish") {
      const { loadAllTraces } = await import("./traces")
      const { publishTrace, printPublishResult } = await import("./publish/publisher")
      const { loadOrCreateConfig } = await import("./consent/consent-store")
      const { detectPIIInTrace } = await import("./pii/detector")

      const traces = await loadAllTraces()
      const trace = args.id
        ? traces.find((t: any) => t.sessionId === args.id || t.sessionId.startsWith(args.id))
        : traces[0]
      if (!trace) {
        console.error("  No trace found")
        process.exit(1)
      }

      const cfg = await loadOrCreateConfig()
      const findings = detectPIIInTrace(trace)
      console.log(`\n  Publishing: "${trace.metadata.title ?? trace.sessionId}"`)
      if (findings.length) {
        console.log(`  PII: ${findings.length} item(s) will be handled per your consent config`)
      }

      const ep = args.endpoint
        ? { name: "custom", url: args.endpoint }
        : undefined
      const result = await publishTrace(trace, cfg, ep)
      printPublishResult(result)
      console.log("")
      return
    }

    if (action === "analyze") {
      const { loadAllTraces } = await import("./traces")
      const { summarizeTraces } = await import("./summarize/trace-summarizer")
      const traces = await loadAllTraces()
      const bulk = summarizeTraces(traces)
      console.log(`\n  Trace Analytics (${bulk.count} sessions)`)
      console.log("  " + "─".repeat(40))
      console.log(`  Success rate:   ${(bulk.successRate * 100).toFixed(0)}%`)
      console.log(`  Total tokens:   ${bulk.totalTokens.toLocaleString()}`)
      console.log(`  Total cost:     $${bulk.totalCost.toFixed(4)}`)
      console.log(`  Avg duration:   ${bulk.avgDuration < 60000 ? (bulk.avgDuration / 1000).toFixed(1) + "s" : Math.floor(bulk.avgDuration / 60000) + "m"}`)
      console.log(`  Avg tokens:     ${bulk.avgTokens.toLocaleString()}`)
      console.log("")
      return
    }

    if (action === "ingest") {
      const { loadOrCreateConfig } = await import("./consent/consent-store")
      const { LakeManager } = await import("./lake/lake-manager")
      const { loadAllTraces } = await import("./traces")
      const cfg = await loadOrCreateConfig()
      const lake = await LakeManager.create(cfg.lake.path)
      const traces = await loadAllTraces()
      console.log(`\n  Ingesting ${traces.length} traces into DuckDB...`)
      for (const t of traces) {
        await lake.ingest(t)
        process.stdout.write(".")
      }
      const count = await lake.getSessionCount()
      console.log(`\n  ✓ ${count} sessions in lake at ${cfg.lake.path}\n`)
      await lake.close()
      return
    }

    // Default: dashboard
    const { loadConfig } = await import("./consent/consent-store")
    const { runSecurityGuide } = await import("./consent/security-guide")
    const existing = await loadConfig()
    const config = existing ?? await runSecurityGuide({ interactive: process.stdin.isTTY !== false })

    let lake: import("./lake/lake-manager").LakeManager | undefined
    try {
      const { LakeManager } = await import("./lake/lake-manager")
      const { loadAllTraces } = await import("./traces")
      lake = await LakeManager.create(config.lake.path)
      const traces = await loadAllTraces()
      for (const t of traces) await lake.ingest(t)
    } catch {}

    const { createApp } = await import("./web/server")
    const app = await createApp({ lake })
    const server = Bun.serve({
      port: args.port || 3847,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    })

    const url = `http://localhost:${server.port}`
    console.log(`\n  Trace Manager Dashboard: ${url}`)

    if (args.share) {
      try {
        const { startNgrokTunnel } = await import("./web/ngrok")
        console.log("  Starting ngrok tunnel...")
        const publicUrl = await startNgrokTunnel(server.port ?? 3847)
        console.log(`  Public URL: ${publicUrl}`)
      } catch (e: any) {
        console.log(`  ngrok unavailable: ${e.message ?? e}`)
      }
    }

    console.log("  Press Ctrl+C to stop\n")

    try {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open"
      Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" })
    } catch {}

    const shutdown = async () => {
      if (lake) await lake.close().catch(() => {})
      try { server.stop() } catch {}
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
    await new Promise(() => {})
  },
}
