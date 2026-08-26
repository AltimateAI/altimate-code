/**
 * Adversarial coverage for the v0.9.7 release payload (v0.9.6..HEAD, 7 commits
 * + review-driven fixes).
 *
 * This release already has substantial NEW dedicated adversarial coverage
 * added elsewhere this cycle, which this file deliberately does NOT duplicate:
 *  - packages/opencode/test/altimate/workspace/browser-handoff.test.ts
 *    (DNS-rebinding Host-header + AbortSignal cancellation, 18 tests)
 *  - packages/opencode/test/provider/provider.test.ts
 *    (malformed-catalog-entry regression, 593 tests total in test/provider/)
 *  - packages/opencode/test/plugin/codex-allowlist.test.ts
 *    (gpt-5.5/5.6 allowlist, 26+ tests)
 *  - packages/opencode/test/skill/tracker-leak-check.test.ts (34 tests)
 *
 * This file focuses on the two remaining high-risk areas from this release
 * that did not yet have adversarial-style coverage:
 *
 *  1. Ripgrep record-level error isolation (commit ca9b34a523) — the `parse`
 *     function in packages/core/src/ripgrep.ts now skips unusable records
 *     (oversized, unparseable JSON, schema-rejected) instead of failing the
 *     whole stream, and normalizes ripgrep's `{bytes}` vs `{text}` union.
 *
 *     packages/core/test/ripgrep.test.ts (452 lines) already covers a LOT of
 *     this ground exhaustively — the exact 16 MiB ceiling (both sides), a
 *     single unparseable/truncated record, a non-base64 `lines.bytes`, an
 *     empty `bytes` field, non-canonical base64 padding, a non-UTF-8 `path`,
 *     multi-byte offset rebasing/dropping, control-record handling, and an
 *     "everything is unusable" case. Rather than restate any of that, the
 *     cases below are the genuine gaps found after reading that file in
 *     full: a malformed (non-base64-shaped, not just empty) `path.bytes`
 *     specifically, a top-level JSON array, grossly wrong field types
 *     (numbers/objects where strings/arrays are expected), a longer run of
 *     MIXED consecutive bad records surrounding good ones (order/off-by-one),
 *     and a structurally-invalid (not just non-ASCII) UTF-8 byte sequence.
 *
 *     Note: the historical bug this release fixes was pinned to a 64 KiB
 *     ceiling (see the comment in ripgrep.ts); the CURRENT ceiling is 16 MiB,
 *     and the exact boundary (16 MiB / 16 MiB + 1) is already pinned by
 *     "accepts a record at exactly the size ceiling and skips one byte over"
 *     in the existing suite, so it is intentionally not repeated here.
 *
 *  2. Memory refresh + memory-read overlay (commit 33eae333c2) —
 *     packages/opencode/src/memory/tools/memory-refresh.ts,
 *     packages/opencode/src/memory/tools/memory-read.ts, and the
 *     `mergeOverlay` export `prompt.ts` introduced.
 *
 *     packages/opencode/test/memory/overlay-merge.test.ts (479 lines) already
 *     drives `refresh` on a session that was never hydrated (the "unlinked"
 *     case), a failed refresh that must preserve prior state, two concurrent
 *     refreshes where one fails, and "local wins" through the FULL injection
 *     stack. The gaps closed below are: `mergeOverlay` exercised directly as
 *     a pure unit (empty/malformed overlay data, duplicate ids, a missing
 *     required field) rather than through the full tool chain, two
 *     concurrently-SUCCESSFUL refreshes (the existing test only exercises the
 *     one-fails-one-succeeds case), and `altimate_memory_read` given a scope
 *     value that is scope-shaped but not one of the three valid values —
 *     which turned out to already be rejected by schema validation before
 *     the handler runs (a stronger guarantee than expected going in; see the
 *     test's own comment for the trace through tool.ts).
 *
 * House style: no `mock.module()`; per-test state, no timers, no shared
 * mutable fixtures across tests.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { AppProcess } from "@opencode-ai/core/process"
import { RelativePath } from "@opencode-ai/core/schema"

// ============================================================================
// Part 1 — Ripgrep record-level error isolation (ca9b34a523)
// ============================================================================

describe("v0.9.7 release: ripgrep record-level error isolation", () => {
  // Self-contained tmp dir helper — deliberately not importing
  // packages/core's test/fixture/tmpdir.ts, which is not part of that
  // package's published surface.
  async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-v097-adversarial-")))
    try {
      return await fn(dir)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  const matchRecord = (file: string, overrides: Record<string, unknown> = {}) =>
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

  /** Mirrors the aggregate-warning capture in packages/core/test/ripgrep.test.ts
   * so skip counts can be asserted without depending on it. */
  const skipWarnings: Array<{ skipped?: number; reasons?: string[] }> = []
  const captureWarnings = Logger.layer([
    Logger.formatStructured.pipe(
      Logger.map((entry): void => {
        const parts: unknown[] = Array.isArray(entry.message) ? entry.message : [entry.message]
        if (parts[0] !== "skipped unusable ripgrep records") return
        const data = parts[1]
        if (!data || typeof data !== "object") return
        const skipped = Reflect.get(data, "skipped")
        const reasons = Reflect.get(data, "reasons")
        skipWarnings.push({
          skipped: typeof skipped === "number" ? skipped : undefined,
          reasons: Array.isArray(reasons) ? reasons.map(String) : undefined,
        })
      }),
    ),
  ])

  beforeEach(() => {
    skipWarnings.length = 0
  })

  const lastSkip = () => skipWarnings.at(-1)

  // Real ripgrep cannot be coerced into emitting an arbitrary, chosen bad
  // record, so — exactly as the existing suite does — a stub `rg` prints
  // exactly the NDJSON given. Only the executable is stubbed; spawn, decode,
  // line splitting, parse, collection and output mapping all still run.
  const stubTest = test.skipIf(process.platform === "win32")

  const grepWithStubbedRecords = (records: string[]) =>
    withTmpDir(async (tmp) => {
      const data = path.join(tmp, "records.jsonl")
      await fs.writeFile(data, records.join("\n") + "\n")
      const stub = path.join(tmp, "rg")
      await fs.writeFile(stub, `#!/bin/sh\ncat ${JSON.stringify(data)}\n`)
      await fs.chmod(stub, 0o755)

      return Effect.runPromise(
        Effect.gen(function* () {
          const rg = yield* Ripgrep.Service
          return yield* rg.grep({ cwd: tmp, pattern: "needle", limit: 100 })
        }).pipe(
          Effect.provide(
            Ripgrep.layer.pipe(
              Layer.provide(
                Layer.succeed(RipgrepBinary.Service, RipgrepBinary.Service.of({ filepath: Effect.succeed(stub) })),
              ),
              Layer.provide(AppProcess.defaultLayer),
            ),
          ),
          Effect.provide(captureWarnings),
        ),
      )
    })

  // Existing suite covers `lines.bytes` with invalid base64 shape ("!!!not
  // base64!!!"). `path` is a distinct code path — it is never rewritten by
  // normalizeMatch (see the comment on that function: a path is an
  // identifier the caller reopens, so a lossy decode must never happen) — so
  // a path whose bytes are malformed in a way that still LOOKS like it might
  // decode (not merely empty) must fail schema validation and be skipped,
  // never surface as an empty or undefined path.
  stubTest("skips a record whose path.bytes is malformed base64, without a phantom path", async () => {
    const matches = await grepWithStubbedRecords([
      matchRecord("a.txt"),
      matchRecord("ignored", { path: { bytes: "!!!garbage-not-base64!!!" } }),
      matchRecord("c.txt"),
    ])

    expect(matches.map((item) => item.entry.path)).toEqual([RelativePath.make("a.txt"), RelativePath.make("c.txt")])
    // No third entry with an empty, "undefined", or otherwise fabricated path.
    expect(matches).toHaveLength(2)
    expect(matches.every((m) => m.entry.path.length > 0)).toBe(true)
  })

  // `typeof [] === "object"`, so a top-level JSON array passes the
  // `typeof json !== "object"` guard and must be caught by the `"type" in
  // json` check instead. Never exercised directly in the existing suite,
  // which only tries `{}` and a string with an unrecognised `type` value.
  stubTest("treats a top-level JSON array as an unusable record, not a fatal one", async () => {
    const matches = await grepWithStubbedRecords([matchRecord("a.txt"), "[1,2,3]", matchRecord("b.txt")])

    expect(matches.map((item) => item.entry.path)).toEqual([RelativePath.make("a.txt"), RelativePath.make("b.txt")])
    expect(lastSkip()?.skipped).toBe(1)
    expect(lastSkip()?.reasons).toEqual(["record has no type"])
  })

  // `path` as a raw number rather than an object entirely bypasses
  // `decodeField` (which only special-cases `{bytes}`/`{text}`), so it must
  // be caught by RawMatch's own schema decode instead.
  stubTest("skips a record whose path field is a number, not an object", async () => {
    const matches = await grepWithStubbedRecords([
      matchRecord("a.txt"),
      matchRecord("ignored", { path: 42 }),
      matchRecord("b.txt"),
    ])

    expect(matches.map((item) => item.entry.path)).toEqual([RelativePath.make("a.txt"), RelativePath.make("b.txt")])
    expect(lastSkip()?.reasons).toEqual(["unexpected match shape"])
  })

  // `line_number`/`absolute_offset` are schema'd as PositiveInt/NonNegativeInt
  // (actual numbers). A numeric-LOOKING string must still be rejected, not
  // coerced — JS's automatic string->number coercion elsewhere in the
  // codebase makes this an easy invariant to lose silently.
  stubTest("skips a record whose line_number is a numeric string instead of a number", async () => {
    const matches = await grepWithStubbedRecords([
      matchRecord("a.txt"),
      matchRecord("ignored", { line_number: "1" }),
      matchRecord("b.txt"),
    ])

    expect(matches.map((item) => item.entry.path)).toEqual([RelativePath.make("a.txt"), RelativePath.make("b.txt")])
  })

  // `submatches` as an object rather than an array: `normalizeMatch` leaves a
  // non-array `submatches` untouched (`Array.isArray(submatches) ? ... :
  // submatches`), so the record must be caught by RawMatch's
  // `Schema.Array(...)` decode, not crash inside the array-only mapping code.
  stubTest("skips a record whose submatches field is an object, not an array", async () => {
    const matches = await grepWithStubbedRecords([
      matchRecord("a.txt"),
      matchRecord("ignored", { submatches: { 0: { match: { text: "needle" }, start: 0, end: 6 } } }),
      matchRecord("b.txt"),
    ])

    expect(matches.map((item) => item.entry.path)).toEqual([RelativePath.make("a.txt"), RelativePath.make("b.txt")])
  })

  // A longer, MIXED run of bad records (four different failure reasons)
  // surrounding good ones on both sides. The existing suite's closest case
  // ("ignores control records but counts...") only ever has bad records
  // adjacent to ONE good record on each side and never more than two bad
  // records total; this pins that there is no off-by-one when several
  // different kinds of corruption are interleaved, and that the aggregate
  // count/reasons stay attributable.
  stubTest("surfaces every good record around a run of differently-broken ones, with no off-by-one", async () => {
    const matches = await grepWithStubbedRecords([
      matchRecord("a.txt"),
      '{"type":"match","data":{"path":{"text":"./trunc.t', // unparseable JSON
      matchRecord("ignored-1", { path: 42 }), // schema-rejected
      "[1,2,3]", // no "type" at all
      matchRecord("b.txt"),
      JSON.stringify({ type: "weird-v3", data: {} }), // unrecognised type
      matchRecord("c.txt"),
    ])

    expect(matches.map((item) => item.entry.path)).toEqual([
      RelativePath.make("a.txt"),
      RelativePath.make("b.txt"),
      RelativePath.make("c.txt"),
    ])
    expect(lastSkip()?.skipped).toBe(4)
  })

  // Existing coverage exercises single stray high-bit bytes and specific
  // 2/3-byte sequences (é boundary splits, a literal U+FFFD, etc). This adds
  // a STRUCTURALLY invalid sequence of a different shape: an overlong
  // encoding (0xC0 0xAF, an invalid encoding of '/), which is invalid UTF-8
  // for a reason distinct from "byte 0xff" — it is a well-formed-looking
  // multi-byte lead/continuation pair that decodes to nothing valid.
  stubTest("decodes an overlong UTF-8 encoding to replacement characters without crashing", async () => {
    const raw = Buffer.concat([Buffer.from([0xc0, 0xaf]), Buffer.from("needle tail\n")])
    const matches = await grepWithStubbedRecords([
      matchRecord("a.txt", {
        lines: { bytes: raw.toString("base64") },
        submatches: [],
      }),
    ])

    expect(matches).toHaveLength(1)
    expect(matches[0].text).toContain("needle")
    expect(matches[0].text).toContain("tail")
    expect(matches[0].text).toContain("�")
  })
})

// ============================================================================
// Part 2 — Memory refresh + memory-read overlay (33eae333c2)
// ============================================================================

describe("v0.9.7 release: mergeOverlay as a pure unit", () => {
  // mergeOverlay has no dependency on the ALTIMATE_WORKSPACE flag or on any
  // sandboxed filesystem state — it is a pure array transform — so it is
  // exercised directly with hand-built (including malformed) inputs rather
  // than through hydrate/refresh/the tool chain, per the "narrowest testable
  // unit" guidance used for provider.ts elsewhere this cycle.
  let mergeOverlay: (typeof import("../../src/memory/prompt"))["mergeOverlay"]

  beforeEach(async () => {
    ;({ mergeOverlay } = await import("../../src/memory/prompt"))
  })

  const local = (id: string, updated: string, content = "LOCAL") => ({
    id,
    scope: "global" as const,
    tags: [] as string[],
    content,
    created: updated,
    updated,
  })

  const remote = (id: string, updated: string, content = "REMOTE", extra: Record<string, unknown> = {}) => ({
    id,
    scope: "global" as const,
    tags: [] as string[],
    content,
    created: updated,
    updated,
    remote: true as const,
    ...extra,
  })

  test("empty overlay returns local untouched", () => {
    expect(mergeOverlay([], [])).toEqual([])
    const locals = [local("a", "2026-01-01")]
    expect(mergeOverlay(locals, [])).toBe(locals as any)
  })

  test("local wins when local and remote share scope+id", () => {
    const merged = mergeOverlay([local("warehouse/sizing", "2026-01-01", "LOCAL FACT")], [
      remote("warehouse/sizing", "2026-06-01", "REMOTE FACT"),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0].content).toBe("LOCAL FACT")
  })

  test("a sibling-origin remote block survives an id collision instead of being dropped", () => {
    const merged = mergeOverlay(
      [local("warehouse/sizing", "2026-01-01", "LOCAL FACT")],
      [remote("warehouse/sizing", "2026-06-01", "SIBLING FACT", { origin: "other-repo" })],
    )

    expect(merged).toHaveLength(2)
    expect(merged.map((b) => b.content).sort()).toEqual(["LOCAL FACT", "SIBLING FACT"])
  })

  test("merge sorts newest-first across local and remote regardless of origin", () => {
    const merged = mergeOverlay(
      [local("old", "2020-01-01", "OLD LOCAL")],
      [remote("new", "2026-01-01", "NEW REMOTE")],
    )
    expect(merged.map((b) => b.id)).toEqual(["new", "old"])
  })

  // GAP: mergeOverlay dedupes a remote block only against LOCAL keys
  // (`localKeys.has(...)`); it never checks a remote block against blocks it
  // has already pushed from the SAME remote list. Two remote entries sharing
  // one non-sibling scope+id — which a corrupted or duplicated overlay fetch
  // could produce — both survive into the merged output. This is a genuine
  // finding, not a test bug: flagged in the task report rather than patched
  // here, since fixing production behavior is out of scope for a test-only
  // task.
  test("FINDING: duplicate ids WITHIN the remote list are not deduplicated against each other", () => {
    const merged = mergeOverlay(
      [],
      [remote("dup", "2026-01-01", "FIRST COPY"), remote("dup", "2026-01-02", "SECOND COPY")],
    )
    // Documents current behavior: both copies survive as separate entries.
    expect(merged).toHaveLength(2)
    expect(merged.map((b) => b.content).sort()).toEqual(["FIRST COPY", "SECOND COPY"])
  })

  // FINDING: mergeOverlay's final sort — `b.updated.localeCompare(a.updated)`
  // — assumes every block (local AND remote) carries a string `updated`.
  // Every REAL remote block is guaranteed one by `toBlock()` (which falls
  // back to `record.updated_at` and then `new Date().toISOString()`), so
  // this is not reachable through the production hydrate/refresh path today.
  // But `mergeOverlay` itself is exported and offers no defense of its own:
  // a remote block object missing `updated` (e.g. a future caller building
  // RemoteMemoryBlock by hand, or a corrupted overlay cache) throws a
  // TypeError out of the merge instead of degrading gracefully — the exact
  // "deterministic, non-crashing merge" property the task asked to verify
  // does NOT currently hold for malformed overlay data at the mergeOverlay
  // layer. The memory-read tool happens to catch this (its whole body is
  // wrapped in try/catch) and downgrades it to an error response rather than
  // crashing the process, but that is accidental defense-in-depth one layer
  // up, not a property of mergeOverlay. Reported prominently rather than
  // silently patched.
  test("FINDING: a remote block missing `updated` throws out of the sort, not a graceful merge", () => {
    // `Array.prototype.sort` never invokes its comparator for a single-element
    // array, so the malformed block needs a peer to sort against — exactly
    // the realistic shape (one good block, one corrupt one in the same
    // overlay fetch).
    const malformed = { ...remote("bad", "irrelevant"), updated: undefined as unknown as string }
    const healthy = remote("fine", "2026-01-01", "FINE")
    expect(() => mergeOverlay([], [malformed, healthy])).toThrow(TypeError)
  })
})

describe("v0.9.7 release: memory-read scope type confusion", () => {
  const ORIGINAL_DATA = process.env.XDG_DATA_HOME
  const ORIGINAL_STATE = process.env.XDG_STATE_HOME
  const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
  let sandbox: string

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `altimate-scope-confusion-${process.pid}-`))
    await fs.mkdir(path.join(sandbox, "data"), { recursive: true })
    await fs.mkdir(path.join(sandbox, "state"), { recursive: true })
    process.env.XDG_DATA_HOME = path.join(sandbox, "data")
    process.env.XDG_STATE_HOME = path.join(sandbox, "state")
    process.env.ALTIMATE_WORKSPACE = "1"
  })

  afterEach(async () => {
    if (ORIGINAL_DATA === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = ORIGINAL_DATA
    if (ORIGINAL_STATE === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = ORIGINAL_STATE
    if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
    else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
    await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {})
  })

  // Working assumption going in was that test/altimate/tool-fixture's
  // initTool() — which calls `def.execute(args, ctx)` directly — bypasses the
  // zod schema, since most call sites construct `execute` from the raw
  // `Tool.define` init. That assumption was WRONG and worth recording: in
  // packages/opencode/src/tool/tool.ts, `wrap()` closes over
  // `Schema.decodeUnknownEffect(toolInfo.parameters)` and replaces
  // `toolInfo.execute` with a version that decodes `args` FIRST and rejects
  // with `InvalidArgumentsError` before the handler body — including the
  // scope filtering logic — ever runs. That wrapping happens once, in
  // `toolInfo()`/`initTool()` itself (see tool-fixture.ts calling
  // `tool.pipe(Effect.provide(toolLayer))` then `info.init()`), so a test
  // calling `execute()` directly is going through the SAME schema gate a real
  // tool call would. This is good news: there is no reachable path — test or
  // production — where a scope-shaped-but-invalid value reaches the handler's
  // own `args.scope !== "all"` check at all. It is rejected one layer
  // earlier, which is a stronger guarantee than the handler's own filtering.
  test("an unknown scope value is rejected by schema validation before the handler ever runs", async () => {
    const { initTool } = await import("../altimate/tool-fixture")
    const { MemoryReadTool } = await import("../../src/memory/tools/memory-read")
    const { hydrate, resetOverlay, syncInternals } = await import("../../src/altimate/workspace/memory-sync")
    const { AltimateApi } = await import("../../src/altimate/api/client")
    const { MIRROR_SOURCE } = await import("../../src/altimate/workspace/memory-api")

    const originalIsConfigured = AltimateApi.isConfigured
    const originalGetCreds = AltimateApi.getCredentials
    const originalFetch = globalThis.fetch
    const SES = "ses_scope_confusion"
    const NOW = "2026-08-19T00:00:00.000Z"

    const remoteRecord = {
      id: "rec-secret",
      memory: "SECRET WORKSPACE MEMORY THAT MUST NOT LEAK",
      created_at: NOW,
      updated_at: NOW,
      metadata: { source: MIRROR_SOURCE, block_id: "secret/block", block_scope: "global" },
    }

    ;(AltimateApi as any).isConfigured = async () => true
    ;(AltimateApi as any).getCredentials = async () => ({
      altimateInstanceName: "acme",
      altimateUrl: "https://api.example.com",
      altimateApiKey: "key",
    })
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      const payload = url.includes("/datamates/memory/list")
        ? [remoteRecord]
        : url.includes("/datamates/")
          ? { datamates: [{ id: 7, name: "acme", memory_enabled: true }] }
          : { message: "ok" }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof fetch
    syncInternals.resolveBinding = async () => ({
      datamateId: 7,
      datamateName: "acme",
      repoRemote: "ssh://git@github.com/acme/analytics.git",
      projectPath: "/work/analytics",
      linkedAt: 1,
    })
    resetOverlay()

    try {
      await hydrate(SES)

      const tool = await initTool(MemoryReadTool)

      // Positive control: a genuinely valid scope surfaces the remote block.
      const valid: any = await tool.execute({ scope: "all" }, { sessionID: SES, agent: "build" })
      expect(String(valid.output)).toContain("SECRET WORKSPACE MEMORY")

      // The actual case under test: a scope value that is a string (so it is
      // "scope-shaped") but not one of the three valid enum members. Schema
      // validation must reject the call outright — it must not reach the
      // handler and it must not leak the secret block in any partial result.
      let bogusRejected = false
      try {
        await tool.execute({ scope: "public" as any }, { sessionID: SES, agent: "build" })
      } catch (e) {
        bogusRejected = true
        expect(String(e)).not.toContain("SECRET WORKSPACE MEMORY")
      }
      expect(bogusRejected).toBe(true)

      // Also try an outright type-confused value (an array, not a string).
      // Same requirement: rejected, never a leak.
      let arrayRejected = false
      try {
        await tool.execute({ scope: ["global", "project"] as any }, { sessionID: SES, agent: "build" })
      } catch (e) {
        arrayRejected = true
        expect(String(e)).not.toContain("SECRET WORKSPACE MEMORY")
      }
      expect(arrayRejected).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      ;(AltimateApi as any).isConfigured = originalIsConfigured
      ;(AltimateApi as any).getCredentials = originalGetCreds
      delete syncInternals.resolveBinding
      resetOverlay()
    }
  })
})

describe("v0.9.7 release: memory refresh concurrency", () => {
  const ORIGINAL_DATA = process.env.XDG_DATA_HOME
  const ORIGINAL_STATE = process.env.XDG_STATE_HOME
  const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
  let sandbox: string

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `altimate-refresh-concurrency-${process.pid}-`))
    await fs.mkdir(path.join(sandbox, "data"), { recursive: true })
    await fs.mkdir(path.join(sandbox, "state"), { recursive: true })
    process.env.XDG_DATA_HOME = path.join(sandbox, "data")
    process.env.XDG_STATE_HOME = path.join(sandbox, "state")
    process.env.ALTIMATE_WORKSPACE = "1"
  })

  afterEach(async () => {
    if (ORIGINAL_DATA === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = ORIGINAL_DATA
    if (ORIGINAL_STATE === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = ORIGINAL_STATE
    if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
    else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
    await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {})
  })

  // The existing suite's "two concurrent refreshes cannot discard the real
  // overlay" test only exercises the one-succeeds-one-fails case. This
  // covers the more common shape: two overlapping refreshes that BOTH
  // succeed (e.g. the user mashes a refresh action, or an agent calls the
  // tool twice in the same turn) must not double-append blocks or leave the
  // overlay in a state that depends on which of the two finished last, since
  // both fetch the same underlying list.
  test("two concurrent successful refreshes settle on one consistent, non-duplicated overlay", async () => {
    const { hydrate, refresh, resetOverlay, overlayBlocks, syncInternals } = await import(
      "../../src/altimate/workspace/memory-sync"
    )
    const { AltimateApi } = await import("../../src/altimate/api/client")
    const { MIRROR_SOURCE } = await import("../../src/altimate/workspace/memory-api")

    const originalIsConfigured = AltimateApi.isConfigured
    const originalGetCreds = AltimateApi.getCredentials
    const originalFetch = globalThis.fetch
    const SES = "ses_refresh_concurrency"
    const NOW = "2026-08-19T00:00:00.000Z"

    const remote = (id: string, content: string) => ({
      id: `rec-${id}`,
      memory: content,
      created_at: NOW,
      updated_at: NOW,
      metadata: { source: MIRROR_SOURCE, block_id: id, block_scope: "global" },
    })
    let listResponse = [remote("a", "ONE"), remote("b", "TWO")]

    ;(AltimateApi as any).isConfigured = async () => true
    ;(AltimateApi as any).getCredentials = async () => ({
      altimateInstanceName: "acme",
      altimateUrl: "https://api.example.com",
      altimateApiKey: "key",
    })
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      const payload = url.includes("/datamates/memory/list")
        ? listResponse
        : url.includes("/datamates/")
          ? { datamates: [{ id: 7, name: "acme", memory_enabled: true }] }
          : { message: "ok" }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof fetch
    syncInternals.resolveBinding = async () => ({
      datamateId: 7,
      datamateName: "acme",
      repoRemote: "ssh://git@github.com/acme/analytics.git",
      projectPath: "/work/analytics",
      linkedAt: 1,
    })
    resetOverlay()

    try {
      await hydrate(SES)
      expect(overlayBlocks(SES).map((b) => b.id).sort()).toEqual(["a", "b"])

      const [r1, r2] = await Promise.all([refresh(SES), refresh(SES)])
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)

      const ids = overlayBlocks(SES).map((b) => b.id).sort()
      // Exactly the two real blocks — no duplicates, no partial state from
      // one refresh clobbering the other mid-flight.
      expect(ids).toEqual(["a", "b"])
    } finally {
      globalThis.fetch = originalFetch
      ;(AltimateApi as any).isConfigured = originalIsConfigured
      ;(AltimateApi as any).getCredentials = originalGetCreds
      delete syncInternals.resolveBinding
      resetOverlay()
    }
  })
})
