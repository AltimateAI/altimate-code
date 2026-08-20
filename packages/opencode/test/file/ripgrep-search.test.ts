import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Ripgrep } from "../../src/file/ripgrep"

// altimate_change start — upstream_fix: legacy `/find` search must survive unusable records.
// `search()` used to `JSON.parse` + strictly `Result.parse` every line, so a single unusable record
// threw out of the whole call and discarded every match already collected from unrelated files —
// the same defect fixed in packages/core/src/ripgrep.ts. This path is reachable from the mounted
// `/find` route (server/routes/file.ts), so it needs its own coverage.
//
// The cases drive the real `search()` — the parser is namespace-private per AGENTS.md — against a
// stub `rg` on PATH that prints exactly the NDJSON given. `which("rg")` resolves from PATH and the
// result is memoised, so PATH is set once before any search runs. The stub is a POSIX shell script,
// so this file is POSIX-only; the parser itself is platform-independent.
const posixTest = test.skipIf(process.platform === "win32")

let dir: string
let dataFile: string
let originalPath: string | undefined

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "legacy-rg-")))
  dataFile = path.join(dir, "records.jsonl")
  const bin = path.join(dir, "bin")
  await fs.mkdir(bin)
  const stub = path.join(bin, "rg")
  await fs.writeFile(stub, `#!/bin/sh\ncat ${JSON.stringify(dataFile)}\n`)
  await fs.chmod(stub, 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`
})

afterAll(async () => {
  process.env.PATH = originalPath
  await fs.rm(dir, { recursive: true, force: true })
})

const record = (file: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "match",
    data: {
      path: { text: `./${file}` },
      lines: { text: "needle\n" },
      line_number: 1,
      absolute_offset: 0,
      submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
      ...overrides,
    },
  })

const search = async (records: string[]) => {
  await fs.writeFile(dataFile, records.join("\n") + "\n")
  return Ripgrep.search({ cwd: dir, pattern: "needle", limit: 100 })
}
const paths = async (records: string[]) => (await search(records)).map((match) => match.path.text)

describe("legacy Ripgrep.search", () => {
  posixTest("skips an unparseable record and keeps the ones around it", async () => {
    expect(await paths([record("a.txt"), '{"type":"match","data":{"path":{"text":"./b.t', record("c.txt")])).toEqual([
      "./a.txt",
      "./c.txt",
    ])
  })

  posixTest("skips a record past the size ceiling", async () => {
    const huge = record("b.txt", { lines: { text: "n".repeat(17 * 1024 * 1024) } })
    expect(await paths([record("a.txt"), huge, record("c.txt")])).toEqual(["./a.txt", "./c.txt"])
  })

  posixTest("skips a record whose path is not valid UTF-8, rather than mangling the path", async () => {
    const bad = record("ignored", { path: { bytes: Buffer.from("./b\xff.txt", "binary").toString("base64") } })
    expect(await paths([record("a.txt"), bad])).toEqual(["./a.txt"])
  })

  posixTest("skips empty and non-canonical base64 rather than emitting an empty match", async () => {
    expect(await paths([record("a.txt"), record("b.txt", { lines: { bytes: "" } })])).toEqual(["./a.txt"])
    expect(await paths([record("a.txt"), record("b.txt", { lines: { bytes: "Zh==" } })])).toEqual(["./a.txt"])
  })

  posixTest("decodes a non-UTF8 line and ignores control records", async () => {
    const parsed = await search([
      JSON.stringify({ type: "begin", data: { path: { text: "./a.txt" } } }),
      record("a.txt", { lines: { bytes: Buffer.from("needle \xff tail\n", "binary").toString("base64") } }),
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0].lines.text).toBe("needle � tail\n")
  })

  // Offsets are byte offsets into the RAW line; a lossy decode widens each undecodable byte to a
  // 3-byte U+FFFD. This response shape is published by the `/find` route, so leaving them unrebased
  // would be newly wrong output rather than a skipped record. Mirrors the core parser.
  posixTest("rebases submatch offsets after a lossy line decode", async () => {
    const raw = Buffer.concat([Buffer.from([0xff]), Buffer.from("needle tail\n")])
    const parsed = await search([
      record("a.txt", {
        lines: { bytes: raw.toString("base64") },
        submatches: [{ match: { bytes: Buffer.from("needle").toString("base64") }, start: 1, end: 7 }],
      }),
    ])

    expect(parsed).toHaveLength(1)
    expect(parsed[0].submatches[0]).toEqual({ match: { text: "needle" }, start: 3, end: 9 })
    expect(Buffer.from(parsed[0].lines.text, "utf8").subarray(3, 9).toString("utf8")).toBe("needle")
  })

  // An offset that cannot be expressed in the decoded line drops its submatch, not the match.
  posixTest("drops a submatch whose offset is unaddressable, keeping the match", async () => {
    const raw = Buffer.concat([Buffer.from([0xff]), Buffer.from("needle tail\n")])
    const parsed = await search([
      record("a.txt", {
        lines: { bytes: raw.toString("base64") },
        submatches: [{ match: { text: "needle" }, start: 1, end: 9_999 }],
      }),
    ])

    expect(parsed).toHaveLength(1)
    expect(parsed[0].submatches).toEqual([])
  })

  posixTest("returns an empty array when every record is unusable, rather than throwing", async () => {
    expect(await search(["{oops", "{also oops"])).toEqual([])
  })
})
// altimate_change end
