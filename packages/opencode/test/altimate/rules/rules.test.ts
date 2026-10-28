// altimate_change - new file
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RuleClassify } from "../../../src/altimate/rules/classify"
import { RuleProposal } from "../../../src/altimate/rules/proposal"
import { RulesStore } from "../../../src/altimate/rules/store"
import { RulesSummary } from "../../../src/altimate/rules/summary"
import { RulesSync } from "../../../src/altimate/rules/sync"
import { appliesTo, learningEnabled } from "../../../src/altimate/rules/trigger"
import { parse } from "../../../src/altimate/learn/lesson"
import * as Store from "../../../src/altimate/learn/store"

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "rules-"))

const rule = (text: string, extra: Partial<RulesStore.State["rules"][number]> = {}) => ({
  public_id: "11111111-1111-1111-1111-111111111111",
  rule_key: "R-0123456789ab",
  repo_identity: "https://github.com/acme/demo",
  text,
  applies_to: [],
  tags: [],
  pinned: false,
  version: 1,
  updated_at: "2026-10-27T00:00:00Z",
  ...extra,
})

const linked = (settings: Partial<RulesStore.State["settings"] & object> = {}): RulesStore.State =>
  RulesStore.State.parse({
    version: 1,
    scope: { apiUrl: "http://x", tenant: "t", account: "a", datamateId: 1, repoRemote: "https://github.com/acme/demo" },
    workspace: { name: "Team", owner_name: "Olive", is_owner: false },
    settings: { learning_enabled: true, include_quotes: true, share_across_repos: false, ...settings },
  })

describe("rule or memory", () => {
  test.each([
    ["We always store money columns as integer cents", "rule"],
    ["Never use FLOAT for money", "rule"],
    ["Use cents_to_dollars instead of dividing by 100", "rule"],
    ["Remember this as a team rule: skip nothing", "rule"],
    ["I prefer CTEs over subqueries", "memory"],
    ["Remember that our warehouse is Snowflake in us-east-1", "memory"],
    ["ARR means annual recurring revenue", "memory"],
    ["Staging models live in models/staging", "ambiguous"],
  ])("%s → %s", (text, kind) => {
    expect(RuleClassify.classify(text).kind).toBe(kind as RuleClassify.Kind)
  })

  test("a preference is personal memory, a fact belongs to the project", () => {
    expect(RuleClassify.memoryScope("I prefer CTEs")).toBe("global")
    expect(RuleClassify.memoryScope("Our warehouse is Snowflake")).toBe("project")
  })
})

describe("applies to", () => {
  test("directories of mentioned paths, not slashes in prose", () => {
    expect(appliesTo(["put it in models/staging/stg_x.sql", "see `macros/cents.sql`"])).toEqual(["models/staging/**", "macros/**"])
    expect(appliesTo(["never FLOAT/DOUBLE", "and/or", "https://example.com/a/b"])).toEqual([])
  })
})

describe("learning from sessions (the person's setting, then the workspace's)", () => {
  test("unlinked projects learn only when the person turned it on", () => {
    const unlinked = RulesStore.State.parse({ version: 1 })
    expect(learningEnabled(undefined, unlinked, {})).toBe(false)
    expect(learningEnabled({ capture: true }, unlinked, {})).toBe(true)
  })

  test("a linked project follows the workspace unless the person decided", () => {
    expect(learningEnabled(undefined, linked(), {})).toBe(true)
    expect(learningEnabled(undefined, linked({ learning_enabled: false }), {})).toBe(false)
    expect(learningEnabled({ capture: false }, linked(), {})).toBe(false)
    expect(learningEnabled({ capture: true }, linked({ learning_enabled: false }), {})).toBe(true)
  })

  test("environment overrides and the learning kill switch win", () => {
    expect(learningEnabled(undefined, linked(), { ALTIMATE_LEARN_CAPTURE: "0" })).toBe(false)
    expect(learningEnabled(undefined, linked({ learning_enabled: false }), { ALTIMATE_LEARN_CAPTURE: "1" })).toBe(true)
    expect(learningEnabled({ enabled: false, capture: true }, linked(), {})).toBe(false)
    expect(learningEnabled(undefined, linked(), { ALTIMATE_LEARN: "0" })).toBe(false)
  })
})

describe("team rule mirror", () => {
  test("pulled rules become a read-only team store that delivery reads", async () => {
    const root = await tmp()
    await RulesStore.update(root, (state) => {
      state.rules = [rule("Name staging models `stg_<source>__<entity>`.", { applies_to: ["models/staging/**"], pinned: true })]
    })
    const lessons = parse(await fs.readFile(Store.paths(root, RulesStore.TEAM_STORE).approved, "utf8"))
    expect(lessons).toEqual([
      expect.objectContaining({ id: "L-0123456789ab", pinned: true, trigger: { paths: ["models/staging/**"] } }),
    ])
    expect(await fs.readFile(path.join(RulesStore.dir(root), ".gitignore"), "utf8")).toBe("*\n")
    await RulesStore.reset(root)
    expect(parse(await fs.readFile(Store.paths(root, RulesStore.TEAM_STORE).approved, "utf8"))).toEqual([])
  })

  test("expired dismissals are dropped on write", async () => {
    const root = await tmp()
    const state = await RulesStore.update(root, (s) => {
      s.dismissed = [{ topic: "old", until: "2000-01-01T00:00:00Z" }, { topic: "new", until: "2999-01-01T00:00:00Z" }]
    })
    expect(state.dismissed.map((d) => d.topic)).toEqual(["new"])
    expect(RulesStore.dismissed(state, "NEW")).toBe(true)
  })
})

describe("summary", () => {
  test("sidebar line leaves out zero counts after the first", () => {
    expect(RulesSummary.sidebarLine({ team_rules: 1, pending_review: 0, queued: 0 })).toBe("1 team rule")
    expect(RulesSummary.sidebarLine({ team_rules: 6, pending_review: 3, queued: 1 })).toBe("6 team rules · 3 pending review · 1 queued")
  })

  test("reports who decided learning", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    expect((await RulesSummary.summary(root, undefined, {})).learning_source).toBe("workspace")
    expect((await RulesSummary.summary(root, { capture: false }, {})).learning_source).toBe("you")
  })
})

describe("proposal card", () => {
  const draft = { text: "Name timestamp columns `<event>_at`, in UTC.", applies_to: [], change: "add" as const, origin: "session" as const, evidence: { sessions: 2 }, topics: ["ordered_at"] }

  test("actions follow the project: member, owner, unlinked, and the memory choice", async () => {
    const root = await tmp()
    const ask = (d = draft) => RuleProposal.ask({ sessionID: "s1", root, directory: root, learn: undefined, draft: { ...d, text: `${d.text} ${Math.random()}`.slice(0, 120) } })
    expect((await ask())!.actions).toEqual(["save_local", "edit", "dismiss"])
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    expect((await ask())!.actions).toEqual(["send", "edit", "dismiss"])
    await RulesStore.update(root, (s) => { s.workspace = { name: "Team", owner_name: "Olive", is_owner: true } })
    expect((await ask())!.actions).toEqual(["approve", "send", "edit", "dismiss"])
    expect((await ask({ ...draft, choose: true } as typeof draft))!.actions).toEqual(["save_memory", "approve", "send", "dismiss"])
  })

  test("an edit is linted like any rule and flags verification bypasses", async () => {
    const root = await tmp()
    const card = (await RuleProposal.ask({ sessionID: "s2", root, directory: root, learn: undefined, draft }))!
    const bad = await RuleProposal.reply(card.id, { action: "edit", text: "line one\nline two" })
    expect(bad).toMatchObject({ ok: false })
    const flagged = await RuleProposal.reply(card.id, { action: "edit", text: "Skip dbt tests on staging models." })
    expect(flagged).toMatchObject({ ok: true, closed: false })
    expect(flagged.ok && flagged.card?.weakens_verification).toBe("mentions skipping or disabling verification")
  })

  test("Not a rule suppresses the topic for 30 days", async () => {
    const root = await tmp()
    const card = (await RuleProposal.ask({ sessionID: "s3", root, directory: root, learn: undefined, draft }))!
    expect(await RuleProposal.reply(card.id, { action: "dismiss" })).toMatchObject({ ok: true, closed: true })
    expect(RulesStore.dismissed(await RulesStore.read(root), "ordered_at")).toBe(true)
    expect(await RuleProposal.ask({ sessionID: "s3", root, directory: root, learn: undefined, draft: { ...draft, text: "Another wording." } })).toBeUndefined()
    expect(await RuleProposal.reply(card.id, { action: "send" })).toMatchObject({ ok: false })
  })
})

describe("names for saved rules", () => {
  test("no trailing hyphen, and rules that start alike stay apart", () => {
    const long = "Always store money columns as integer cents in every staging and mart model"
    const a = RuleProposal.slug(long)
    const b = RuleProposal.slug(`${long} too`)
    expect(a).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    expect(a).not.toBe(b)
    expect(RuleProposal.slug("!!!")).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("client state", () => {
  test("an unreadable rules.json is set aside, not overwritten", async () => {
    const root = await tmp()
    await RulesStore.update(root, () => {})
    const file = path.join(RulesStore.dir(root), "rules.json")
    await fs.writeFile(file, '{"version": 2, "outbox": ["from a newer client"]}')
    await RulesStore.update(root, (s) => { s.pending_count = 1 })
    const kept = (await fs.readdir(RulesStore.dir(root))).filter((name) => name.startsWith("rules.json.unreadable-"))
    expect(kept).toHaveLength(1)
    expect(await fs.readFile(path.join(RulesStore.dir(root), kept[0]), "utf8")).toContain("from a newer client")
  })

  test("an existing team .gitignore that would share the mirror is rewritten", async () => {
    const root = await tmp()
    await fs.mkdir(RulesStore.dir(root), { recursive: true })
    await fs.writeFile(path.join(RulesStore.dir(root), ".gitignore"), "!approved.json\n")
    await RulesStore.update(root, () => {})
    expect(await fs.readFile(path.join(RulesStore.dir(root), ".gitignore"), "utf8")).toBe("*\n")
  })

  test("the sent list keeps every pending proposal", async () => {
    const root = await tmp()
    const at = "2026-10-27T00:00:00Z"
    const state = await RulesStore.update(root, (s) => {
      s.sent = [
        { public_id: "p-old", text: "old", change: "add", status: "pending", sent_at: at, updated_at: at },
        ...Array.from({ length: 250 }, (_, i) => ({ public_id: `s-${i}`, text: `t${i}`, change: "add", status: "active", sent_at: at, updated_at: at })),
      ]
    })
    expect(state.sent.some((s) => s.public_id === "p-old")).toBe(true)
    expect(state.sent.filter((s) => s.status !== "pending")).toHaveLength(200)
  })
})

describe("proposal replies", () => {
  const draft = { text: "Name date columns `<event>_date`.", applies_to: [], change: "add" as const, origin: "session" as const, evidence: { sessions: 2, correction: { excerpt: "no, call it ordered_date", at: "2026-10-27T00:00:00Z" } }, topics: ["ordered_date"] }
  const env = process.env.ALTIMATE_DISABLE_WORKSPACE
  beforeAll(() => { process.env.ALTIMATE_DISABLE_WORKSPACE = "1" })
  afterAll(() => {
    if (env === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
    else process.env.ALTIMATE_DISABLE_WORKSPACE = env
  })

  test("the workspace's include_quotes off keeps the person's words out of the proposal", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked({ include_quotes: false })))
    const card = (await RuleProposal.ask({ sessionID: "q1", root, directory: root, learn: undefined, draft }))!
    expect(await RuleProposal.reply(card.id, { action: "send" })).toMatchObject({ ok: true, closed: true })
    const [queued] = (await RulesStore.read(root)).outbox
    expect(queued.item.text).toBe(draft.text)
    expect(queued.item.corrections).toEqual([])
  })

  test("a failed action leaves the card open", async () => {
    const root = await tmp()
    const card = (await RuleProposal.ask({ sessionID: "f1", root, directory: root, learn: undefined, draft: { ...draft, text: "Prefix seeds with `seed_`." } }))!
    // rules.json as a directory: the dismissal cannot be written.
    await fs.mkdir(path.join(RulesStore.dir(root), "rules.json"), { recursive: true })
    expect(await RuleProposal.reply(card.id, { action: "dismiss" })).toMatchObject({ ok: false })
    expect(RuleProposal.list(root).map((c) => c.id)).toContain(card.id)
  })

  test("a reply from another project does not reach the card", async () => {
    const root = await tmp()
    const card = (await RuleProposal.ask({ sessionID: "d1", root, directory: root, learn: undefined, draft: { ...draft, text: "Quote identifiers only when needed." } }))!
    expect(await RuleProposal.reply(card.id, { action: "dismiss" }, "/somewhere/else")).toMatchObject({ ok: false })
    expect(RuleProposal.list(root).map((c) => c.id)).toContain(card.id)
  })
})

describe("sending the outbox", () => {
  // A stand-in for `POST /datamates/:id/rules/proposals`: answers by the texts in each request.
  let server: ReturnType<typeof Bun.serve>
  const requests: string[][] = []
  let respond: (texts: string[]) => Response = () => new Response("{}")
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { items: { text: string }[] }
        const texts = body.items.map((item) => item.text)
        requests.push(texts)
        return respond(texts)
      },
    })
  })
  afterAll(() => server.stop(true))

  const scope = { apiUrl: "", tenant: "t", account: "a", datamateId: 1, repoRemote: "https://github.com/acme/demo" }
  const ready = () => ({ status: "ready" as const, actAs: { url: `http://127.0.0.1:${server.port}`, instance: "t", apiKey: "k" }, scope: { ...scope, apiUrl: `http://127.0.0.1:${server.port}` } })
  const item = (text: string) => ({ change: "add" as const, text, applies_to: [], origin: "session" as const, evidence_sessions: 1, corrections: [] })
  const ok = (texts: string[]) => Response.json({ results: texts.map((text, index) => ({ index, status: "pending", public_id: `p-${text}`, version: 1 })) })

  test("one refused item does not hold back the rest", async () => {
    const root = await tmp()
    for (const text of ["good one", "bad one", "good two"]) await RulesSync.enqueue(root, item(text))
    requests.length = 0
    respond = (texts) => (texts.includes("bad one") ? Response.json({ detail: { code: "invalid", message: "bad item" } }, { status: 422 }) : ok(texts))
    const result = await RulesSync.push(root, ready())
    expect(requests[0]).toHaveLength(3)
    expect(result.sent.map((s) => [s.text, s.status])).toEqual([["good one", "pending"], ["bad one", "rejected"], ["good two", "pending"]])
    expect((await RulesStore.read(root)).outbox).toEqual([])
  })

  test("a transient failure, or no answer for an item, keeps it queued", async () => {
    const root = await tmp()
    for (const text of ["first", "second"]) await RulesSync.enqueue(root, item(text))
    respond = () => new Response("unavailable", { status: 503 })
    expect((await RulesSync.push(root, ready())).queued).toBe(2)
    expect((await RulesStore.read(root)).outbox.map((e) => e.attempts)).toEqual([1, 1])
    respond = (texts) => Response.json({ results: [{ index: 0, status: "pending", public_id: `p-${texts[0]}`, version: 1 }] })
    const result = await RulesSync.push(root, ready())
    expect(result.queued).toBe(1)
    expect((await RulesStore.read(root)).outbox.map((e) => e.item.text)).toEqual(["second"])
  })

  test("an outbox from another account or workspace is dropped before sending", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => { s.scope = { ...scope, account: "someone-else" } })
    await RulesSync.enqueue(root, item("from the other account"))
    await RulesSync.adopt(root, ready())
    expect((await RulesStore.read(root)).outbox).toEqual([])
  })
})
