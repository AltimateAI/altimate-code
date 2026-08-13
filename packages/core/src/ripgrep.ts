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
/** Canonical base64, so a corrupt field is left to fail decoding rather than silently becoming "". */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const readProp = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined

const normalizeData = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || "text" in value) return value
  const bytes = readProp(value, "bytes")
  // `Buffer.from` is permissive: it turns "!!!" into an empty buffer rather than throwing, which
  // would quietly manufacture a schema-valid empty match out of a corrupt record. Spelling is
  // checked first so anything unconvertible stays in the `{bytes}` arm and gets skipped instead.
  if (typeof bytes !== "string" || !BASE64.test(bytes)) return value
  return { text: Buffer.from(bytes, "base64").toString("utf8") }
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
 */
const normalizeMatch = (json: object): unknown => {
  const data = readProp(json, "data")
  if (!data || typeof data !== "object") return json
  const submatches = readProp(data, "submatches")
  return {
    ...json,
    data: {
      ...data,
      lines: normalizeData(readProp(data, "lines")),
      submatches: Array.isArray(submatches)
        ? submatches.map((submatch) =>
            submatch && typeof submatch === "object"
              ? { ...submatch, match: normalizeData(readProp(submatch, "match")) }
              : submatch,
          )
        : submatches,
    },
  }
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
      grep: (input) =>
        run<RawMatchData>({
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
            return Effect.gen(function* () {
              // Checked before JSON.parse purely to bound parse cost; `Stream.splitLines` has
              // already materialized the line, so this cannot bound memory. See MAX_RECORD_BYTES.
              if (bytes > MAX_RECORD_BYTES)
                return yield* Effect.fail(failure(`record exceeded ${MAX_RECORD_BYTES} bytes`))
              const json = yield* Effect.try({
                try: () => JSON.parse(line) as unknown,
                catch: (cause) => failure("unparseable JSON", cause),
              })
              // Non-match records (begin/end/summary) are expected and simply carry no match.
              if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match") return undefined
              const match = yield* Schema.decodeUnknownEffect(RawMatch)(normalizeMatch(json)).pipe(
                Effect.mapError((cause) => failure("unexpected match shape", cause)),
              )
              return {
                ...match.data,
                path: { text: match.data.path.text.replace(/^\.[\\/]/, "") },
                submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
              }
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("skipping unusable ripgrep record", { bytes, reason: cause.message }).pipe(
                  Effect.as(undefined),
                ),
              ),
            )
          },
          // altimate_change end
        }).pipe(
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
                text: match.lines.text.length > 2_000 ? match.lines.text.slice(0, 2_000) + "..." : match.lines.text,
                submatches: match.submatches.map((submatch) => ({
                  text: submatch.match.text,
                  start: submatch.start,
                  end: submatch.end,
                })),
              })
            }),
          ),
        ),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Layer.merge(RipgrepBinary.defaultLayer, AppProcess.defaultLayer)))
export const node = LayerNode.make(layer, [RipgrepBinary.node, AppProcess.node])
