import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Ripgrep } from "../../src/file/ripgrep"

// altimate_change start — upstream_fix: legacy `/find` search must survive unusable records.
// `search()` used to `JSON.parse` + strictly `Result.parse` every line, so a single unusable record
// threw out of the whole call and discarded every match already collected from unrelated files —
// the same defect fixed in packages/core/src/ripgrep.ts. This path is reachable from the mounted
// `/find` route (server/routes/file.ts), so it needs its own coverage.
const withRepo = async (run: (dir: string) => Promise<void>) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "legacy-rg-")))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("legacy Ripgrep.search", () => {
  // Explicit timeout: this drives the real binary, and `search()` resolves it through `state()`,
  // which downloads a release archive when `rg` is absent from PATH and from Global.Path.bin.
  test(
    "returns matches from a file whose matched line is not valid UTF-8",
    () =>
      withRepo(async (dir) => {
        await fs.writeFile(path.join(dir, "a-plain.txt"), "needle here\n")
        // ripgrep emits `{"bytes": "<base64>"}` rather than `{"text": ...}` for this line, which the
        // strict Zod schema rejected — taking the unrelated matches down with it.
        await fs.writeFile(path.join(dir, "b-binary.txt"), Buffer.from("needle \xff\xfe tail\n", "binary"))
        await fs.writeFile(path.join(dir, "c-plain.txt"), "needle here\n")

        const matches = await Ripgrep.search({ cwd: dir, pattern: "needle", limit: 10 })

        expect(matches.map((match) => match.path.text.replace(/^\.\//, "")).sort()).toEqual([
          "a-plain.txt",
          "b-binary.txt",
          "c-plain.txt",
        ])
        const binary = matches.find((match) => match.path.text.includes("b-binary.txt"))
        expect(binary?.lines.text).toContain("needle")
        expect(binary?.lines.text).toContain("tail")
      }),
    120_000,
  )
})

// `parseRecords` is exercised directly so the skip branches this PR adds — the `JSON.parse` catch,
// the size ceiling, the counter — are covered without depending on what the installed ripgrep build
// happens to emit.
describe("legacy Ripgrep.parseRecords", () => {
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
  const paths = (records: string[]) => Ripgrep.parseRecords(records).map((match) => match.path.text)

  test("skips an unparseable record and keeps the ones around it", () => {
    expect(paths([record("a.txt"), '{"type":"match","data":{"path":{"text":"./b.t', record("c.txt")])).toEqual([
      "./a.txt",
      "./c.txt",
    ])
  })

  test("skips a record past the size ceiling", () => {
    const huge = record("b.txt", { lines: { text: "n".repeat(17 * 1024 * 1024) } })
    expect(paths([record("a.txt"), huge, record("c.txt")])).toEqual(["./a.txt", "./c.txt"])
  })

  test("skips a record whose path is not valid UTF-8, rather than mangling the path", () => {
    const bad = record("ignored", { path: { bytes: Buffer.from("./b\xff.txt", "binary").toString("base64") } })
    expect(paths([record("a.txt"), bad])).toEqual(["./a.txt"])
  })

  test("skips empty and non-canonical base64 rather than emitting an empty match", () => {
    expect(paths([record("a.txt"), record("b.txt", { lines: { bytes: "" } })])).toEqual(["./a.txt"])
    expect(paths([record("a.txt"), record("b.txt", { lines: { bytes: "Zh==" } })])).toEqual(["./a.txt"])
  })

  test("decodes a non-UTF8 line and ignores control records", () => {
    const parsed = Ripgrep.parseRecords([
      JSON.stringify({ type: "begin", data: { path: { text: "./a.txt" } } }),
      record("a.txt", { lines: { bytes: Buffer.from("needle \xff tail\n", "binary").toString("base64") } }),
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0].lines.text).toBe("needle � tail\n")
  })

  // Offsets are byte offsets into the RAW line; a lossy decode widens each undecodable byte to a
  // 3-byte U+FFFD. This response shape is published by the `/find` route, so leaving them unrebased
  // would be newly wrong output rather than a skipped record. Mirrors the core parser.
  test("rebases submatch offsets after a lossy line decode", () => {
    const raw = Buffer.concat([Buffer.from([0xff]), Buffer.from("needle tail\n")])
    const parsed = Ripgrep.parseRecords([
      record("a.txt", {
        lines: { bytes: raw.toString("base64") },
        submatches: [{ match: { bytes: Buffer.from("needle").toString("base64") }, start: 1, end: 7 }],
      }),
    ])

    expect(parsed).toHaveLength(1)
    const [{ lines, submatches }] = parsed
    expect(submatches[0]).toEqual({ match: { text: "needle" }, start: 3, end: 9 })
    expect(Buffer.from(lines.text, "utf8").subarray(3, 9).toString("utf8")).toBe("needle")
  })

  test("skips a record whose submatch offset is not addressable in the line", () => {
    const raw = Buffer.concat([Buffer.from([0xff]), Buffer.from("needle tail\n")])
    const bad = record("b.txt", {
      lines: { bytes: raw.toString("base64") },
      submatches: [{ match: { text: "needle" }, start: 1, end: 9_999 }],
    })
    // `z.number()` would accept 9999 happily, so the range check is what rejects this.
    expect(paths([record("a.txt"), bad, record("c.txt")])).toEqual(["./a.txt", "./c.txt"])
  })

  test("returns an empty array when every record is unusable, rather than throwing", () => {
    expect(() => Ripgrep.parseRecords(["{oops", "{also oops"])).not.toThrow()
    expect(Ripgrep.parseRecords(["{oops", "{also oops"])).toEqual([])
  })
})
// altimate_change end
