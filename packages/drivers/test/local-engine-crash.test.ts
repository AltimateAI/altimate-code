import { expect, test } from "bun:test"
import { LocalEngine } from "../src/local-engine"

function helper(query: string) {
  return new LocalEngine({
    engine: "duckdb",
    label: "DuckDB",
    storePath: ":memory:",
    childSource: `
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.op === "all") { ${query} }
  process.stdout.write(JSON.stringify({ id: message.id, ok: true, result: null }) + "\\n");
}
`,
  })
}

test("a helper killed mid-query reports SIGKILL without assuming an out-of-memory cause", async () => {
  const engine = helper('process.kill(process.pid, "SIGKILL"); await new Promise(() => {});')
  try {
    await engine.open({ path: ":memory:" })
    const error = await engine.call("all", { sql: "SELECT 1" }, 2_000).catch((error) => error)
    expect(error).toMatchObject({ code: "LOCAL_ENGINE_PROCESS_EXITED", engine: "DuckDB", signal: "SIGKILL", stateLost: true })
    expect(error.message).toContain("DuckDB helper process")
    expect(error.message).toContain("SIGKILL")
    expect(error.message).not.toMatch(/out.of.memory/i)
  } finally {
    await engine.close()
  }
})

test("a helper crash preserves its exit code and only a bounded stderr tail", async () => {
  const engine = helper('writeSync(2, "earlier diagnostic\\n" + "x".repeat(20_000) + "\\nallocator diagnostic: é🙂\\n"); process.exit(23);')
  try {
    await engine.open({ path: ":memory:" })
    const error = await engine.call("all", { sql: "SELECT 1" }, 2_000).catch((error) => error)
    expect(error).toMatchObject({ code: "LOCAL_ENGINE_PROCESS_EXITED", exitCode: 23, signal: null })
    expect(error.message).toContain("exit code 23")
    expect(error.message).toContain("allocator diagnostic: é🙂")
    expect(error.stderr).toEndWith("allocator diagnostic: é🙂\n")
    expect(error.stderr.length).toBeLessThanOrEqual(8_192)
    expect(error.stderr).not.toContain("earlier diagnostic")
  } finally {
    await engine.close()
  }
})

test("a helper killed to enforce a deadline remains a query timeout", async () => {
  const engine = helper("await new Promise(() => {});")
  try {
    await engine.open({ path: ":memory:" })
    const error = await engine.call("all", { sql: "SELECT 1" }, 50).catch((error) => error)
    expect(error).toMatchObject({ code: "QUERY_TIMEOUT" })
    expect(error.message).not.toContain("LOCAL_ENGINE_PROCESS_EXITED")
  } finally {
    await engine.close()
  }
})

test("a crashed helper reports promptly when an inherited stderr pipe stays open past the deadline", async () => {
  const engine = helper(`
    const descendant = Bun.spawn({
      cmd: [process.execPath, "--config=" + process.env.TMPDIR + "/bunfig.toml", "--no-env-file", "-e", "setTimeout(() => {}, 2000)"],
      stdin: "ignore", stdout: "ignore", stderr: "inherit",
    });
    writeSync(2, "stderr descendant " + descendant.pid + "\\n");
    process.exit(31);
  `)
  let descendant: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await engine.open({ path: ":memory:" })
    const error = await Promise.race([
      engine.call("all", { sql: "SELECT 1" }, 100).catch((error) => error),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Helper exit did not settle")), 1_000) }),
    ])
    descendant = Number(error.stderr?.match(/stderr descendant (\d+)/)?.[1]) || undefined
    expect(error).toMatchObject({ code: "LOCAL_ENGINE_PROCESS_EXITED", exitCode: 31 })
    expect(error.stderr).toContain("stderr descendant")
  } finally {
    if (timer) clearTimeout(timer)
    if (descendant) {
      try { process.kill(descendant, "SIGKILL") } catch {}
    }
    await engine.close()
  }
})
