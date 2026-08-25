export * as Ripgrep from "./ripgrep"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "path"
import { LayerNode } from "./effect/layer-node"
import { Entry, Match } from "./filesystem/schema"
import { FSUtil } from "./fs-util"
import { AppProcess, collectStream, waitForAbort } from "./process"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { RipgrepBinary } from "./ripgrep/binary"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
// altimate_change start — upstream_fix: survive oversized ripgrep JSON records.
// A single `--json` match record carries the entire matched line, so one minified bundle, source
// map, or single-line JSON/CSV fixture anywhere in the tree produces a record far past the old
// 64 KiB ceiling. That ceiling aborted the whole stream, so every other match in the search — in
// unrelated files — was lost with it. Telemetry showed 74 machines hitting this in 7 days.
//
// The ceiling never bounded memory either: `Stream.splitLines` has already materialized the full
// line by the time `parse` sees it, so the allocation is paid before the check runs. All it can
// still bound is JSON.parse cost, which is why it survives as a much higher sanity limit — 16 MiB
// clears real-world long lines by a wide margin. Bounding memory needs byte-level framing ahead of
// `splitLines`, which this does not attempt. Records past it are dropped with a warning; the search
// continues either way.
const MAX_RECORD_BYTES = 16 * 1024 * 1024
const MAX_SUBMATCHES = 100

// The 16 MiB ceiling bounds the cost of parsing ONE line. It does not bound what the search
// retains: `run` collects rows with `Stream.runCollect` and holds them until the stream ends, and
// each row carried the FULL `lines.text` until the mapping step trimmed it at the very end. Peak
// retained memory is therefore rows x record size — and callers pass no meaningful row cap
// (`tool/grep.ts` passes `Number.MAX_SAFE_INTEGER`), so raising the per-record ceiling raised the
// retained bound with it. Capping the line here instead keeps the parse ceiling while making the
// retained bound tighter than it was before this change. Nothing downstream ever renders more.
const LINE_TEXT_CAP = 2_000

/** Trim a matched line to what any consumer actually shows, preserving the elision marker. */
const capLineText = (text: string) => (text.length > LINE_TEXT_CAP ? text.slice(0, LINE_TEXT_CAP) + "..." : text)

/** Distinct skip reasons kept for the aggregate warning; enough to diagnose, bounded for logs. */
const SKIP_SAMPLES = 5
// altimate_change end

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

type RawMatchData = (typeof RawMatch.Type)["data"]

// altimate_change start — upstream_fix: accept ripgrep's `{bytes}` form of an arbitrary-data field.
// Every `path`/`lines`/`match` field in ripgrep's JSON is a union: `{"text": "..."}` when the value
// is valid UTF-8, `{"bytes": "<base64>"}` when it is not. `RawMatch` only models the `text` arm, so
// a single stray non-UTF-8 byte anywhere in the tree failed schema decoding and — inside
// `Stream.mapEffect` — took the whole search down with it, exactly like the oversized record did.
// Normalising to the `text` arm up front keeps the schema single-shape and keeps the match usable;
// `toString("utf8")` substitutes U+FFFD for the undecodable bytes rather than dropping the match.
/**
 * Canonical-base64 pre-filter, deliberately linear.
 *
 * The earlier `/^(?:[A-Za-z0-9+/]{4})*(?:..)?$/` backtracked catastrophically on
 * a large field: measured on Bun, a canonical 4 MiB body returns FALSE (valid
 * data silently discarded) and on Node it raises `RangeError`, which escapes as
 * a defect and aborts the whole search — the exact failure this change exists to
 * remove, reintroduced for large non-UTF-8 lines. A single character class with
 * one quantifier has no nested repetition to backtrack: 16 MiB in ~10ms.
 *
 * Length-mod-4 restores what the `{4}` grouping guaranteed. Exact canonical form
 * is still enforced by the round-trip check in the decoder below.
 */
const BASE64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/
const isBase64 = (value: string) => value.length % 4 === 0 && BASE64_SHAPE.test(value)

/** ripgrep's control records. Anything else with an unrecognised `type` is a protocol surprise. */
const CONTROL_TYPES = new Set(["begin", "end", "summary"])

const readProp = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined

/**
 * Decode one ripgrep arbitrary-data field (`{text}` or `{bytes}`) to a string.
 *
 * Returns undefined when the field cannot be trusted, which leaves the original shape in place so
 * the schema rejects it and the record is skipped — the point being that a corrupt field must never
 * be silently converted into a valid-looking empty one. `Buffer.from` makes that easy to get wrong:
 * it maps unconvertible input to an EMPTY buffer instead of throwing. Hence three guards — reject
 * the empty string (a matched line is never empty, so an empty `bytes` arm is always corrupt),
 * check the spelling, then require the decode to round-trip so non-canonical padding bits (`Zh==`
 * and `Zg==` both decode to "f") cannot slip through.
 *
 * `raw` is returned alongside so submatch offsets can be rebased; see `normalizeMatch`.
 */
const decodeField = (value: unknown): { text: string; raw?: Buffer } | undefined => {
  if (!value || typeof value !== "object") return undefined
  const text = readProp(value, "text")
  if (typeof text === "string") return { text }
  const bytes = readProp(value, "bytes")
  if (typeof bytes !== "string" || bytes.length === 0 || !isBase64(bytes)) return undefined
  const raw = Buffer.from(bytes, "base64")
  if (raw.toString("base64") !== bytes) return undefined
  return { text: raw.toString("utf8"), raw }
}

/**
 * Rewrite the `{bytes}` arm of a raw ripgrep match record into its `{text}` equivalent.
 *
 * `path` is deliberately NOT rewritten. Decoding it is lossy — `toString("utf8")` maps undecodable
 * bytes to U+FFFD — and a path is an identifier, not display text: the caller resolves it, stats it
 * and reopens it, so a lossy path is a path to a file that does not exist, and two distinct
 * filenames can collapse onto the same string. Leaving it in the `{bytes}` arm fails the schema, so
 * a match in a file whose NAME is not valid UTF-8 is skipped and logged. Match content is display
 * text, so lossy decoding there is the right trade: the match stays useful.
 *
 * Submatch `start`/`end` are BYTE offsets into the raw line. A lossy decode destroys that frame of
 * reference — each undecodable sequence becomes U+FFFD, three bytes wide — so they are rebased onto
 * the decoded text's own UTF-8 encoding. That preserves the established byte-offset contract rather
 * than silently switching these records to a different unit: without it, a line beginning with one
 * bad byte reports `needle` at [3,9) of a string where [3,9) reads "edle t".
 */
const normalizeMatch = (json: object): unknown => {
  const data = readProp(json, "data")
  if (!data || typeof data !== "object") return json
  const lines = decodeField(readProp(data, "lines"))
  if (!lines) return json
  const raw = lines.raw
  // Submatch `start`/`end` are BYTE offsets into the RAW line, so a lossy decode invalidates them:
  // every undecodable byte widens to a 3-byte U+FFFD. They are rebased onto the decoded text's own
  // UTF-8 encoding, which keeps the established byte-offset contract instead of switching these
  // records to a different unit.
  //
  // A rebase is only sound when the split point is a character boundary of the whole-buffer decode.
  // Testing that by decoded-string comparison is NOT enough: for a raw line where an invalid byte
  // precedes a literal U+FFFD, an offset inside that literal character still produces a decoded
  // prefix that prefixes the line, because the replacement characters alias. Byte-boundary
  // validation has no such blind spot — a continuation byte (0b10xxxxxx) at the offset means the
  // split lands inside a sequence. Measured over 3.4M fuzzed offsets against the definition
  // (decoding both halves must reconstruct the whole) this never accepts an unsafe offset; it only
  // errs conservatively, on lines that begin mid-sequence.
  //
  // An offset that cannot be rebased drops ITS SUBMATCH, not the record: the file, line and text
  // are still correct and useful, and this whole change exists to stop losing matches. `{text}`-arm
  // offsets are not rebased — there is nothing to rebase onto — but they are validated the same
  // way, because returning a coordinate pair that indexes nothing, or that splits a character, is
  // itself a claim.
  const isContinuationByte = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80
  // Encoded once per record and shared by every submatch. This also supplies the byte length, so it
  // replaces a `Buffer.byteLength` walk rather than adding one; the extra cost is the allocation.
  const textBytes = raw ?? Buffer.from(lines.text, "utf8")
  const rebase = (offset: unknown): number | undefined => {
    // `{text}` arm: nothing is rebased, but the offset must still be addressable AND land on a
    // character boundary. A byte offset can fall inside a multi-byte sequence — for `éa` the byte
    // offset 1 splits `é` — and a consumer slicing the line's UTF-8 encoding there gets invalid
    // bytes. ripgrep never emits such an offset for a valid-UTF-8 line, so rejecting it drops
    // nothing legitimate. Same rule the `{bytes}` arm applies below.
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
  const submatches = readProp(data, "submatches")
  const normalized = {
    ...json,
    data: {
      ...data,
      // Capped here rather than after decoding: the full line is retained by `Stream.runCollect`
      // until the search ends, and nothing downstream ever shows more than this. See LINE_TEXT_CAP.
      lines: { text: capLineText(lines.text) },
      // Sliced BEFORE decoding so a pathological submatch count is not decoded only to be dropped.
      submatches: Array.isArray(submatches)
        ? submatches.slice(0, MAX_SUBMATCHES).flatMap((submatch) => {
            if (!submatch || typeof submatch !== "object") return [submatch]
            const match = decodeField(readProp(submatch, "match"))
            if (!match) return [submatch]
            // A broad pattern such as `x.*` makes ripgrep repeat almost the whole line here, so the
            // matched text needs the same bound as the line or the retained-memory cap is defeated
            // by the submatches instead.
            const decoded = { ...submatch, match: { text: capLineText(match.text) } }
            const start = rebase(readProp(submatch, "start"))
            const end = rebase(readProp(submatch, "end"))
            // Endpoints are rebased independently, so ordering is checked explicitly: an inverted
            // range is not a usable coordinate pair even when both endpoints are addressable.
            return start === undefined || end === undefined || start > end ? [] : [{ ...decoded, start, end }]
          })
        : submatches,
    },
  }
  return normalized
}
// altimate_change end

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  // altimate_change start — upstream_fix: preserve all debug rg search --glob entries
  readonly include?: string | readonly string[]
  // altimate_change end
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* process.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )
          const truncated = rows.length > input.limit
          if (truncated) return { items: rows.slice(0, input.limit), truncated, partial: false }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            // altimate_change start — upstream_fix: keep child stderr attributable to ripgrep.
            // Reporting stderr verbatim made shell-level failures (e.g. a Windows "not recognized"
            // message) look like they came from the tool itself, with no hint of the real source.
            return yield* failure(`ripgrep failed with code ${code}: ${stderr.trim() || "no output"}`)
            // altimate_change end
          }
          return { items: code === 1 ? [] : rows, truncated: false, partial: code === 2 }
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    return Service.of({
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) =>
            Effect.succeed(
              line
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/"),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((relative) => {
              const absolute = path.resolve(input.cwd, relative)
              return new Entry({
                path: RelativePath.make(relative),
                type: "file",
                mime: FSUtil.mimeType(absolute),
              })
            }),
          ),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = line
              .replace(/^(?:\.[\\/])+/u, "")
              .replace(/^[\\/]+/u, "")
              .replaceAll("\\", "/")
            return Effect.succeed(
              new Entry({
                path: RelativePath.make(relative),
                type: "file",
                mime: FSUtil.mimeType(path.resolve(input.cwd, relative)),
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(
          Effect.map((result) => result.items),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      // altimate_change start — upstream_fix: tally skipped records for one aggregate warning.
      // Upstream returns `run(...)` directly. `Effect.suspend` — rather than a plain block body —
      // is what makes the tally per EXECUTION: an Effect is a value that can be run more than once
      // and concurrently, so a tally captured when the Effect is built would accumulate across runs
      // and over-report.
      //
      // The marked region covers the whole implementation rather than just these lines, because the
      // wrapper re-indents every line of the body: an upstream change anywhere in here genuinely
      // needs manual reconciliation, which is exactly what the marker is for.
      grep: (input) =>
        Effect.suspend(() => {
          const skipped: { count: number; samples: string[] } = { count: 0, samples: [] }
          return run<RawMatchData>({
            ...input,
            args: [
              "--no-config",
              "--json",
              "--hidden",
              "--no-messages",
              // altimate_change start — upstream_fix: preserve all debug rg search --glob entries
              ...(typeof input.include === "string"
                ? [`--glob=${input.include}`]
                : (input.include ?? []).map((pattern) => `--glob=${pattern}`)),
              // altimate_change end
              "--glob=!**/.git/**",
              "--",
              input.pattern,
              input.file ?? ".",
            ],
            // altimate_change start — upstream_fix: a bad record skips itself, never the search.
            // `parse` runs inside `Stream.mapEffect`, so ANY failure here aborts the whole stream and
            // discards every match already collected from unrelated files. A record is independent of
            // its neighbours, so none of the three ways one can be unusable — oversized, unparseable
            // JSON, or schema-rejected — justifies destroying the rest of the search.
            parse: (line) => {
              const bytes = Buffer.byteLength(line, "utf8")
              // Captured during the walk so the aggregate warning can name a file when one is
              // recoverable. Malformed JSON has no path by definition, hence "when present".
              let where: string | undefined
              return Effect.gen(function* () {
                // Checked before JSON.parse purely to bound parse cost; `Stream.splitLines` has
                // already materialized the line, so this cannot bound memory. See MAX_RECORD_BYTES.
                if (bytes > MAX_RECORD_BYTES)
                  return yield* Effect.fail(failure(`record exceeded ${MAX_RECORD_BYTES} bytes`))
                const json = yield* Effect.try({
                  try: () => JSON.parse(line) as unknown,
                  catch: (cause) => failure("unparseable JSON", cause),
                })
                if (!json || typeof json !== "object" || !("type" in json))
                  return yield* Effect.fail(failure("record has no type"))
                // Captured before the type check so an unrecognised record can still name its file.
                const pathField = readProp(readProp(json, "data"), "path")
                const pathText = readProp(pathField, "text")
                if (typeof pathText === "string") where = pathText
                // Control records are expected and simply carry no match. An unrecognised type is a
                // protocol surprise and is counted rather than dropped on the floor, so a ripgrep
                // change cannot quietly turn every match into "no matches".
                if (json.type !== "match")
                  return typeof json.type === "string" && CONTROL_TYPES.has(json.type)
                    ? undefined
                    : yield* Effect.fail(failure(`unrecognised record type ${JSON.stringify(json.type)}`))
                // `normalizeMatch` is plain synchronous code. A throw there would be a DEFECT,
                // which `Effect.catch` deliberately does not catch — so it would abort the
                // stream rather than skip one record, defeating the point of this change.
                const normalized = yield* Effect.try({
                  try: () => normalizeMatch(json),
                  catch: (cause) => failure("record could not be normalized", cause),
                })
                const match = yield* Schema.decodeUnknownEffect(RawMatch)(normalized).pipe(
                  Effect.mapError((cause) => failure("unexpected match shape", cause)),
                )
                // `normalizeMatch` already caps submatches and line text, so nothing is re-trimmed.
                return { ...match.data, path: { text: match.data.path.text.replace(/^\.[\\/]/, "") } }
              }).pipe(
                Effect.catch((cause) =>
                  Effect.sync(() => {
                    skipped.count++
                    if (skipped.samples.length < SKIP_SAMPLES)
                      skipped.samples.push(where ? `${cause.message} (${where})` : cause.message)
                    return undefined
                  }),
                ),
              )
            },
            // altimate_change end
          }).pipe(
            // altimate_change start — upstream_fix: one aggregate warning per search, not per record.
            // A systematic protocol mismatch rejects every record in the tree, and a per-record log
            // would bury the machine in noise while still answering with an innocent-looking empty
            // result — the very failure this change exists to prevent.
            // `onExit` rather than `tap`: a search that fails or is interrupted part-way is exactly
            // when the diagnostic matters, and `tap` would discard the tally in both cases.
            Effect.onExit(() =>
              skipped.count > 0
                ? Effect.logWarning("skipped unusable ripgrep records", {
                    skipped: skipped.count,
                    reasons: skipped.samples,
                  })
                : Effect.void,
            ),
            // altimate_change end
            Effect.map((result) =>
              result.items.map((match) => {
                const relative = match.path.text
                  .replace(/^(?:\.[\\/])+/u, "")
                  .replace(/^[\\/]+/u, "")
                  .replaceAll("\\", "/")
                const absolute = path.resolve(input.cwd, relative)
                return new Match({
                  entry: new Entry({
                    path: RelativePath.make(relative),
                    type: "file",
                    mime: FSUtil.mimeType(absolute),
                  }),
                  line: match.line_number,
                  offset: match.absolute_offset,
                  // altimate_change start — upstream_fix: capped at parse time, see LINE_TEXT_CAP.
                  // Re-applied here so the cap still holds if the parser ever stops trimming.
                  text: capLineText(match.lines.text),
                  // altimate_change end
                  submatches: match.submatches.map((submatch) => ({
                    text: submatch.match.text,
                    start: submatch.start,
                    end: submatch.end,
                  })),
                })
              }),
            ),
          )
        }),
      // altimate_change end — closes the grep block opened above for the skip tally.
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Layer.merge(RipgrepBinary.defaultLayer, AppProcess.defaultLayer)))
export const node = LayerNode.make(layer, [RipgrepBinary.node, AppProcess.node])
