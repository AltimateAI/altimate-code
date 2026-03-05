import { describe, expect, test, afterEach } from "bun:test"
import { Rpc } from "../../../src/util/rpc"
import type { rpc } from "../../../src/cli/cmd/tui/worker"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workerSrc = path.resolve(__dirname, "../../../src/cli/cmd/tui/worker.ts")

describe("tui worker", () => {
  let worker: Worker | undefined

  afterEach(() => {
    worker?.terminate()
    worker = undefined
  })

  test("starts without errors", async () => {
    const errors: string[] = []

    worker = new Worker(workerSrc, {
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    })

    worker.onerror = (e) => {
      errors.push(e.message ?? String(e))
    }

    // Give the worker time to initialize — module loading,
    // top-level awaits, and side effects all run during this window.
    await new Promise((r) => setTimeout(r, 3000))

    expect(errors).toEqual([])
  }, 10_000)

  test("responds to RPC calls after startup", async () => {
    const errors: string[] = []

    worker = new Worker(workerSrc, {
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    })

    worker.onerror = (e) => {
      errors.push(e.message ?? String(e))
    }

    // Wait for worker to be ready
    await new Promise((r) => setTimeout(r, 3000))
    expect(errors).toEqual([])

    // Verify RPC communication works — the worker exports a `fetch` method
    const client = Rpc.client<typeof rpc>(worker)
    const result = await Promise.race([
      client.call("fetch", {
        url: "http://altimate-code.internal/health",
        method: "GET",
        headers: {},
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 5000)),
    ])

    expect(result).toBeDefined()
    expect(typeof result.status).toBe("number")
  }, 15_000)
})
