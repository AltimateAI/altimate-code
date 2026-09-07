// Fetch-shaped fake for the two real Altimate Base gateway routes (`POST /register`,
// `POST /v1/chat/completions`). Installed via `spyOn(globalThis, "fetch")` — the same seam
// `test/altimate/altimate-base.test.ts` already uses — so every suite stays hermetic: no port
// binding, no real network, no external dependency. See
// docs/internal/2026-09-04-altimate-base-e2e-harness-plan.md, Deliverable 2, for why an in-process
// fetch fake was chosen over a real local HTTP server.
import { spyOn } from "bun:test"

export const GATEWAY_URL = "https://gateway.test"
export const MODEL_ID = "altimate-base"

export interface RegisterCall {
  url: string
  installSecretHash: string
  cliVersion: string
}
export interface ChatCall {
  url: string
  authorization: string | null
  body: unknown
}

export type RegisterMode =
  | { kind: "ok"; apiKey?: string; expiresAt?: string | null; baseUrl?: string; model?: string }
  | { kind: "http"; status: number; headers?: Record<string, string> }
  | { kind: "network" }
  | { kind: "malformed-json" }

export type ChatMode =
  | { kind: "ok"; content?: string; status?: number }
  | { kind: "throttle-tokens" } // 429 throttling_error, "Limit type: tokens" — non-retryable
  | { kind: "throttle-burst"; retryAfterSeconds?: number } // 429 throttling_error, generic — retryable
  | { kind: "budget-wallet" } // 429 budget_exceeded, "ExceededBudget: User="
  | { kind: "budget-global" } // 429 budget_exceeded, "Budget has been exceeded"
  | { kind: "budget-unknown" } // 429 budget_exceeded, neither substring
  | { kind: "too-large"; requestBytes?: number; limitBytes?: number } // 413 request_too_large
  | { kind: "unauthorized" } // 401
  | { kind: "server-error"; status?: number } // 5xx
  | { kind: "timeout" } // never resolves until the request's AbortSignal fires
  | { kind: "malformed-json" }

/**
 * Fetch-shaped fake for the two real gateway routes. Install with `.install()` (typically in
 * `beforeEach`), script the next response with `.registerNext()` / `.chatNext()` (each call
 * enqueues one response; unscripted calls default to `{ kind: "ok" }`), and read
 * `.registerCalls` / `.chatCalls` to assert what was actually sent. Restore with `.restore()`
 * (typically in `afterEach`) to remove the `fetch` spy.
 *
 * One instance per test file. Do not share an instance across files — `bun test` runs each file
 * in its own worker process by default, so there is no cross-file state to worry about, but
 * sharing an instance across `describe` blocks within one file mixes their scripted queues.
 */
export class FakeGateway {
  registerCalls: RegisterCall[] = []
  chatCalls: ChatCall[] = []
  private registerQueue: RegisterMode[] = []
  private chatQueue: ChatMode[] = []
  private spy?: ReturnType<typeof spyOn>

  registerNext(mode: RegisterMode): this {
    this.registerQueue.push(mode)
    return this
  }
  chatNext(mode: ChatMode): this {
    this.chatQueue.push(mode)
    return this
  }

  /** Clears scripted queues and call logs without touching the installed spy. */
  reset(): this {
    this.registerCalls = []
    this.chatCalls = []
    this.registerQueue = []
    this.chatQueue = []
    return this
  }

  install(): this {
    this.spy = spyOn(globalThis, "fetch").mockImplementation(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.endsWith("/register")) return this.handleRegister(url, init)
        if (url.includes("/v1/chat/completions")) return this.handleChat(url, init)
        throw new Error(`FakeGateway: unhandled URL ${url}`)
      }) as typeof fetch,
    )
    return this
  }

  restore(): void {
    this.spy?.mockRestore()
    this.spy = undefined
  }

  private async handleRegister(url: string, init?: RequestInit): Promise<Response> {
    const body = JSON.parse(String(init?.body))
    this.registerCalls.push({ url, installSecretHash: body.install_secret_hash, cliVersion: body.cli_version })
    const mode = this.registerQueue.shift() ?? { kind: "ok" as const }
    if (mode.kind === "network") throw new Error("connection reset")
    if (mode.kind === "http") return new Response("", { status: mode.status, headers: mode.headers })
    if (mode.kind === "malformed-json") return new Response("{not json", { status: 200 })
    return json({
      api_key: mode.apiKey ?? "sk-altimate-base-fake",
      base_url: mode.baseUrl ?? GATEWAY_URL,
      model: mode.model ?? MODEL_ID,
      ...(mode.expiresAt === null
        ? {}
        : { expires_at: mode.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString() }),
    })
  }

  private async handleChat(url: string, init?: RequestInit): Promise<Response> {
    const authorization = new Headers(init?.headers).get("Authorization")
    this.chatCalls.push({ url, authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const mode = this.chatQueue.shift() ?? { kind: "ok" as const }
    switch (mode.kind) {
      case "ok":
        return json(
          { choices: [{ message: { content: mode.content ?? "hello from altimate-base" } }] },
          mode.status ?? 200,
        )
      case "throttle-tokens":
        return throttleError("Limit type: tokens. Key=sk-fake. Current: 300000, Limit: 262144")
      case "throttle-burst":
        return throttleError("burst limit exceeded", mode.retryAfterSeconds)
      case "budget-wallet":
        return budgetError("ExceededBudget: User=principal-fake over budget. Spend=0.26, Budget=0.25")
      case "budget-global":
        return budgetError("Budget has been exceeded! Current cost: 50.01, Max budget: 50")
      case "budget-unknown":
        return budgetError("spend limit reached")
      case "too-large": {
        const size = mode.requestBytes ?? 179_608
        const limit = mode.limitBytes ?? 128_000
        const message = `Request is ${size} bytes; the free tier limit is ${limit} bytes.`
        return json(
          {
            error: {
              message,
              code: "413",
              provider_specific_fields: { error: { code: "request_too_large", message } },
            },
          },
          413,
        )
      }
      case "unauthorized":
        return new Response("", { status: 401 })
      case "server-error":
        return new Response("upstream error", { status: mode.status ?? 500 })
      case "timeout":
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
      case "malformed-json":
        return new Response("{not json", { status: 200 })
    }
  }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function throttleError(message: string, retryAfterSeconds?: number): Response {
  return new Response(JSON.stringify({ error: { type: "throttling_error", message } }), {
    status: 429,
    headers: retryAfterSeconds !== undefined ? { "retry-after": String(retryAfterSeconds) } : {},
  })
}

function budgetError(message: string): Response {
  return new Response(JSON.stringify({ error: { type: "budget_exceeded", message } }), { status: 429 })
}
