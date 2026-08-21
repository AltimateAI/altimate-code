import { describe, expect, test } from "bun:test"
import { RipgrepRecords } from "../../src/file/ripgrep-records"

// altimate_change start — upstream_fix: legacy `/find` parsing must survive unusable records.
// `search()` used to `JSON.parse` + strictly `Result.parse` every line, so a single unusable record
// threw out of the whole call and discarded every match already collected from unrelated files —
// the same defect fixed in packages/core/src/ripgrep.ts. This path is reachable from the mounted
// `/find` route (server/routes/file.ts).
//
// These drive the parser directly. It is pure and process-free, so there is no stub binary and no
// PATH mutation: the legacy binary lookup is memoised per process, so a stub would leak into every
// later test file in the same `bun test` run.
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

const paths = (records: string[]) => RipgrepRecords.parseRecords(records).map((match) => match.path.text)

describe("RipgrepRecords.parseRecords", () => {
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
    const parsed = RipgrepRecords.parseRecords([
      JSON.stringify({ type: "begin", data: { path: { text: "./a.txt" } } }),
      record("a.txt", { lines: { bytes: Buffer.from("needle \xff tail\n", "binary").toString("base64") } }),
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0].lines.text).toBe("needle � tail\n")
  })

  // Offsets are byte offsets into the RAW line; a lossy decode widens each undecodable byte to a
  // 3-byte U+FFFD. This shape is published by the `/find` route, so unrebased offsets would be
  // newly wrong output rather than a skipped record. Mirrors the core parser.
  test("rebases submatch offsets after a lossy line decode", () => {
    const raw = Buffer.concat([Buffer.from([0xff]), Buffer.from("needle tail\n")])
    const parsed = RipgrepRecords.parseRecords([
      record("a.txt", {
        lines: { bytes: raw.toString("base64") },
        submatches: [{ match: { bytes: Buffer.from("needle").toString("base64") }, start: 1, end: 7 }],
      }),
    ])

    expect(parsed[0].submatches[0]).toEqual({ match: { text: "needle" }, start: 3, end: 9 })
    expect(Buffer.from(parsed[0].lines.text, "utf8").subarray(3, 9).toString("utf8")).toBe("needle")
  })

  // An offset that cannot be expressed in the decoded line drops its submatch, not the match.
  test("drops a submatch whose offset is unaddressable, keeping the match", () => {
    const raw = Buffer.concat([Buffer.from([0xff]), Buffer.from("needle tail\n")])
    const parsed = RipgrepRecords.parseRecords([
      record("a.txt", {
        lines: { bytes: raw.toString("base64") },
        submatches: [{ match: { text: "needle" }, start: 1, end: 9_999 }],
      }),
    ])

    expect(parsed).toHaveLength(1)
    expect(parsed[0].submatches).toEqual([])
  })

  test("drops a submatch whose offset splits a character or inverts the range", () => {
    const split = RipgrepRecords.parseRecords([
      record("a.txt", {
        lines: { bytes: Buffer.concat([Buffer.from("é"), Buffer.from("needle")]).toString("base64") },
        submatches: [{ match: { text: "needle" }, start: 1, end: 3 }],
      }),
    ])
    expect(split[0].submatches).toEqual([])

    // Both endpoints are addressable, but the range is inverted.
    const inverted = RipgrepRecords.parseRecords([
      record("a.txt", {
        lines: { bytes: Buffer.from("needle tail\n").toString("base64") },
        submatches: [{ match: { text: "needle" }, start: 6, end: 2 }],
      }),
    ])
    expect(inverted[0].submatches).toEqual([])
  })

  // `MAX_RECORD_BYTES` bounds one input record, not what the `/find` response retains.
  test("caps the retained line and submatch text", () => {
    const huge = "n".repeat(50_000)
    const parsed = RipgrepRecords.parseRecords([
      record("a.txt", { lines: { text: huge }, submatches: [{ match: { text: huge }, start: 0, end: huge.length }] }),
    ])

    expect(parsed[0].lines.text).toHaveLength(2_003)
    expect(parsed[0].lines.text.endsWith("...")).toBe(true)
    expect(parsed[0].submatches[0].match.text).toHaveLength(2_003)
  })

  // `{text}` arm: nothing is rebased, but `z.number()` accepts negatives, fractions and values past
  // the end, so a corrupt record would otherwise reach the `/find` response indexing nothing.
  test("drops a text-arm submatch whose offset is not addressable in the line", () => {
    const parsed = RipgrepRecords.parseRecords([
      record("a.txt", { lines: { text: "needle\n" }, submatches: [{ match: { text: "needle" }, start: 0, end: 999 }] }),
    ])
    expect(parsed[0].submatches).toEqual([])

    const fractional = RipgrepRecords.parseRecords([
      record("a.txt", { lines: { text: "needle\n" }, submatches: [{ match: { text: "needle" }, start: 0.5, end: 6 }] }),
    ])
    expect(fractional[0].submatches).toEqual([])
  })

  // A byte offset can fall inside a multi-byte character even on a perfectly valid UTF-8 line.
  test("drops a text-arm submatch whose offset splits a multi-byte character", () => {
    const parsed = RipgrepRecords.parseRecords([
      record("a.txt", { lines: { text: "éa" }, submatches: [{ match: { text: "a" }, start: 1, end: 3 }] }),
    ])
    expect(parsed[0].submatches).toEqual([])

    // The same line with boundary-aligned offsets is kept.
    const ok = RipgrepRecords.parseRecords([
      record("a.txt", { lines: { text: "éa" }, submatches: [{ match: { text: "a" }, start: 2, end: 3 }] }),
    ])
    expect(ok[0].submatches).toHaveLength(1)
  })

  // Each submatch costs a rebase per endpoint, and a rebase allocates a string up to the line
  // length, so an unbounded array turns one in-ceiling record into O(count x line) work.
  test("bounds the submatch count like the core parser", () => {
    const many = Array.from({ length: 5_000 }, () => ({ match: { text: "n" }, start: 0, end: 1 }))
    const parsed = RipgrepRecords.parseRecords([record("a.txt", { submatches: many })])
    expect(parsed[0].submatches).toHaveLength(100)
  })

  // The earlier repeated-group base64 regex backtracked catastrophically: on Bun a
  // canonical 4 MiB body tested FALSE (valid data silently discarded) and on Node
  // it raised RangeError, which escaped and aborted the whole search.
  test("decodes a multi-megabyte bytes field instead of discarding it", () => {
    const raw = Buffer.concat([Buffer.from([0xff]), Buffer.alloc(5 * 1024 * 1024, 0x61), Buffer.from("needle")])
    const parsed = RipgrepRecords.parseRecords([
      record("big.txt", { lines: { bytes: raw.toString("base64") }, submatches: [] }),
    ])
    expect(parsed).toHaveLength(1)
    // Assert the decode itself, not just that something long came back.
    expect(parsed[0].lines.text.startsWith("\uFFFD" + "a".repeat(64))).toBe(true)
    expect(parsed[0].lines.text.endsWith("...")).toBe(true)
  })

  test("returns an empty array when every record is unusable, rather than throwing", () => {
    expect(RipgrepRecords.parseRecords(["{oops", "{also oops"])).toEqual([])
  })
})
// altimate_change end
