import { expect, test } from "bun:test"
import { LocalEngine } from "../src/local-engine"
import { LOCAL_ENGINE_CHILD_SOURCE } from "../src/local-engine-child-source"

async function* chunks(text: string) {
  const bytes = new TextEncoder().encode(text)
  for (let offset = 0; offset < bytes.length; offset += 127) yield bytes.slice(offset, offset + 127)
}

async function scannedCharacters(run: () => Promise<void>) {
  const original = String.prototype.indexOf
  let scanned = 0
  String.prototype.indexOf = function (search, position = 0) {
    if (search === "\n") scanned += this.length - position
    return original.call(this, search, position)
  }
  try {
    await run()
    return scanned
  } finally {
    String.prototype.indexOf = original
  }
}

test("stdout reader scans fragmented Unicode JSON lines in linear work", async () => {
  const value = "a🙂é".repeat(20_000)
  const line = JSON.stringify({ id: 1, ok: true, result: value }) + "\n\n"
  let received: unknown
  const engine = new LocalEngine({ engine: "sqlite", label: "SQLite", storePath: ":memory:" })
  const scanned = await scannedCharacters(async () => {
    await (engine as any).readLoop({
      proc: { stdout: chunks(line) },
      pending: { id: 1, resolve: (value: unknown) => (received = value), reject: () => {} },
    })
  })
  expect(received).toBe(value)
  expect(scanned).toBeLessThan(line.length * 3)
})

test("stdin reader scans fragmented Unicode JSON requests in linear work", async () => {
  const line =
    JSON.stringify({ id: 1, op: "unknown", payload: { sql: "a🙂é".repeat(20_000) } }) +
    "\n\n" +
    JSON.stringify({ id: 2, op: "unknown" }) +
    "\n"
  const responses: any[] = []
  const execute = new Function(
    "Bun",
    "process",
    LOCAL_ENGINE_CHILD_SOURCE.replace("(async () => {", "return (async () => {"),
  )
  const scanned = await scannedCharacters(async () => {
    await execute(
      { stdin: { stream: () => chunks(line) } },
      {
        argv: ["bun", "test", "0"],
        stdout: { write: (line: string) => responses.push(JSON.parse(line)) },
        exit: () => {},
      },
    )
  })
  expect(responses.map((response) => response.id)).toEqual([1, 2])
  expect(responses.every((response) => response.error.message === "unknown op unknown")).toBe(true)
  expect(scanned).toBeLessThan(line.length * 3)
})
