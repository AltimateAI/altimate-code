import type { TraceFile, TraceManagerConfig } from "../types"
import { redactTrace } from "../pii/redactor"

export interface PublishResult {
  success: boolean
  endpoint: string
  url?: string
  error?: string
  piiRedacted: number
  piiAllowed: number
}

export async function publishTrace(
  trace: TraceFile,
  config: TraceManagerConfig,
  endpoint?: { name: string; url: string; headers?: Record<string, string> },
): Promise<PublishResult> {
  const target = endpoint ?? config.publish.endpoints[0]
  if (!target) {
    return {
      success: false,
      endpoint: "none",
      error: "No publish endpoint configured. Add one via: altimate-code trace-manage consent",
      piiRedacted: 0,
      piiAllowed: 0,
    }
  }

  const { trace: redacted, redactedCount, allowedCount } = redactTrace(trace, config)

  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.headers ?? {}),
      },
      body: JSON.stringify(redacted),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      return {
        success: false,
        endpoint: target.name,
        error: `HTTP ${response.status}: ${response.statusText}`,
        piiRedacted: redactedCount,
        piiAllowed: allowedCount,
      }
    }

    let url: string | undefined
    try {
      const body = await response.json()
      url = (body as any)?.url
    } catch {}

    return {
      success: true,
      endpoint: target.name,
      url,
      piiRedacted: redactedCount,
      piiAllowed: allowedCount,
    }
  } catch (e) {
    return {
      success: false,
      endpoint: target.name,
      error: e instanceof Error ? e.message : String(e),
      piiRedacted: redactedCount,
      piiAllowed: allowedCount,
    }
  }
}

export function printPublishResult(result: PublishResult): void {
  if (result.success) {
    console.log(`  ✓ Published to ${result.endpoint}`)
    if (result.url) console.log(`    URL: ${result.url}`)
  } else {
    console.log(`  ✗ Failed to publish to ${result.endpoint}`)
    console.log(`    Error: ${result.error}`)
  }
  if (result.piiRedacted > 0) {
    console.log(`    PII: ${result.piiRedacted} field(s) redacted, ${result.piiAllowed} allowed`)
  }
}
