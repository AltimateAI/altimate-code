// altimate_change - new file
// `readRunStdin` on a real stdin: the other tests inject a fake source, so only these check that
// `fstatSync(0)` sees a socket for a Node `spawn` and a FIFO for a shell pipeline.
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"

const FIXTURE = path.join(import.meta.dir, "fixtures", "read-run-stdin.ts")
const env = { ...process.env, ALTIMATE_RUN_STDIN_WAIT_MS: "200" }

function collect(child: ReturnType<typeof spawn>): Promise<{ code: number | null; out: string; ms: number }> {
  const started = Date.now()
  let out = ""
  child.stdout!.on("data", (chunk) => (out += chunk))
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, out, ms: Date.now() - started })))
}

describe("readRunStdin on a real stdin", () => {
  test("a socket stdin that is never written or closed times out, and the process exits on its own", async () => {
    const child = spawn(process.execPath, [FIXTURE], { env })
    const result = await collect(child)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual({ text: "", timedOut: true })
    expect(result.ms).toBeLessThan(10_000)
  })

  test("a socket stdin that is written and closed comes through", async () => {
    const child = spawn(process.execPath, [FIXTURE], { env })
    child.stdin!.end("from the caller\n")
    expect(JSON.parse((await collect(child)).out)).toEqual({ text: "from the caller\n", timedOut: false })
  })

  test("with nothing else to run, a socket written after the wait still comes through", async () => {
    const child = spawn(process.execPath, [FIXTURE, "unbounded"], { env })
    setTimeout(() => child.stdin!.end("the prompt\n"), 600)
    expect(JSON.parse((await collect(child)).out)).toEqual({ text: "the prompt\n", timedOut: false })
  })

  test("a shell pipeline is read to EOF even when its first byte comes after the wait", async () => {
    const child = spawn("sh", ["-c", `sleep 0.6; echo piped | "${process.execPath}" "${FIXTURE}"`], { env })
    expect(JSON.parse((await collect(child)).out)).toEqual({ text: "piped\n", timedOut: false })
  })
})
