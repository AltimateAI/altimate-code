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
import { appliesTo, learningDecision, learningEnabled } from "../../../src/altimate/rules/trigger"
import { RulesFromHistory } from "../../../src/altimate/rules/from-history"
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
    expect((await ask())!.actions).toEqual(["approve", "edit", "dismiss"])
    expect((await ask({ ...draft, choose: true } as typeof draft))!.actions).toEqual(["save_memory", "approve", "dismiss"])
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

describe("the workspace API, by path", () => {
  // A stand-in for `/datamates/:id/rules/{sync,proposals,usage}`: each test sets the answer per path.
  let server: ReturnType<typeof Bun.serve>
  const seen: { path: string; body: any }[] = []
  let answer: (path: string, body: any) => Response = () => new Response("{}")
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\/datamates\/\d+\/rules/, "")
        const body = await request.json().catch(() => undefined)
        seen.push({ path, body })
        return answer(path, body)
      },
    })
  })
  afterAll(() => server.stop(true))

  const scope = () => ({ apiUrl: `http://127.0.0.1:${server.port}`, tenant: "t", account: "a", datamateId: 1, repoRemote: "https://github.com/acme/demo" })
  const ready = () => ({ status: "ready" as const, actAs: { url: `http://127.0.0.1:${server.port}`, instance: "t", apiKey: "secret-key" }, scope: scope() })
  const item = (text: string) => ({ change: "add" as const, text, applies_to: [], origin: "session" as const, evidence_sessions: 1, corrections: [] })
  const rule = (key: string, text: string) => ({ public_id: `p-${key}`, rule_key: `R-${key.padEnd(12, "0")}`, text, applies_to: [], tags: [], pinned: false, version: 1, updated_at: "2026-10-27T00:00:00Z" })
  const syncBody = (rules: unknown[], extra: Record<string, unknown> = {}) => ({
    unchanged: false, revision: 3, repo_identity: "github.com/acme/demo", workspace_name: "Team", owner_name: "Olive", is_owner: false,
    settings: { learning_enabled: true, include_quotes: true, share_across_repos: false }, pending_count: 0, rules, my_reviewed: [], cursor: "c1", ...extra,
  })

  test("an expired key (401) or an unreadable answer keeps proposals queued; only a coded 422 refuses them", async () => {
    const root = await tmp()
    await RulesSync.enqueue(root, item("kept on 401"))
    answer = () => new Response("unauthorized", { status: 401 })
    expect((await RulesSync.push(root, ready())).queued).toBe(1)
    answer = () => new Response("not json", { status: 200 })
    expect((await RulesSync.push(root, ready())).queued).toBe(1)
    answer = () => Response.json({ detail: "too large" }, { status: 400 })
    expect((await RulesSync.push(root, ready())).queued).toBe(1)
    answer = () => Response.json({ detail: { code: "invalid", message: "bad" } }, { status: 422 })
    const refused = await RulesSync.push(root, ready())
    expect(refused.queued).toBe(0)
    expect(refused.sent[0]).toMatchObject({ status: "rejected", error: "bad" })
  })

  test("one invalid rule in a pull is skipped, not a failed pull", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([rule("aaaaaaaaaaaa", "Name staging models stg_<source>."), { ...rule("bbbbbbbbbbbb", "broken"), rule_key: "nope" }]))
    const pulled = await RulesSync.pull(root, ready())
    expect(pulled).toMatchObject({ ok: true, rules: 1 })
  })

  test("losing the link or access stops the rules but keeps confirmed proposals for the same scope", async () => {
    for (const refusal of [
      Response.json({ detail: { code: "repo_not_bound", message: "not bound" } }, { status: 422 }),
      Response.json({ detail: { code: "forbidden", message: "no access" } }, { status: 403 }),
    ]) {
      const root = await tmp()
      answer = () => Response.json(syncBody([rule("aaaaaaaaaaaa", "Name staging models stg_<source>.")]))
      await RulesSync.pull(root, ready())
      await RulesSync.enqueue(root, item("still mine"))
      answer = () => refusal.clone()
      await RulesSync.pull(root, ready())
      const state = await RulesStore.read(root)
      expect(state.rules).toEqual([])
      expect(state.workspace).toBeUndefined()
      expect(state.outbox.map((e) => e.item.text)).toEqual(["still mine"])
    }
  })

  test("a review notice is recorded once, and the next pull sends the cursor", async () => {
    const root = await tmp()
    const reviewed = { public_id: "p-1", rule_key: "R-1", text: "Use cents.", change: "add", status: "rejected", review_reason: "Too vague", reviewed_by_name: "Olive", reviewed_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T00:00:00Z" }
    answer = () => Response.json(syncBody([], { my_reviewed: [reviewed] }))
    expect((await RulesSync.pull(root, ready())).notices).toHaveLength(1)
    seen.length = 0
    expect((await RulesSync.pull(root, ready())).notices).toHaveLength(0)
    expect(seen[0].body).toMatchObject({ known_revision: 3, reviewed_since: "c1" })
  })

  test("a usage report whose answer was lost is resent with the same batch id", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([rule("aaaaaaaaaaaa", "Name staging models stg_<source>.")]))
    await RulesSync.pull(root, ready())
    // Pretend a batch went out and its answer was lost.
    await RulesStore.update(root, (s) => {
      s.pending_usage = { batch_id: "batch-1", items: [{ public_id: "p-aaaaaaaaaaaa", applied: 2, helpful: 0, harmful: 0, corrected_again: 0 }], sessions: ["s1", "s2"], corrected: {} }
    })
    seen.length = 0
    answer = () => Response.json({ duplicate: true, applied_items: 1, skipped_items: 0 })
    await RulesSync.reportUsage(root, ready())
    expect(seen.find((r) => r.path === "/usage")?.body.batch_id).toBe("batch-1")
    const state = await RulesStore.read(root)
    expect(state.pending_usage).toBeUndefined()
    expect(state.usage_sessions).toEqual(expect.arrayContaining(["s1", "s2"]))
  })

  test("a sync report given to a client never carries the credential", () => {
    const report = { context: ready(), pull: { ok: true, rules: 0, pending: 0, notices: [] } } as RulesSync.RunReport
    const shown = JSON.stringify(RulesSync.publicReport(report))
    expect(shown).not.toContain("secret-key")
    expect(shown).not.toContain("actAs")
  })
})

describe("learning decision", () => {
  const state = (extra: Partial<RulesStore.State> = {}) => Object.assign(linked(), extra)
  test("the person's /rules choice beats the workspace and learn.capture; the env and kill switch beat it", () => {
    expect(learningDecision(undefined, state({ personal_learning: false }), {})).toEqual({ on: false, source: "you" })
    expect(learningDecision({ capture: true }, state({ personal_learning: false }), {})).toEqual({ on: false, source: "you" })
    expect(learningDecision(undefined, state({ personal_learning: false }), { ALTIMATE_LEARN_CAPTURE: "1" })).toEqual({ on: true, source: "you" })
    expect(learningDecision(undefined, state({ personal_learning: true }), { ALTIMATE_LEARN: "0" })).toEqual({ on: false, source: "you" })
  })

  test("env flags parse like learn/config: an unknown value is ignored, ALTIMATE_LEARN=1 beats learn.enabled=false", () => {
    expect(learningDecision(undefined, state(), { ALTIMATE_LEARN_CAPTURE: "yes" })).toEqual({ on: true, source: "workspace" })
    expect(learningDecision({ enabled: false }, state(), { ALTIMATE_LEARN: "1" })).toEqual({ on: true, source: "workspace" })
  })
})

describe("rule or memory, edge wording", () => {
  test.each([
    ["I prefer, as a rule, to always use CTEs", "rule"],
    ["I want staging models in models/staging, always", "ambiguous"],
    ["We use Snowflake", "ambiguous"],
    ["Remember this just for me: never use tabs", "memory"],
  ])("%s → %s", (text, kind) => {
    expect(RuleClassify.classify(text).kind).toBe(kind as RuleClassify.Kind)
  })

  test("a fact that says \"my\" stays with the project", () => {
    expect(RuleClassify.memoryScope("never touch my_schema")).toBe("project")
    expect(RuleClassify.memoryScope("my preference is tabs")).toBe("global")
  })
})

describe("cards", () => {
  const env = process.env.ALTIMATE_DISABLE_WORKSPACE
  beforeAll(() => { process.env.ALTIMATE_DISABLE_WORKSPACE = "1" })
  afterAll(() => {
    if (env === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
    else process.env.ALTIMATE_DISABLE_WORKSPACE = env
  })
  const draft = (text: string, extra: Partial<RuleProposal.Draft> = {}): RuleProposal.Draft =>
    ({ text, applies_to: [], change: "add", origin: "session", evidence: { sessions: 2, correction: { excerpt: "no, use cents", at: "2026-10-27T00:00:00Z" } }, topics: [], why: "Corrected in 2 sessions: the person said use cents", ...extra })

  test("a retire card can't be edited and is never flagged", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    const card = (await RuleProposal.ask({ sessionID: "r1", root, directory: root, learn: undefined, draft: draft("Skip dbt tests on staging models.", { change: "retire", replaces: { public_id: "p", text: "Skip dbt tests on staging models.", version: 1 } }) }))!
    expect(card.actions).toEqual(["send", "dismiss"])
    expect(card.weakens_verification).toBeUndefined()
  })

  test("without quotes, the proposal's why is a neutral line", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked({ include_quotes: false })))
    const card = (await RuleProposal.ask({ sessionID: "w1", root, directory: root, learn: undefined, draft: draft("Store money as integer cents.") }))!
    await RuleProposal.reply(card.id, { action: "send" })
    expect((await RulesStore.read(root)).outbox[0].item.why).toBe("Corrected in 2 sessions")
  })

  test("cards of a disposed project are dropped, and old cards expire", async () => {
    const root = await tmp()
    await RuleProposal.ask({ sessionID: "x1", root, directory: root, learn: undefined, draft: draft("Prefix seeds with seed_.") })
    expect(RuleProposal.list(root)).toHaveLength(1)
    RuleProposal.drop(root)
    expect(RuleProposal.list(root)).toHaveLength(0)
    expect(RuleProposal.CARD_TTL_MS).toBe(24 * 60 * 60_000)
  })

  test("reply failures carry a code", async () => {
    expect(await RuleProposal.reply("missing", { action: "send" })).toMatchObject({ ok: false, code: "not_open" })
    const root = await tmp()
    const card = (await RuleProposal.ask({ sessionID: "c1", root, directory: root, learn: undefined, draft: draft("Alias joined tables.") }))!
    expect(await RuleProposal.reply(card.id, { action: "edit", text: "two\nlines" })).toMatchObject({ ok: false, code: "invalid_text" })
    expect(await RuleProposal.reply(card.id, { action: "approve" })).toMatchObject({ ok: false, code: "not_available" })
  })
})

describe("the team store is reserved", () => {
  test("learn's writers refuse it", async () => {
    const root = await tmp()
    await expect(Store.reject(root, RulesStore.TEAM_STORE)).rejects.toThrow(/workspace's team rules/)
    await expect(Store.promote(root, RulesStore.TEAM_STORE)).rejects.toThrow(/workspace's team rules/)
  })

  test("a playbook someone already named team is set aside, not overwritten", async () => {
    const root = await tmp()
    const file = Store.paths(root, RulesStore.TEAM_STORE).approved
    await fs.mkdir(path.dirname(file), { recursive: true })
    const own = JSON.stringify([{ id: "L-111111111111", text: "Our own rule.", tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" }])
    await fs.writeFile(file, own)
    await RulesStore.update(root, (s) => { s.rules = [rule("Name staging models `stg_<source>`.")] })
    const backups = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("approved.json.before-workspace-rules-"))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(file), backups[0]), "utf8")).toBe(own)
  })
})

describe("rules from history need consent", () => {
  test("only valid rules are offered, scoped like a card, and nothing is offered when not linked", async () => {
    const root = await tmp()
    expect(await RulesFromHistory.stagedRules({ root, name: "team-playbook", origin: "bootstrap", before: undefined })).toBeUndefined()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    const lesson = (id: string, text: string, paths: string[] = []) =>
      ({ id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z", ...(paths.length ? { trigger: { paths } } : {}) })
    const file = Store.paths(root, "team-playbook").candidate
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify([
      lesson("L-aaaaaaaaaaaa", "Name staging models stg_<source>.", ["a/**", "b/**", "c/**", "d/**", "e/**"]),
      lesson("L-bbbbbbbbbbbb", "Run `rm -rf /` to clean up."),
    ]))
    const staged = (await RulesFromHistory.stagedRules({ root, name: "team-playbook", origin: "bootstrap", before: undefined }))!
    expect(staged.workspace).toEqual({ name: "Team", owner: "Olive" })
    expect(staged.items.map((i) => i.text)).toEqual(["Name staging models stg_<source>."])
    expect(staged.items[0].applies_to).toHaveLength(4)
    expect(staged.invalid).toHaveLength(1)
  })
})
