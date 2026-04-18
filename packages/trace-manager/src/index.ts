import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadOrCreateConfig, loadConfig } from "./consent/consent-store"
import { loadAllTraces, loadTrace } from "./traces"
import { summarizeTrace, printTraceSummary } from "./summarize/trace-summarizer"
import { detectPIIInTrace } from "./pii/detector"
import { redactTrace } from "./pii/redactor"
import { publishTrace, printPublishResult } from "./publish/publisher"

export const TraceManagerPlugin: Plugin = async (ctx) => {
  const config = await loadOrCreateConfig()

  return {
    tool: {
      "trace-manage-summarize": tool({
        description:
          "Summarize a session trace — shows duration, tokens, cost, tool usage, narrative, and detected issues. " +
          "Call without arguments to summarize the most recent trace, or pass a session ID.",
        args: {
          sessionId: tool.schema
            .string()
            .optional()
            .describe("Session ID to summarize (defaults to most recent)"),
        },
        async execute(args) {
          const traces = await loadAllTraces()
          const trace = args.sessionId
            ? traces.find(
                (t) =>
                  t.sessionId === args.sessionId ||
                  t.sessionId.startsWith(args.sessionId!),
              )
            : traces[0]

          if (!trace) return "No trace found" + (args.sessionId ? ` for ID ${args.sessionId}` : "")

          const report = summarizeTrace(trace)
          return [
            `Session: "${report.title}"`,
            `Duration: ${report.duration} | Status: ${report.status}`,
            `Model: ${report.model} | Agent: ${report.agent}`,
            `Tokens: ${report.totalTokens.toLocaleString()} (in=${report.tokensBreakdown.input.toLocaleString()} out=${report.tokensBreakdown.output.toLocaleString()})`,
            `Cost: $${report.totalCost.toFixed(4)}`,
            `Tools: ${report.topTools.map((t) => `${t.name}(${t.count})`).join(" ") || "none"}`,
            `Generations: ${report.generations}`,
            report.loops.length
              ? `Loops: ${report.loops.map((l) => `${l.tool}(${l.count}x)`).join(", ")}`
              : null,
            "",
            report.narrative,
          ]
            .filter(Boolean)
            .join("\n")
        },
      }),

      "trace-manage-pii-review": tool({
        description:
          "Detect PII in a session trace — shows what sensitive data (emails, API keys, IPs, etc.) exists " +
          "and what redaction action will be applied before publishing.",
        args: {
          sessionId: tool.schema
            .string()
            .optional()
            .describe("Session ID to review (defaults to most recent)"),
        },
        async execute(args) {
          const traces = await loadAllTraces()
          const trace = args.sessionId
            ? traces.find(
                (t) =>
                  t.sessionId === args.sessionId ||
                  t.sessionId.startsWith(args.sessionId!),
              )
            : traces[0]

          if (!trace) return "No trace found"

          const findings = detectPIIInTrace(trace)
          if (!findings.length) return `No PII detected in "${trace.metadata.title ?? trace.sessionId}"`

          const cfg = await loadOrCreateConfig()
          const lines = [
            `PII Review: "${trace.metadata.title ?? trace.sessionId}"`,
            `Found ${findings.length} PII item(s):`,
            "",
          ]
          for (const f of findings) {
            const action = cfg.consent.piiCategories[f.category] ?? "redact"
            const preview = f.match.slice(0, 4) + "***" + f.match.slice(-2)
            lines.push(`  [${action.toUpperCase()}] ${f.category}: ${preview} (${f.field}${f.spanId ? ` span ${f.spanId.slice(0, 8)}` : ""})`)
          }
          return lines.join("\n")
        },
      }),

      "trace-manage-publish": tool({
        description:
          "Publish a session trace to a configured HTTP endpoint after PII redaction. " +
          "Uses the PII settings from your trace-manager consent configuration.",
        args: {
          sessionId: tool.schema
            .string()
            .optional()
            .describe("Session ID to publish (defaults to most recent)"),
          endpoint: tool.schema
            .string()
            .optional()
            .describe("Override publish endpoint URL"),
        },
        async execute(args) {
          const traces = await loadAllTraces()
          const trace = args.sessionId
            ? traces.find(
                (t) =>
                  t.sessionId === args.sessionId ||
                  t.sessionId.startsWith(args.sessionId!),
              )
            : traces[0]

          if (!trace) return "No trace found"

          const cfg = await loadOrCreateConfig()
          const ep = args.endpoint
            ? { name: "custom", url: args.endpoint }
            : undefined
          const result = await publishTrace(trace, cfg, ep)

          if (result.success) {
            return `✓ Published "${trace.metadata.title ?? trace.sessionId}" to ${result.endpoint}` +
              (result.url ? `\nURL: ${result.url}` : "") +
              `\nPII: ${result.piiRedacted} redacted, ${result.piiAllowed} allowed`
          }
          return `✗ Publish failed: ${result.error}`
        },
      }),

      "trace-manage-analyze": tool({
        description:
          "Analyze all session traces and show conversation analytics — success rates, " +
          "tool usage patterns, latency percentiles, and failure analysis.",
        args: {},
        async execute() {
          const traces = await loadAllTraces()
          if (!traces.length) return "No traces found"

          const completed = traces.filter((t) => t.summary.status === "completed").length
          const totalTokens = traces.reduce((s, t) => s + t.summary.totalTokens, 0)
          const totalCost = traces.reduce((s, t) => s + t.summary.totalCost, 0)
          const avgDur = traces.reduce((s, t) => s + t.summary.duration, 0) / traces.length

          const toolFreq: Record<string, number> = {}
          for (const t of traces)
            for (const tt of t.summary.topTools ?? [])
              toolFreq[tt.name] = (toolFreq[tt.name] ?? 0) + tt.count
          const topTools = Object.entries(toolFreq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)

          const fmtD = (ms: number) => ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`

          return [
            `Trace Analytics (${traces.length} sessions)`,
            `─────────────────────────────`,
            `Success rate: ${((completed / traces.length) * 100).toFixed(0)}% (${completed}/${traces.length})`,
            `Total tokens: ${totalTokens.toLocaleString()}`,
            `Total cost:   $${totalCost.toFixed(4)}`,
            `Avg duration: ${fmtD(avgDur)}`,
            "",
            "Top tools:",
            ...topTools.map(([name, count]) => `  ${name}: ${count} calls`),
          ].join("\n")
        },
      }),

      "trace-manage-dashboard": tool({
        description:
          "Launch the Trace Manager web dashboard on localhost for browsing traces, " +
          "reviewing PII, viewing knowledge graphs, and analyzing conversation/user analytics.",
        args: {
          port: tool.schema.number().optional().describe("Port (default 3847)"),
          share: tool.schema.boolean().optional().describe("Create ngrok tunnel for sharing"),
        },
        async execute(args) {
          const port = args.port ?? 3847
          const { createApp } = await import("./web/server")
          const app = await createApp()
          const server = Bun.serve({
            port,
            hostname: "127.0.0.1",
            fetch: app.fetch,
          })
          const url = `http://localhost:${server.port}`
          try {
            const openCmd = process.platform === "darwin" ? "open" : "xdg-open"
            Bun.spawn([openCmd, url], { stdout: "ignore", stderr: "ignore" })
          } catch {}
          return `Dashboard running at ${url}\nOpen in your browser to view traces, analytics, PII review, and knowledge graphs.`
        },
      }),
    },

    async event({ event }) {
      if (
        config.consent.autoIngest &&
        (event as any).type === "session.status" &&
        (event as any).properties?.status === "idle"
      ) {
        try {
          const { LakeManager } = await import("./lake/lake-manager")
          const lake = await LakeManager.create(config.lake.path)
          const traces = await loadAllTraces()
          if (traces[0]) await lake.ingest(traces[0])
          await lake.close()
        } catch {}
      }
    },
  }
}
