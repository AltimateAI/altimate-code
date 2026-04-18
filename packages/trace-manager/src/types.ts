export interface TraceFile {
  version: number
  traceId: string
  sessionId: string
  startedAt: string
  endedAt?: string
  metadata: {
    title?: string
    model?: string
    providerId?: string
    agent?: string
    userId?: string
    prompt?: string
    environment?: string
    version?: string
    tags?: string[]
  }
  spans: TraceSpan[]
  summary: TraceSummary
}

export interface TraceSpan {
  spanId: string
  parentSpanId?: string | null
  name: string
  kind: string
  startTime?: number
  endTime?: number
  status?: string
  model?: { modelId?: string; providerId?: string } | string
  finishReason?: string
  tokens?: { input?: number; output?: number; reasoning?: number; total?: number; cacheRead?: number; cacheWrite?: number }
  cost?: number
  input?: string
  output?: string
  attributes?: Record<string, unknown>
  tool?: { callId?: string; durationMs?: number }
}

export interface TraceSummary {
  totalTokens: number
  totalCost: number
  totalToolCalls: number
  totalGenerations: number
  duration: number
  status: string
  error?: string
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  loops?: Array<{ tool: string; inputHash?: string; count: number; description: string }>
  narrative?: string
  topTools?: Array<{ name: string; count: number; totalDuration: number }>
}

export type PIICategory = "email" | "api_key" | "ip_address" | "file_path" | "name" | "phone" | "ssn" | "credit_card"
export type PIIAction = "redact" | "hash" | "allow"

export interface PIIFinding {
  category: PIICategory
  match: string
  start: number
  end: number
  field: string
  spanId?: string
}

export interface TraceManagerConfig {
  version: 1
  consent: {
    acceptedAt: string
    piiCategories: Partial<Record<PIICategory, PIIAction>>
    customPatterns: Array<{ name: string; regex: string; action: PIIAction }>
    autoPublish: boolean
    autoIngest: boolean
    retentionDays: number
  }
  publish: {
    endpoints: Array<{ name: string; url: string; headers?: Record<string, string> }>
  }
  lake: {
    path: string
  }
}
