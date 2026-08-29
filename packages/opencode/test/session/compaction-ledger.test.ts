import { describe, test, expect } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "../../src/util/token"
import type { MessageV2 } from "../../src/session/message-v2"

// Harness reliability / item 5 — unit gate: ledger determinism (5a) + append-only carry (5b).

// ─── Helpers ────────────────────────────────────────────────────────────────

let partCounter = 0

function toolPart(overrides: {
  tool: string
  status?: "completed" | "error" | "pending" | "running"
  input?: Record<string, any>
  output?: string
  metadata?: Record<string, any>
  end?: number
}): any {
  partCounter++
  const status = overrides.status ?? "completed"
  const base = {
    id: `part-${partCounter}`,
    sessionID: "session-1",
    messageID: `msg-${partCounter}`,
    type: "tool",
    callID: `call-${partCounter}`,
    tool: overrides.tool,
  }
  if (status === "completed")
    return {
      ...base,
      state: {
        status,
        input: overrides.input ?? {},
        output: overrides.output ?? "",
        title: "t",
        metadata: overrides.metadata ?? {},
        time: { start: 1000, end: overrides.end ?? 2000 },
      },
    }
  if (status === "error")
    return {
      ...base,
      state: {
        status,
        input: overrides.input ?? {},
        error: "boom",
        metadata: overrides.metadata,
        time: { start: 1000, end: overrides.end ?? 2000 },
      },
    }
  if (status === "running")
    return { ...base, state: { status, input: overrides.input ?? {}, time: { start: 1000 } } }
  return { ...base, state: { status, input: overrides.input ?? {}, raw: "{}" } }
}

function assistantMsg(parts: any[], info?: Partial<Record<string, any>>): MessageV2.WithParts {
  partCounter++
  return {
    info: {
      id: `msg-a-${partCounter}`,
      role: "assistant",
      sessionID: "session-1",
      ...info,
    },
    parts,
  } as unknown as MessageV2.WithParts
}

function summaryMsg(text: string): MessageV2.WithParts {
  partCounter++
  return {
    info: {
      id: `msg-s-${partCounter}`,
      role: "assistant",
      sessionID: "session-1",
      summary: true,
      finish: "stop",
    },
    parts: [
      {
        id: `part-s-${partCounter}`,
        sessionID: "session-1",
        messageID: `msg-s-${partCounter}`,
        type: "text",
        text,
      },
    ],
  } as unknown as MessageV2.WithParts
}

// ─── 5a: buildLedger ────────────────────────────────────────────────────────

describe("SessionCompaction.buildLedger", () => {
  test("records write/edit tool events with event-time mtimes (no fs access)", () => {
    const messages = [
      assistantMsg([
        toolPart({ tool: "write", input: { filePath: "/repo/a.ts", content: "x" }, end: 5000 }),
        toolPart({ tool: "edit", input: { filePath: "/repo/b.sql", oldString: "x", newString: "y" }, end: 6000 }),
      ]),
    ]
    const ledger = SessionCompaction.buildLedger(messages)
    expect(ledger.writes).toEqual([
      { path: "/repo/b.sql", mtime: 6000, tool: "edit" },
      { path: "/repo/a.ts", mtime: 5000, tool: "write" },
    ])
  })

  test("last write wins per path and newest-first ordering is deterministic", () => {
    const messages = [
      assistantMsg([
        toolPart({ tool: "write", input: { filePath: "/repo/a.ts" }, end: 5000 }),
        toolPart({ tool: "edit", input: { filePath: "/repo/a.ts" }, end: 9000 }),
        toolPart({ tool: "write", input: { filePath: "/repo/z.ts" }, end: 9000 }),
      ]),
    ]
    const ledger = SessionCompaction.buildLedger(messages)
    expect(ledger.writes).toEqual([
      { path: "/repo/a.ts", mtime: 9000, tool: "edit" },
      { path: "/repo/z.ts", mtime: 9000, tool: "write" },
    ])
  })

  test("captures bash exit codes from metadata, command-agnostic", () => {
    const messages = [
      assistantMsg([
        toolPart({ tool: "bash", input: { command: "bun test" }, metadata: { exit: 0 } }),
        toolPart({ tool: "bash", input: { command: "some-arbitrary-cmd --flag" }, metadata: { exit: 1 } }),
      ]),
    ]
    const ledger = SessionCompaction.buildLedger(messages)
    expect(ledger.sawBash).toBe(true)
    expect(ledger.calls).toEqual([
      { tool: "bash", detail: "bun test", exit: 0, errored: false },
      { tool: "bash", detail: "some-arbitrary-cmd --flag", exit: 1, errored: false },
    ])
  })

  test("bash does NOT produce verified write entries (shell writes are unverifiable)", () => {
    const messages = [
      assistantMsg([toolPart({ tool: "bash", input: { command: "sed -i s/a/b/ /repo/a.ts" }, metadata: { exit: 0 } })]),
    ]
    const ledger = SessionCompaction.buildLedger(messages)
    expect(ledger.writes).toEqual([])
    expect(ledger.sawBash).toBe(true)
  })

  test("errored tool calls are recorded as errored and never count as writes", () => {
    const messages = [
      assistantMsg([toolPart({ tool: "edit", status: "error", input: { filePath: "/repo/a.ts" } })]),
    ]
    const ledger = SessionCompaction.buildLedger(messages)
    expect(ledger.writes).toEqual([])
    expect(ledger.calls[0]).toEqual({ tool: "edit", detail: "/repo/a.ts", exit: undefined, errored: true })
  })

  test("errored bash still sets sawBash (it may have written before failing)", () => {
    const messages = [assistantMsg([toolPart({ tool: "bash", status: "error", input: { command: "cp a b" } })])]
    expect(SessionCompaction.buildLedger(messages).sawBash).toBe(true)
  })

  test("apply_patch writes come from result metadata files", () => {
    const messages = [
      assistantMsg([
        toolPart({
          tool: "apply_patch",
          input: { patchText: "..." },
          metadata: { files: [{ filePath: "/repo/c.py" }, { filePath: "/repo/d.py" }] },
          end: 7000,
        }),
      ]),
    ]
    const ledger = SessionCompaction.buildLedger(messages)
    expect(ledger.writes.map((w) => w.path).sort()).toEqual(["/repo/c.py", "/repo/d.py"])
    expect(ledger.writes.every((w) => w.mtime === 7000 && w.tool === "apply_patch")).toBe(true)
  })

  test("apply_patch moves record the DESTINATION, and deletes record nothing", () => {
    // `filePath` is the move SOURCE; the content lands at `movePath`. Naming the
    // source sends the continuing agent back to the path that was removed.
    const messages = [
      assistantMsg([
        toolPart({
          tool: "apply_patch",
          input: { patchText: "..." },
          metadata: {
            files: [
              { filePath: "/repo/old.py", movePath: "/repo/new.py", type: "update" },
              { filePath: "/repo/gone.py", type: "delete" },
              { filePath: "/repo/kept.py", type: "update" },
            ],
          },
          end: 7000,
        }),
      ]),
    ]
    const ledger = SessionCompaction.buildLedger(messages)
    expect(ledger.writes.map((w) => w.path).sort()).toEqual(["/repo/kept.py", "/repo/new.py"])
  })

  test("pending and running parts are ignored (facts only)", () => {
    const messages = [
      assistantMsg([
        toolPart({ tool: "write", status: "pending", input: { filePath: "/repo/a.ts" } }),
        toolPart({ tool: "bash", status: "running", input: { command: "sleep 5" } }),
      ]),
    ]
    const ledger = SessionCompaction.buildLedger(messages)
    expect(ledger.writes).toEqual([])
    expect(ledger.calls).toEqual([])
    expect(ledger.sawBash).toBe(false)
  })

  test("deterministic: identical input yields identical ledger and rendering", () => {
    const make = () => [
      assistantMsg([
        toolPart({ tool: "write", input: { filePath: "/repo/a.ts" }, end: 5000 }),
        toolPart({ tool: "bash", input: { command: "make check" }, metadata: { exit: 0 } }),
        toolPart({ tool: "read", input: { filePath: "/repo/a.ts" } }),
      ]),
    ]
    const first = SessionCompaction.buildLedger(make())
    const second = SessionCompaction.buildLedger(make())
    expect(second).toEqual(first)
    expect(SessionCompaction.renderLedger(second)).toBe(SessionCompaction.renderLedger(first))
  })
})

// ─── 5a: renderLedger ───────────────────────────────────────────────────────

describe("SessionCompaction.renderLedger", () => {
  const sample = () =>
    SessionCompaction.buildLedger([
      assistantMsg([
        toolPart({ tool: "write", input: { filePath: "/repo/models/orders.sql" }, end: 1_700_000_000_000 }),
        toolPart({ tool: "bash", input: { command: "run-all-checks" }, metadata: { exit: 0 } }),
      ]),
    ])

  test("empty ledger renders empty string", () => {
    expect(SessionCompaction.renderLedger({ writes: [], calls: [], sawBash: false })).toBe("")
  })

  test("a budget too small for even the header renders nothing, not a bare header", () => {
    // `ledger_max_tokens: 0` is accepted by the schema; truncation used to stop
    // at the header and return it, injecting text the tail calculation had
    // budgeted at zero.
    expect(SessionCompaction.renderLedger(sample(), { maxTokens: 0 })).toBe("")
    expect(SessionCompaction.renderLedger(sample(), { maxTokens: 3 })).toBe("")
  })

  test("contains verified writes with ISO event time, advisory wording, and unverified-shell note", () => {
    const text = SessionCompaction.renderLedger(sample())
    expect(text).toContain("/repo/models/orders.sql")
    expect(text).toContain(new Date(1_700_000_000_000).toISOString())
    expect(text).toContain("last written by you at")
    expect(text).toContain("possible but unverified")
    // advisory, never an absolute prohibition
    expect(text).toContain("re-read a file only if")
    expect(text).toContain("IDE edits")
    expect(text).not.toMatch(/never re-read|do not read/i)
  })

  test("lists at most recentCalls tool calls, newest first", () => {
    const parts = []
    for (let i = 1; i <= 15; i++) parts.push(toolPart({ tool: "bash", input: { command: `cmd-${i}` }, metadata: { exit: 0 } }))
    const ledger = SessionCompaction.buildLedger([assistantMsg(parts)])
    const text = SessionCompaction.renderLedger(ledger, { recentCalls: 10 })
    expect(text).toContain("cmd-15")
    expect(text).toContain("cmd-6")
    expect(text).not.toContain("cmd-5\n")
    expect(text).not.toContain("cmd-1 ")
    // newest first
    expect(text.indexOf("cmd-15")).toBeLessThan(text.indexOf("cmd-6"))
    expect(text).toContain("last 10 of 15")
  })

  test("tail-truncates to the token cap, preserving the header and writes section", () => {
    const parts = [toolPart({ tool: "write", input: { filePath: "/repo/first.ts" }, end: 1000 })]
    for (let i = 0; i < 50; i++)
      parts.push(toolPart({ tool: "bash", input: { command: `x`.repeat(90) + `-${i}` }, metadata: { exit: 0 } }))
    const ledger = SessionCompaction.buildLedger([assistantMsg(parts)])
    const capped = SessionCompaction.renderLedger(ledger, { maxTokens: 120, recentCalls: 50 })
    expect(Token.estimate(capped)).toBeLessThanOrEqual(120)
    expect(capped.split("\n")[0]).toContain("Session state ledger")
    expect(capped).toContain("/repo/first.ts")
  })

  test("default cap is 500 tokens (config default, plan provenance)", () => {
    const parts = []
    for (let i = 0; i < 200; i++)
      parts.push(toolPart({ tool: "bash", input: { command: "y".repeat(95) + i }, metadata: { exit: 0 } }))
    const ledger = SessionCompaction.buildLedger([assistantMsg(parts)])
    const text = SessionCompaction.renderLedger(ledger, { recentCalls: 200 })
    expect(SessionCompaction.LEDGER_MAX_TOKENS).toBe(500)
    expect(Token.estimate(text)).toBeLessThanOrEqual(500)
  })

  test("null exit code renders as unknown, error state as errored", () => {
    const ledger = SessionCompaction.buildLedger([
      assistantMsg([
        toolPart({ tool: "bash", input: { command: "killed-cmd" }, metadata: { exit: null } }),
        toolPart({ tool: "glob", status: "error", input: { pattern: "**/*.ts" } }),
      ]),
    ])
    const text = SessionCompaction.renderLedger(ledger)
    expect(text).toContain("bash (exit ?) — killed-cmd")
    expect(text).toContain("glob (errored) — **/*.ts")
  })
})

// ─── 5b: extractAccomplished / corroborateCarry / renderCarryAnchors ────────

describe("SessionCompaction.extractAccomplished", () => {
  test("parses bullets under ## Accomplished only, stopping at the next heading", () => {
    const summary = [
      "## Goal",
      "- not this",
      "## Accomplished",
      "- built /repo/models/orders.sql",
      "* verified row counts",
      "not a bullet",
      "## Relevant files / directories",
      "- /repo/models",
    ].join("\n")
    expect(SessionCompaction.extractAccomplished(summary)).toEqual([
      { text: "built /repo/models/orders.sql", priorStatus: undefined },
      { text: "verified row counts", priorStatus: undefined },
    ])
  })

  test("preserves prior carry tags", () => {
    const summary = ["## Accomplished", "- [verified] created a.sql", "- [claimed, unverified] fixed the test"].join(
      "\n",
    )
    expect(SessionCompaction.extractAccomplished(summary)).toEqual([
      { text: "created a.sql", priorStatus: "verified" },
      { text: "fixed the test", priorStatus: "claimed, unverified" },
    ])
  })

  test("returns empty for summaries without the section", () => {
    expect(SessionCompaction.extractAccomplished("## Goal\n- stuff")).toEqual([])
  })
})

describe("SessionCompaction.corroborateCarry", () => {
  const ledger = SessionCompaction.buildLedger([
    assistantMsg([
      toolPart({ tool: "write", input: { filePath: "/repo/models/orders.sql" }, end: 5000 }),
      toolPart({ tool: "bash", input: { command: "python scripts/export.py --out report.csv" }, metadata: { exit: 0 } }),
      toolPart({ tool: "bash", input: { command: "validate broken_thing.json" }, metadata: { exit: 1 } }),
    ]),
  ])

  test("item naming a verified-written file carries as verified", () => {
    const out = SessionCompaction.corroborateCarry([{ text: "created models/orders.sql with dedup logic" }], ledger)
    expect(out).toEqual([{ text: "created models/orders.sql with dedup logic", status: "verified" }])
  })

  test("item with no corroborating event carries as claimed, unverified", () => {
    const out = SessionCompaction.corroborateCarry([{ text: "generated final_report.pdf and emailed it" }], ledger)
    expect(out[0]!.status).toBe("claimed, unverified")
  })

  test("a directory-qualified artifact is not corroborated by a same-basename write elsewhere", () => {
    // Basename fallback exists for bare filenames. Applying it to a qualified
    // token lets an unrelated `test/orders.sql` verify `src/orders.sql`, and
    // because carry status is append-only that wrong fact never gets corrected.
    const out = SessionCompaction.corroborateCarry([{ text: "created test/orders.sql fixtures" }], ledger)
    expect(out[0]!.status).toBe("claimed, unverified")
  })

  test("a bare filename still matches the write's basename", () => {
    const out = SessionCompaction.corroborateCarry([{ text: "created orders.sql" }], ledger)
    expect(out[0]!.status).toBe("verified")
  })

  test("zero-exit command naming the artifact corroborates; failed command does not", () => {
    const out = SessionCompaction.corroborateCarry(
      [{ text: "exported report.csv" }, { text: "validated broken_thing.json" }],
      ledger,
    )
    expect(out[0]!.status).toBe("verified")
    expect(out[1]!.status).toBe("claimed, unverified")
  })

  test("append-only: a prior [verified] tag is preserved even without current evidence", () => {
    const out = SessionCompaction.corroborateCarry(
      [{ text: "shipped ancient_artifact.xyz", priorStatus: "verified" }],
      ledger,
    )
    expect(out[0]!.status).toBe("verified")
  })

  test("a prior unverified claim can be promoted when evidence appears", () => {
    const out = SessionCompaction.corroborateCarry(
      [{ text: "created models/orders.sql", priorStatus: "claimed, unverified" }],
      ledger,
    )
    expect(out[0]!.status).toBe("verified")
  })

  test("prose without artifact tokens never matches spuriously", () => {
    const out = SessionCompaction.corroborateCarry([{ text: "discussed the approach with the user" }], ledger)
    expect(out[0]!.status).toBe("claimed, unverified")
  })
})

describe("SessionCompaction.renderCarryAnchors", () => {
  test("empty items render empty string", () => {
    expect(SessionCompaction.renderCarryAnchors([])).toBe("")
  })

  test("renders tagged items with carry-forward instructions", () => {
    const text = SessionCompaction.renderCarryAnchors([
      { text: "built a.sql", status: "verified" },
      { text: "wrote docs", status: "claimed, unverified" },
    ])
    expect(text).toContain("append-only carry")
    expect(text).toContain("- [verified] built a.sql")
    expect(text).toContain("- [claimed, unverified] wrote docs")
    expect(text).toContain("keep the tag")
  })

  test("over budget drops the OLDEST items first and stays under the cap", () => {
    const items = []
    for (let i = 0; i < 60; i++) items.push({ text: `item-${i} ` + "z".repeat(80), status: "verified" as const })
    const text = SessionCompaction.renderCarryAnchors(items, 300)
    expect(Token.estimate(text)).toBeLessThanOrEqual(300)
    expect(text).not.toContain("item-0 ")
    expect(text).toContain("item-59 ")
  })

  test("deterministic rendering", () => {
    const items = [
      { text: "one", status: "verified" as const },
      { text: "two", status: "claimed, unverified" as const },
    ]
    expect(SessionCompaction.renderCarryAnchors(items)).toBe(SessionCompaction.renderCarryAnchors(items))
  })
})

// ─── latestSummaryText ──────────────────────────────────────────────────────

describe("SessionCompaction.latestSummaryText", () => {
  test("returns the most recent finished, non-errored summary", () => {
    const messages = [
      summaryMsg("## Accomplished\n- old item"),
      assistantMsg([toolPart({ tool: "read", input: { filePath: "/x" } })]),
      summaryMsg("## Accomplished\n- new item"),
    ]
    expect(SessionCompaction.latestSummaryText(messages)).toContain("new item")
  })

  test("skips errored or unfinished summaries", () => {
    const errored = summaryMsg("## Accomplished\n- bad") as any
    errored.info.error = { name: "x" }
    const unfinished = summaryMsg("## Accomplished\n- incomplete") as any
    delete unfinished.info.finish
    const messages = [summaryMsg("## Accomplished\n- good"), unfinished, errored]
    expect(SessionCompaction.latestSummaryText(messages)).toContain("good")
  })

  test("undefined when no summary exists", () => {
    expect(SessionCompaction.latestSummaryText([assistantMsg([])])).toBeUndefined()
  })
})

// ─── Leak guard: no vertical tokens in the generic mechanism (hard requirement) ─

describe("leak guard", () => {
  test("ledger output for a dbt-style command is treated identically to any other command", () => {
    const mk = (cmd: string) =>
      SessionCompaction.renderLedger(
        SessionCompaction.buildLedger([
          assistantMsg([toolPart({ tool: "bash", input: { command: cmd }, metadata: { exit: 0 } })]),
        ]),
      )
    const a = mk("dbt build --select orders")
    const b = mk("qqq build --select orders".replace("build", "frobnicate"))
    // Same structure: swapping the command text is the ONLY difference (no classifier).
    expect(a.replace("dbt build --select orders", "CMD")).toBe(
      b.replace("qqq frobnicate --select orders", "CMD"),
    )
  })
})
