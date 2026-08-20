// altimate_change start — upstream_fix: ripgrep NDJSON record parsing, split out of ripgrep.ts.
//
// This lives in its own module rather than inside the `Ripgrep` namespace because it is pure,
// process-free logic that deserves direct tests. Inside the namespace it was reachable only two
// ways, both bad: projected through `export * as` as an implementation detail of the public
// namespace, or driven through `search()` with a stub `rg` on PATH — and that binary lookup is
// memoised per process, so such a stub leaks into every later test file in the same `bun test`
// run and breaks unrelated suites.
//
// Module shape follows packages/opencode/AGENTS.md: flat top-level exports with a self-reexport at
// the bottom, not `export namespace`.
//
// It mirrors packages/core/src/ripgrep.ts, but the two are not identical by design. The core parser
// streams; this one buffers all of stdout before splitting, and hands its records straight to the
// `/find` response. Both cap retained text, bound submatch counts, skip records they cannot use,
// and report the skips once per search rather than once per record.
import z from "zod"
import { Log } from "@/util/log"

const log = Log.create({ service: "ripgrep" })

const Stats = z.object({
  elapsed: z.object({
    secs: z.number(),
    nanos: z.number(),
    human: z.string(),
  }),
  searches: z.number(),
  searches_with_match: z.number(),
  bytes_searched: z.number(),
  bytes_printed: z.number(),
  matched_lines: z.number(),
  matches: z.number(),
})

const Begin = z.object({
  type: z.literal("begin"),
  data: z.object({
    path: z.object({
      text: z.string(),
    }),
  }),
})

export const Match = z.object({
  type: z.literal("match"),
  data: z.object({
    path: z.object({
      text: z.string(),
    }),
    lines: z.object({
      text: z.string(),
    }),
    line_number: z.number(),
    absolute_offset: z.number(),
    submatches: z.array(
      z.object({
        match: z.object({
          text: z.string(),
        }),
        start: z.number(),
        end: z.number(),
      }),
    ),
  }),
})

const End = z.object({
  type: z.literal("end"),
  data: z.object({
    path: z.object({
      text: z.string(),
    }),
    binary_offset: z.number().nullable(),
    stats: Stats,
  }),
})

const Summary = z.object({
  type: z.literal("summary"),
  data: z.object({
    elapsed_total: z.object({
      human: z.string(),
      nanos: z.number(),
      secs: z.number(),
    }),
    stats: Stats,
  }),
})

const Result = z.union([Begin, Match, End, Summary])

// Tolerating ripgrep's `{bytes}` arm and malformed lines. (The whole file is covered by the
// marker at the top — this module is new, not an edit to upstream code.)
//
// This mirrors packages/core/src/ripgrep.ts, but deliberately not in every respect. That parser
// streams, so it caps the retained line text and rebases submatch offsets; this one buffers all of
// stdout up front and hands its records straight to the `/find` response, where the raw ripgrep
// shape is the published contract — so it normalises and skips, and leaves the shape alone. Both
// report skipped records once per search rather than once per record.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Mirrors packages/core/src/ripgrep.ts. Bounds parse cost per record on this path too. */
const MAX_RECORD_BYTES = 16 * 1024 * 1024

// Also mirrors core. Each submatch costs a rebase per endpoint, and a rebase allocates a string up
// to the length of the line, so an unbounded submatch array turns one in-ceiling record into
// O(count x line) work. A protocol change is exactly the shape that would emit one.
const MAX_SUBMATCHES = 100

// `MAX_RECORD_BYTES` bounds ONE input record; it does not bound what the response retains. This
// path buffers all of stdout and returns every match, so without a per-field cap a tree of large
// records still retains — and serialises into the `/find` response — an unbounded amount of text.
// Same cap and elision marker as the core parser, so the two paths agree on what a match shows.
const LINE_TEXT_CAP = 2_000
const capText = (text: string) => (text.length > LINE_TEXT_CAP ? text.slice(0, LINE_TEXT_CAP) + "..." : text)

/** Parse one NDJSON record, rewriting `{bytes: base64}` fields into the `{text}` arm. */
const normalizeRecord = (line: string): unknown => {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!json || typeof json !== "object") return json
  const read = (value: unknown, key: string): unknown =>
    value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined
  const data = read(json, "data")
  if (!data || typeof data !== "object") return json
  /** Decode a `{text}`/`{bytes}` field, returning the raw buffer so offsets can be rebased. */
  const decode = (value: unknown): { text: string; raw?: Buffer } | undefined => {
    if (!value || typeof value !== "object") return undefined
    const text = read(value, "text")
    if (typeof text === "string") return { text }
    const bytes = read(value, "bytes")
    // Guarded three ways because `Buffer.from` decodes unconvertible input to an EMPTY buffer
    // instead of throwing, which would turn a corrupt record into a schema-valid empty match:
    // reject the empty string (a matched line is never empty), check the spelling, then require
    // a round-trip so non-canonical padding ("Zh==" and "Zg==" both decode to "f") is rejected.
    if (typeof bytes !== "string" || bytes.length === 0 || !BASE64.test(bytes)) return undefined
    const decoded = Buffer.from(bytes, "base64")
    if (decoded.toString("base64") !== bytes) return undefined
    return { text: decoded.toString("utf8"), raw: decoded }
  }
  const lines = "lines" in data ? decode(read(data, "lines")) : undefined
  // Submatch offsets are BYTE offsets into the RAW line, and a lossy decode widens every
  // undecodable byte to a 3-byte U+FFFD — so they must be rebased onto the decoded text's own
  // UTF-8 encoding or they no longer locate the match. This response shape is published by the
  // `/find` route, so unrebased offsets would be newly wrong output rather than a skipped record.
  // Mirrors packages/core/src/ripgrep.ts.
  const raw = lines?.raw
  // Byte-boundary validation, matching packages/core/src/ripgrep.ts. A decoded-string comparison
  // is not sufficient: when an invalid byte precedes a LITERAL U+FFFD, an offset inside that
  // character still yields a prefix that prefixes the line, because the replacement characters
  // alias. A continuation byte (0b10xxxxxx) at the offset means the split lands inside a sequence.
  // An offset that cannot be rebased drops ITS SUBMATCH, not the record — the file, line and text
  // stay correct, and losing a highlight range beats losing the match.
  const isContinuationByte = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80
  // Encoded once per record and shared by every submatch; also supplies the byte length.
  const textBytes = raw ?? (lines ? Buffer.from(lines.text, "utf8") : Buffer.alloc(0))
  const rebase = (offset: unknown): number | undefined => {
    // `{text}` arm: nothing is rebased, but the offset must still be addressable AND land on a
    // character boundary — a byte offset can fall inside a multi-byte sequence (`éa`, offset 1
    // splits `é`). `z.number()` rejects none of that, so a corrupt record would otherwise reach the
    // `/find` response with coordinates that index nothing or half a character.
    if (!raw)
      return typeof offset === "number" &&
        Number.isInteger(offset) &&
        offset >= 0 &&
        offset <= textBytes.length &&
        !(offset !== 0 && offset !== textBytes.length && isContinuationByte(textBytes[offset]))
        ? offset
        : undefined
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > raw.length) return undefined
    if (offset !== 0 && offset !== raw.length && isContinuationByte(raw[offset])) return undefined
    return Buffer.byteLength(raw.subarray(0, offset).toString("utf8"), "utf8")
  }
  const submatches = read(data, "submatches")
  // Only rewrite keys the record actually carries — `begin`/`end`/`summary` records reach here too
  // and must keep their exact shape, or the strict union below would reject them.
  // `path` is deliberately left alone: decoding it is lossy, and a path is an identifier the
  // caller reopens, so a U+FFFD-mangled path names a file that does not exist. Such a record
  // stays in the `{bytes}` arm and is skipped. See packages/core/src/ripgrep.ts.
  const normalized = {
    ...json,
    data: {
      ...data,
      ...(lines ? { lines: { text: capText(lines.text) } } : {}),
      ...(Array.isArray(submatches)
        ? {
            submatches: submatches.slice(0, MAX_SUBMATCHES).flatMap((submatch) => {
              if (!submatch || typeof submatch !== "object") return [submatch]
              const match = decode(read(submatch, "match"))
              if (!match) return [submatch]
              const start = rebase(read(submatch, "start"))
              const end = rebase(read(submatch, "end"))
              // Endpoints are rebased independently, so ordering is checked explicitly.
              if (start === undefined || end === undefined || start > end) return []
              return [{ ...submatch, match: { text: capText(match.text) }, start, end }]
            }),
          }
        : {}),
    },
  }
  return normalized
}

/**
 * Turn ripgrep NDJSON lines into match data, skipping records that cannot be used.
 *
 * `JSON.parse` + a strict `Result.parse` on every line meant one unusable record threw out of
 * `search()` and discarded every match already collected from unrelated files — the same defect
 * fixed in packages/core/src/ripgrep.ts. Records are independent, so a bad one is dropped and
 * counted. Pure and process-free, so `test/file/ripgrep-records.test.ts` drives it directly.
 */
export function parseRecords(lines: string[]): Match["data"][] {
  const matches: Match["data"][] = []
  let skipped = 0
  for (const line of lines) {
    // Bounds parse cost per record. This path buffers all of stdout before splitting, so it does
    // not bound total memory — that needs streaming, tracked separately.
    const parsed =
      Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES ? undefined : Result.safeParse(normalizeRecord(line))
    if (!parsed?.success) {
      skipped++
      continue
    }
    if (parsed.data.type === "match") matches.push(parsed.data.data)
  }
  // Counted and reported once rather than per record: without this a ripgrep protocol change
  // would make `/find` answer `[]`, which is indistinguishable from an honest "no matches".
  if (skipped > 0) log.warn("skipped unusable ripgrep records", { skipped, total: lines.length })
  return matches
}

export type Result = z.infer<typeof Result>
export type Match = z.infer<typeof Match>
export type Begin = z.infer<typeof Begin>
export type End = z.infer<typeof End>
export type Summary = z.infer<typeof Summary>

export * as RipgrepRecords from "./ripgrep-records"
// altimate_change end
