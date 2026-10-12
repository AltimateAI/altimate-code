// altimate_change start — exercise the CLI's actual cancellation closure without a listening server
import { expect, test } from "bun:test"
import fs from "node:fs/promises"

test("hard deadline aborts a queued session without a post-subscription busy event", async () => {
  const source = await fs.readFile(new URL("../../../src/cli/cmd/run.ts", import.meta.url), "utf8")
  const start = source.indexOf("      const abortForTimeBudget = () => {")
  const end = source.indexOf("      const checkTimeBudget =", start)
  expect(start).toBeGreaterThan(0)
  const calls: string[] = []
  // Supply the lexical state used by the production closure; no busy event has arrived.
  const setup = new Function(
    "sdk",
    `
    const sessionID = "ses_queued"
    let timeAbortRequested = false
    let timeBudgetAbort
    const accounting = { onSessionError() {} }
    const eventAbort = new AbortController()
    ${source.slice(start, end)}
    abortForTimeBudget()
    abortForTimeBudget()
    return timeBudgetAbort
  `,
  )
  await setup({
    session: {
      abort: async ({ sessionID }: { sessionID: string }) => {
        calls.push(sessionID)
        return {}
      },
    },
  })
  expect(calls).toEqual(["ses_queued"])
})
// altimate_change end

// altimate_change start — the request lifetime also ends when queued work never becomes busy
for (const command of [undefined, "inspect"]) {
  test(`hard deadline cancels the ${command ? "command" : "prompt"} POST before any busy event`, async () => {
    const source = await fs.readFile(new URL("../../../src/cli/cmd/run.ts", import.meta.url), "utf8")
    const start = source.indexOf("      const send = () => {")
    const end = source.indexOf("      /** Did the server persist", start)
    const deadline = new AbortController()
    const send = new Function(
      "sdk",
      "args",
      "timeBudgetStop",
      `
      const sessionID = "ses_queued", sendMessageID = "msg_queued", agent = "analyst", message = "inspect"
      const files = [], audienceSystem = undefined
      const eventAbort = new AbortController()
      const startWorkClock = () => {}
      const budgetHeaders = () => ({})
      const Telemetry = { startupReady() {} }
      ${source.slice(start, end)}
      return send()
    `,
    )
    const sdk = {
      session: {
        prompt: (_: unknown, options: { signal: AbortSignal }) => options.signal,
        command: (_: unknown, options: { signal: AbortSignal }) => options.signal,
      },
    }
    const signal = send(sdk, { command }, deadline) as AbortSignal
    expect(signal.aborted).toBe(false)
    deadline.abort()
    expect(signal.aborted).toBe(true)
  })
}
// altimate_change end

// altimate_change start — deliberate request cancellation cannot prevent budget finalization recovery
for (const cancellation of [true, false]) {
  test(`hard deadline ${cancellation ? "preserves recovery after" : "does not hide"} an active POST failure`, async () => {
    const source = await fs.readFile(new URL("../../../src/cli/cmd/run.ts", import.meta.url), "utf8")
    const start = source.indexOf("      // altimate_change start — cancellation during bootstrap")
    const end = source.indexOf("      // Wait for the event loop to drain", start)
    const deadline = new AbortController()
    deadline.abort()
    const failures: unknown[] = []
    const account = new Function(
      "sendFailure",
      "timeBudgetStop",
      "accounting",
      `
      const timeExhausted = () => true
      const timeAbortRequested = true, assistantStarted = true, eventLoopFailure = undefined, sendResult = undefined
      const eventAbort = new AbortController()
      const RunAccounting = { serializeSessionError: String }
      let error
      ${source.slice(start, end)}
    `,
    )
    account(cancellation ? deadline.signal.reason : new Error("unrelated transport failure"), deadline, {
      onPromptSendError(error: unknown) {
        failures.push(error)
      },
      onPromptResult() {},
    })
    expect(failures).toHaveLength(cancellation ? 0 : 1)
  })
}
// altimate_change end

// altimate_change start — idempotency probes share the request's hard deadline
test("hard deadline cancels an acceptance probe after a retryable POST failure", async () => {
  const source = await fs.readFile(new URL("../../../src/cli/cmd/run.ts", import.meta.url), "utf8")
  const start = source.lastIndexOf("const acceptance = await ")
  const end = source.indexOf("\n        if (", start)
  const expression = source.slice(start + "const acceptance = await ".length, end).trim()
  const deadline = new AbortController()
  const eventAbort = new AbortController()
  const probe = new Function(
    "acceptanceState",
    "timeBudgetStop",
    "eventAbort",
    `const sendMessageID = "msg_queued"; return ${expression}`,
  )
  const pending = probe(
    (_: string, signal?: AbortSignal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve("cancelled"), { once: true })
      }),
    deadline,
    eventAbort,
  )
  deadline.abort()
  expect(await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("hung"), 30))])).toBe(
    "cancelled",
  )
})
// altimate_change end
