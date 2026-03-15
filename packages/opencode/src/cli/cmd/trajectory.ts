import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Session } from "../../session"
import { SessionID } from "../../session/schema"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Locale } from "../../util/locale"
import { EOL } from "os"
import type { MessageV2 } from "../../session/message-v2"

export const TrajectoryCommand = cmd({
  command: "trajectory",
  describe: "inspect agent execution trajectories",
  builder: (yargs: Argv) =>
    yargs
      .command(TrajectoryListCommand)
      .command(TrajectoryShowCommand)
      .command(TrajectoryExportCommand)
      .demandCommand(),
  async handler() {},
})

const TrajectoryListCommand = cmd({
  command: "list",
  describe: "list recent sessions with trajectory stats",
  builder: (yargs: Argv) => {
    return yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
        default: 20,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessions = [...Session.list({ roots: true, limit: args.maxCount })]

      if (sessions.length === 0) {
        console.log("No sessions found.")
        return
      }

      const summaries = await Promise.all(sessions.map((s) => buildSessionSummary(s)))

      if (args.format === "json") {
        console.log(JSON.stringify(summaries, null, 2))
      } else {
        printTrajectoryTable(summaries)
      }
    })
  },
})

const TrajectoryShowCommand = cmd({
  command: "show <sessionID>",
  describe: "show detailed trajectory for a session",
  builder: (yargs: Argv) => {
    return yargs
      .positional("sessionID", {
        describe: "session ID to inspect",
        type: "string",
        demandOption: true,
      })
      .option("verbose", {
        alias: "v",
        describe: "show full tool call inputs/outputs",
        type: "boolean",
        default: false,
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sid = SessionID.make(args.sessionID)
      let session: Session.Info
      try {
        session = await Session.get(sid)
      } catch {
        UI.error(`Session not found: ${args.sessionID}`)
        process.exit(1)
      }

      const messages = await Session.messages({ sessionID: sid })
      printTrajectoryDetail(session, messages, args.verbose)
    })
  },
})

const TrajectoryExportCommand = cmd({
  command: "export <sessionID>",
  describe: "export session trajectory as structured JSON",
  builder: (yargs: Argv) => {
    return yargs.positional("sessionID", {
      describe: "session ID to export",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sid = SessionID.make(args.sessionID)
      let session: Session.Info
      try {
        session = await Session.get(sid)
      } catch {
        UI.error(`Session not found: ${args.sessionID}`)
        process.exit(1)
      }

      const messages = await Session.messages({ sessionID: sid })
      const trajectory = buildTrajectoryExport(session, messages)
      process.stdout.write(JSON.stringify(trajectory, null, 2))
      process.stdout.write(EOL)
    })
  },
})

// --- Helpers ---

interface SessionSummary {
  id: string
  title: string
  agent: string
  model: string
  duration_ms: number
  cost: number
  tool_calls: number
  generations: number
  outcome: "completed" | "error" | "in-progress"
  updated: number
}

async function buildSessionSummary(session: Session.Info): Promise<SessionSummary> {
  const messages = await Session.messages({ sessionID: session.id })

  let agent = ""
  let model = ""
  let cost = 0
  let toolCalls = 0
  let generations = 0
  let hadError = false
  let startTime = session.time.created
  let endTime = session.time.updated

  for (const msg of messages) {
    if (msg.info.role === "user" && !agent) {
      const userMsg = msg.info as MessageV2.User
      agent = userMsg.agent ?? ""
      if (userMsg.model) model = `${userMsg.model.providerID}/${userMsg.model.modelID}`
    }
    if (msg.info.role === "assistant") {
      const assistantMsg = msg.info as MessageV2.Assistant
      cost += assistantMsg.cost || 0
      generations++
      if (assistantMsg.error) hadError = true
    }
    for (const part of msg.parts) {
      if (part.type === "tool") toolCalls++
    }
  }

  return {
    id: session.id,
    title: session.title,
    agent,
    model,
    duration_ms: endTime - startTime,
    cost,
    tool_calls: toolCalls,
    generations,
    outcome: hadError ? "error" : "completed",
    updated: session.time.updated,
  }
}

function printTrajectoryTable(summaries: SessionSummary[]) {
  const idW = 12
  const titleW = 30
  const agentW = 10
  const costW = 8
  const toolsW = 6
  const gensW = 5
  const durW = 10
  const outcomeW = 10

  const header = [
    "ID".padEnd(idW),
    "Title".padEnd(titleW),
    "Agent".padEnd(agentW),
    "Cost".padStart(costW),
    "Tools".padStart(toolsW),
    "Gens".padStart(gensW),
    "Duration".padStart(durW),
    "Status".padEnd(outcomeW),
  ].join("  ")

  console.log(header)
  console.log("-".repeat(header.length))

  for (const s of summaries) {
    const line = [
      s.id.slice(-idW).padEnd(idW),
      Locale.truncate(s.title, titleW).padEnd(titleW),
      (s.agent || "-").slice(0, agentW).padEnd(agentW),
      `$${s.cost.toFixed(2)}`.padStart(costW),
      String(s.tool_calls).padStart(toolsW),
      String(s.generations).padStart(gensW),
      formatDuration(s.duration_ms).padStart(durW),
      s.outcome.padEnd(outcomeW),
    ].join("  ")
    console.log(line)
  }
}

function printTrajectoryDetail(
  session: Session.Info,
  messages: MessageV2.WithParts[],
  verbose: boolean,
) {
  console.log(`Session: ${session.id}`)
  console.log(`Title:   ${session.title}`)
  console.log(`Created: ${new Date(session.time.created).toISOString()}`)
  console.log(`Updated: ${new Date(session.time.updated).toISOString()}`)
  console.log("")

  let stepIndex = 0
  let totalCost = 0
  let totalToolCalls = 0

  for (const msg of messages) {
    if (msg.info.role === "user") {
      const userMsg = msg.info as MessageV2.User
      const textParts = msg.parts.filter(
        (p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic,
      )
      if (textParts.length > 0) {
        console.log(`--- User (agent: ${userMsg.agent || "unknown"}) ---`)
        for (const p of textParts) {
          const text = verbose ? p.text : Locale.truncate(p.text, 200)
          console.log(`  ${text}`)
        }
        console.log("")
      }
    }

    if (msg.info.role === "assistant") {
      stepIndex++
      const assistantMsg = msg.info as MessageV2.Assistant
      totalCost += assistantMsg.cost || 0

      const tokens = assistantMsg.tokens
      const tokenStr = tokens
        ? `in:${tokens.input} out:${tokens.output} cache_r:${tokens.cache?.read || 0} cache_w:${tokens.cache?.write || 0}`
        : "n/a"

      console.log(
        `--- Step ${stepIndex} (model: ${assistantMsg.modelID}, cost: $${(assistantMsg.cost || 0).toFixed(4)}, tokens: ${tokenStr}) ---`,
      )

      if (assistantMsg.summary) {
        console.log("  [COMPACTION SUMMARY]")
      }

      // Show text parts
      const textParts = msg.parts.filter((p): p is MessageV2.TextPart => p.type === "text")
      for (const p of textParts) {
        const text = verbose ? p.text : Locale.truncate(p.text, 300)
        console.log(`  ${text}`)
      }

      // Show tool calls
      const toolParts = msg.parts.filter((p): p is MessageV2.ToolPart => p.type === "tool")
      for (const tool of toolParts) {
        totalToolCalls++
        const status = tool.state.status
        const duration =
          tool.state.status === "completed" || tool.state.status === "error"
            ? tool.state.time.end - tool.state.time.start
            : 0

        console.log(`  [TOOL] ${tool.tool} (${status}, ${formatDuration(duration)})`)

        if (verbose) {
          const input =
            tool.state.status === "completed" ||
            tool.state.status === "running" ||
            tool.state.status === "error"
              ? tool.state.input
              : null
          if (input) {
            console.log(`    Input: ${JSON.stringify(input, null, 2).split("\n").join("\n    ")}`)
          }
          if (tool.state.status === "completed" && tool.state.output) {
            const output = Locale.truncate(tool.state.output, 500)
            console.log(`    Output: ${output}`)
          }
          if (tool.state.status === "error" && tool.state.error) {
            console.log(`    Error: ${tool.state.error}`)
          }
        }
      }

      if (assistantMsg.error) {
        console.log(`  [ERROR] ${JSON.stringify(assistantMsg.error)}`)
      }

      console.log("")
    }
  }

  console.log("=".repeat(60))
  console.log(`Total steps: ${stepIndex}`)
  console.log(`Total tool calls: ${totalToolCalls}`)
  console.log(`Total cost: $${totalCost.toFixed(4)}`)
  console.log(`Duration: ${formatDuration(session.time.updated - session.time.created)}`)
}

interface TrajectoryExport {
  version: "1.0"
  session: {
    id: string
    title: string
    agent: string
    model: { id: string; provider: string }
    started_at: number
    ended_at: number
    duration_ms: number
    total_cost: number
    total_tokens: {
      input: number
      output: number
      reasoning: number
      cache_read: number
      cache_write: number
    }
  }
  steps: Array<{
    index: number
    generation: {
      model_id: string
      provider_id: string
      finish_reason: string | undefined
      tokens: {
        input: number
        output: number
        reasoning: number
        cache_read: number
        cache_write: number
      }
      cost: number
    }
    text: string | undefined
    tool_calls: Array<{
      name: string
      input: unknown
      output: string | undefined
      status: string
      error: string | undefined
      duration_ms: number
    }>
    is_summary: boolean
  }>
  errors: Array<{
    step: number
    error: unknown
  }>
}

function buildTrajectoryExport(
  session: Session.Info,
  messages: MessageV2.WithParts[],
): TrajectoryExport {
  let agent = ""
  let model = { id: "", provider: "" }
  let totalCost = 0
  const totalTokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }
  const steps: TrajectoryExport["steps"] = []
  const errors: TrajectoryExport["errors"] = []

  let stepIndex = 0

  for (const msg of messages) {
    if (msg.info.role === "user" && !agent) {
      const userMsg = msg.info as MessageV2.User
      agent = userMsg.agent ?? ""
      if (userMsg.model) {
        model = { id: userMsg.model.modelID, provider: userMsg.model.providerID }
      }
    }

    if (msg.info.role === "assistant") {
      stepIndex++
      const a = msg.info as MessageV2.Assistant
      totalCost += a.cost || 0

      if (a.tokens) {
        totalTokens.input += a.tokens.input || 0
        totalTokens.output += a.tokens.output || 0
        totalTokens.reasoning += a.tokens.reasoning || 0
        totalTokens.cache_read += a.tokens.cache?.read || 0
        totalTokens.cache_write += a.tokens.cache?.write || 0
      }

      const textParts = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text")
        .map((p) => p.text)
        .join("\n")

      const toolCalls = msg.parts
        .filter((p): p is MessageV2.ToolPart => p.type === "tool")
        .map((tool) => ({
          name: tool.tool,
          input:
            tool.state.status === "completed" ||
            tool.state.status === "running" ||
            tool.state.status === "error"
              ? tool.state.input
              : null,
          output: tool.state.status === "completed" ? tool.state.output : undefined,
          status: tool.state.status,
          error: tool.state.status === "error" ? tool.state.error : undefined,
          duration_ms:
            tool.state.status === "completed" || tool.state.status === "error"
              ? tool.state.time.end - tool.state.time.start
              : 0,
        }))

      steps.push({
        index: stepIndex,
        generation: {
          model_id: a.modelID,
          provider_id: a.providerID,
          finish_reason: a.finish,
          tokens: {
            input: a.tokens?.input || 0,
            output: a.tokens?.output || 0,
            reasoning: a.tokens?.reasoning || 0,
            cache_read: a.tokens?.cache?.read || 0,
            cache_write: a.tokens?.cache?.write || 0,
          },
          cost: a.cost || 0,
        },
        text: textParts || undefined,
        tool_calls: toolCalls,
        is_summary: a.summary ?? false,
      })

      if (a.error) {
        errors.push({ step: stepIndex, error: a.error })
      }
    }
  }

  return {
    version: "1.0",
    session: {
      id: session.id,
      title: session.title,
      agent,
      model,
      started_at: session.time.created,
      ended_at: session.time.updated,
      duration_ms: session.time.updated - session.time.created,
      total_cost: totalCost,
      total_tokens: totalTokens,
    },
    steps,
    errors,
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}
