import { createHash } from "crypto"
import type { PIIAction, PIICategory, PIIFinding, TraceFile, TraceManagerConfig } from "../types"
import { detectPIIInTrace } from "./detector"

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8)
}

export function redactString(
  text: string,
  findings: PIIFinding[],
  actions: Partial<Record<PIICategory, PIIAction>>,
): string {
  if (!findings.length) return text

  const sorted = [...findings].sort((a, b) => b.start - a.start)
  let result = text
  for (const f of sorted) {
    const action = actions[f.category] ?? "redact"
    if (action === "allow") continue
    const replacement = action === "hash" ? hashValue(f.match) : "[REDACTED]"
    result = result.slice(0, f.start) + replacement + result.slice(f.end)
  }
  return result
}

export interface RedactionResult {
  trace: TraceFile
  findings: PIIFinding[]
  redactedCount: number
  allowedCount: number
}

export function redactTrace(
  trace: TraceFile,
  config: TraceManagerConfig,
  overrides?: Partial<Record<string, PIIAction>>,
): RedactionResult {
  const findings = detectPIIInTrace(trace)
  const actions = { ...config.consent.piiCategories, ...overrides } as Partial<Record<PIICategory, PIIAction>>

  let redactedCount = 0
  let allowedCount = 0

  const redacted: TraceFile = JSON.parse(JSON.stringify(trace))

  if (redacted.metadata.userId) {
    const metaFindings = findings.filter((f) => f.field === "metadata.userId")
    if (metaFindings.length) {
      redacted.metadata.userId = redactString(redacted.metadata.userId, metaFindings, actions)
    }
  }
  if (redacted.metadata.prompt) {
    const metaFindings = findings.filter((f) => f.field === "metadata.prompt")
    if (metaFindings.length) {
      redacted.metadata.prompt = redactString(redacted.metadata.prompt, metaFindings, actions)
    }
  }

  for (const span of redacted.spans) {
    const inputFindings = findings.filter((f) => f.spanId === span.spanId && f.field === "span.input")
    const outputFindings = findings.filter((f) => f.spanId === span.spanId && f.field === "span.output")

    if (span.input && inputFindings.length) {
      span.input = redactString(span.input, inputFindings, actions)
    }
    if (span.output && outputFindings.length) {
      span.output = redactString(span.output, outputFindings, actions)
    }
  }

  for (const f of findings) {
    const action = actions[f.category] ?? "redact"
    if (action === "allow") allowedCount++
    else redactedCount++
  }

  return { trace: redacted, findings, redactedCount, allowedCount }
}
