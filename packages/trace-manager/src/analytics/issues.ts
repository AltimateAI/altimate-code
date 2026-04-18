import type { TraceFile } from "../types"

export type IssueSeverity = "critical" | "high" | "medium" | "low"
export type IssueTopic =
  | "tool_failure" | "doom_loop" | "timeout" | "token_waste"
  | "permission_denied" | "model_error" | "long_session"
  | "empty_response" | "repeated_edit" | "crash"

export interface DetectedIssue {
  id: string
  topic: IssueTopic
  severity: IssueSeverity
  title: string
  description: string
  pattern: string
  occurrences: Array<{
    sessionId: string
    sessionTitle: string
    userId: string
    timestamp: string
    spanId?: string
    detail: string
  }>
  frequency: number
  firstSeen: string
  lastSeen: string
  affectedUsers: string[]
  suggestedFix: string
}

const TOPIC_LABELS: Record<IssueTopic, string> = {
  tool_failure: "Tool Failure",
  doom_loop: "Doom Loop",
  timeout: "Timeout",
  token_waste: "Token Waste",
  permission_denied: "Permission Denied",
  model_error: "Model Error",
  long_session: "Long Session",
  empty_response: "Empty Response",
  repeated_edit: "Repeated Edit",
  crash: "Crash",
}

const TOPIC_SEVERITY_BASE: Record<IssueTopic, IssueSeverity> = {
  crash: "critical",
  doom_loop: "critical",
  model_error: "high",
  tool_failure: "high",
  permission_denied: "medium",
  timeout: "medium",
  token_waste: "medium",
  empty_response: "low",
  long_session: "low",
  repeated_edit: "low",
}

export function detectIssues(traces: TraceFile[]): DetectedIssue[] {
  const issueMap = new Map<string, DetectedIssue>()
  let idSeq = 0

  function addOccurrence(
    patternKey: string,
    topic: IssueTopic,
    title: string,
    description: string,
    suggestedFix: string,
    trace: TraceFile,
    detail: string,
    spanId?: string,
  ) {
    const userId = trace.metadata.userId ?? trace.metadata.agent ?? trace.metadata.providerId ?? "unknown"
    const occurrence = {
      sessionId: trace.sessionId,
      sessionTitle: trace.metadata.title ?? trace.sessionId,
      userId,
      timestamp: trace.startedAt,
      spanId,
      detail,
    }

    const existing = issueMap.get(patternKey)
    if (existing) {
      existing.occurrences.push(occurrence)
      existing.frequency++
      if (trace.startedAt < existing.firstSeen) existing.firstSeen = trace.startedAt
      if (trace.startedAt > existing.lastSeen) existing.lastSeen = trace.startedAt
      if (!existing.affectedUsers.includes(userId)) existing.affectedUsers.push(userId)
      existing.severity = escalateSeverity(existing.severity, existing.frequency)
    } else {
      issueMap.set(patternKey, {
        id: `issue-${++idSeq}`,
        topic,
        severity: TOPIC_SEVERITY_BASE[topic],
        title,
        description,
        pattern: patternKey,
        occurrences: [occurrence],
        frequency: 1,
        firstSeen: trace.startedAt,
        lastSeen: trace.startedAt,
        affectedUsers: [userId],
        suggestedFix,
      })
    }
  }

  for (const trace of traces) {
    // Crashes
    if (trace.summary.status === "crashed") {
      addOccurrence(
        "crash:session",
        "crash",
        "Session crashed",
        "The agent session terminated abnormally without completing.",
        "Check logs for unhandled exceptions. Ensure MCP servers are stable and responsive.",
        trace,
        trace.summary.error ?? "Abnormal termination",
      )
    }

    // Doom loops
    for (const loop of trace.summary.loops ?? []) {
      addOccurrence(
        `doom_loop:${loop.tool}`,
        "doom_loop",
        `Doom loop on "${loop.tool}"`,
        `The agent called "${loop.tool}" ${loop.count}+ times with the same input, unable to make progress.`,
        `Add tool-specific error handling. If "${loop.tool}" fails repeatedly, the agent should try an alternative approach or ask the user.`,
        trace,
        `${loop.tool} repeated ${loop.count} times: ${loop.description ?? ""}`,
      )
    }

    // Tool failures
    const failedTools: Record<string, number> = {}
    for (const span of trace.spans) {
      if (span.kind === "tool" && span.status === "error") {
        failedTools[span.name] = (failedTools[span.name] ?? 0) + 1

        const rawOut = typeof span.output === "string" ? span.output : span.output ? JSON.stringify(span.output) : ""
        const errorPreview = rawOut.slice(0, 200)
        addOccurrence(
          `tool_failure:${span.name}`,
          "tool_failure",
          `"${span.name}" tool failures`,
          `The "${span.name}" tool is failing during execution. Each failure wastes a generation round-trip.`,
          `Review common error patterns for "${span.name}". For bash: check exit codes. For edit: verify file paths exist. For read: check permissions.`,
          trace,
          errorPreview || `${span.name} returned error status`,
          span.spanId,
        )
      }
    }

    // Empty/minimal generation responses
    for (const span of trace.spans) {
      if (span.kind === "generation" && span.tokens) {
        const outputTokens = span.tokens.output ?? 0
        const inputTokens = span.tokens.input ?? 0
        if (inputTokens > 10000 && outputTokens < 10) {
          addOccurrence(
            "empty_response:generation",
            "empty_response",
            "Model returned near-empty response to large context",
            "The model received substantial context but produced almost no output, suggesting confusion or context overflow.",
            "Reduce context size. Use targeted file reads instead of full file dumps. Check if the prompt is clear.",
            trace,
            `${inputTokens.toLocaleString()} input tokens → ${outputTokens} output tokens`,
            span.spanId,
          )
        }
      }
    }

    // Token waste (>100K tokens, <5 tool calls)
    if (trace.summary.totalTokens > 100_000 && trace.summary.totalToolCalls < 5) {
      addOccurrence(
        "token_waste:high_tokens_low_action",
        "token_waste",
        "High token usage with minimal tool activity",
        "Sessions consuming >100K tokens with fewer than 5 tool calls suggest the model is reasoning extensively without acting.",
        "Encourage the agent to act earlier. Use prompts that emphasize 'do, then verify' over 'plan extensively, then do'.",
        trace,
        `${trace.summary.totalTokens.toLocaleString()} tokens, ${trace.summary.totalToolCalls} tool calls`,
      )
    }

    // Long sessions (>15 min)
    if (trace.summary.duration > 900_000) {
      addOccurrence(
        "long_session:over_15min",
        "long_session",
        "Sessions exceeding 15 minutes",
        "Very long sessions may indicate the agent is stuck or the task is too broad for a single session.",
        "Break large tasks into smaller subtasks. Use session forking for parallel work streams.",
        trace,
        `Duration: ${Math.floor(trace.summary.duration / 60000)}m, ${trace.summary.totalToolCalls} tool calls`,
      )
    }

    // Repeated edits to same file
    const editTargets: Record<string, number> = {}
    for (const span of trace.spans) {
      if (span.kind === "tool" && (span.name === "edit" || span.name === "write")) {
        const file = extractFilePath(span.input ?? "")
        if (file) editTargets[file] = (editTargets[file] ?? 0) + 1
      }
    }
    for (const [file, count] of Object.entries(editTargets)) {
      if (count >= 4) {
        addOccurrence(
          `repeated_edit:${file}`,
          "repeated_edit",
          `Repeated edits to "${file.split("/").pop()}"`,
          `The same file was edited ${count} times in one session, suggesting the agent is struggling to get it right.`,
          "Check if the agent is getting clear error feedback. Lint/type-check feedback after edits can reduce churn.",
          trace,
          `${file} edited ${count} times`,
        )
      }
    }
  }

  const issues = [...issueMap.values()]
  issues.sort((a, b) => {
    const sev: Record<IssueSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 }
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity]
    return b.frequency - a.frequency
  })

  return issues
}

function escalateSeverity(current: IssueSeverity, frequency: number): IssueSeverity {
  if (frequency >= 10 && current !== "critical") return "critical"
  if (frequency >= 5 && (current === "medium" || current === "low")) return "high"
  if (frequency >= 3 && current === "low") return "medium"
  return current
}

function extractFilePath(input: unknown): string | null {
  const str = typeof input === "string" ? input : typeof input === "object" && input ? JSON.stringify(input) : ""
  const match = str.match(/(?:\/[\w./-]+\.[\w]+)/)
  return match?.[0] ?? null
}

export function classifySessionTopic(trace: TraceFile): string[] {
  const topics: string[] = []
  const text = [
    trace.metadata.title,
    trace.summary.narrative,
    ...(trace.spans.slice(0, 3).map((s) => typeof s.input === "string" ? s.input : "").filter(Boolean)),
  ].join(" ").toLowerCase()

  const topicKeywords: Record<string, string[]> = {
    "Bug Fix": ["fix", "bug", "error", "issue", "broken", "crash", "fail", "patch"],
    "Feature": ["add", "implement", "create", "build", "new feature", "introduce"],
    "Refactor": ["refactor", "restructure", "clean up", "reorganize", "simplify", "deduplicate"],
    "Testing": ["test", "spec", "coverage", "assert", "expect", "mock", "fixture"],
    "Documentation": ["doc", "readme", "comment", "explain", "guide", "tutorial"],
    "Configuration": ["config", "setup", "install", "deploy", "env", "yaml", "toml"],
    "Database": ["sql", "query", "migration", "schema", "table", "dbt", "warehouse"],
    "DevOps": ["docker", "ci", "pipeline", "deploy", "kubernetes", "helm"],
    "Review": ["review", "analyze", "audit", "check", "inspect", "explore"],
  }

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some((kw) => text.includes(kw))) topics.push(topic)
  }

  if (!topics.length) topics.push("General")
  return topics
}

export { TOPIC_LABELS as IssueTopicLabels }
