// altimate_change - new file
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
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
import { RulesRemember } from "../../../src/altimate/rules/remember"
import { RulesTelemetry } from "../../../src/altimate/rules/telemetry"
import { RulesService } from "../../../src/altimate/rules/service"
import { RuleTrigger } from "../../../src/altimate/rules/trigger"
import { appendSignal } from "../../../src/altimate/learn/signals"
import { Telemetry } from "../../../src/altimate/telemetry"
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
    ["Can you fix this model for me? Remember: never use FLOAT for money.", "rule"],
    ["Never load the fact table in memory", "rule"],
    ["Remember just for me: I like trailing commas", "memory"],
    ["Keep this as a memory: the dev schema is dbt_sarav", "memory"],
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

  test("a flagged card is approved only with approve_anyway; a plain approve is refused", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked(), { workspace: { name: "Team", owner_name: "Olive", is_owner: true } }))
    const card = (await RuleProposal.ask({ sessionID: "a1", root, directory: root, learn: undefined, draft: { ...draft, text: "Skip dbt tests on staging models." } }))!
    expect(card.weakens_verification).toBeTruthy()
    expect(await RuleProposal.reply(card.id, { action: "approve" })).toMatchObject({ ok: false, code: "verification_flagged" })
    const plain = (await RuleProposal.ask({ sessionID: "a1", root, directory: root, learn: undefined, draft: { ...draft, text: "Prefix seeds with seed_ in every project." } }))!
    expect(await RuleProposal.reply(plain.id, { action: "approve_anyway" })).toMatchObject({ ok: false, code: "not_available" })
    RuleProposal.drop(root)
  })

  test("a card asked again from another session moves there with that session's directory", async () => {
    const root = await tmp()
    const other = await tmp()
    const card = (await RuleProposal.ask({ sessionID: "m1", root, directory: root, learn: undefined, draft: { ...draft, text: "Name snapshots snap_<entity>." } }))!
    await RuleProposal.ask({ sessionID: "m2", root, directory: other, learn: undefined, draft: { ...draft, text: "Name snapshots snap_<entity>." } })
    expect(RuleProposal.list(other, "m2")).toEqual([expect.objectContaining({ id: card.id })])
    expect(await RuleProposal.reply(card.id, { action: "dismiss" }, other)).toMatchObject({ ok: true })
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
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
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
    answer = () => new Response("payload too large", { status: 413 })
    expect((await RulesSync.push(root, ready())).queued).toBe(1)
    answer = () => Response.json({ detail: { code: "too_many_pending", message: "busy" } }, { status: 503 })
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

  test("a repo_not_bound refusal of the proposals keeps the whole outbox, in one request", async () => {
    const root = await tmp()
    for (const text of ["first", "second", "third"]) await RulesSync.enqueue(root, item(text))
    seen.length = 0
    answer = () => Response.json({ detail: { code: "repo_not_bound", message: "not bound" } }, { status: 422 })
    expect((await RulesSync.push(root, ready())).queued).toBe(3)
    expect(seen.filter((r) => r.path === "/proposals")).toHaveLength(1)
    expect((await RulesStore.read(root)).outbox).toHaveLength(3)
  })

  test("an uncoded 422 refuses only the items that fail alone; when every item fails, all stay queued", async () => {
    const root = await tmp()
    for (const text of ["good", "bad"]) await RulesSync.enqueue(root, item(text))
    const uncoded = () => Response.json({ detail: [{ msg: "invalid" }] }, { status: 422 })
    answer = (_path, body) => (body.items.some((i: { text: string }) => i.text === "bad") ? uncoded() : Response.json({ results: [{ index: 0, status: "pending", public_id: "p-good", version: 1 }] }))
    const mixed = await RulesSync.push(root, ready())
    expect(mixed.sent.map((s) => [s.text, s.status])).toEqual([["good", "pending"], ["bad", "rejected"]])
    const all = await tmp()
    for (const text of ["one", "two"]) await RulesSync.enqueue(all, item(text))
    answer = uncoded
    expect((await RulesSync.push(all, ready())).queued).toBe(2)
  })

  test("a stale edit is not recorded under the target's id, and its card closes with a message", async () => {
    const root = await tmp()
    await RulesSync.enqueue(root, { ...item("Edited wording."), change: "edit" as const, replaces: "p-target", replaces_version: 1 })
    answer = () => Response.json({ results: [{ index: 0, status: "stale", public_id: "p-target", version: 2, error_code: "target_changed", error_detail: "changed" }] })
    const pushed = await RulesSync.push(root, ready())
    expect(pushed.sent[0]).toMatchObject({ status: "stale", target_gone: true, error_code: "target_changed" })
    expect(pushed.sent[0].public_id).toBeUndefined()
    expect((await RulesStore.read(root)).sent).toEqual([])
  })

  test("a failed Approve now is retried on the next push when it can pass, and dropped with a reason when it cannot", async () => {
    const root = await tmp()
    await RulesSync.enqueue(root, item("Approve me."), "approve")
    answer = (path) => (path === "/proposals"
      ? Response.json({ results: [{ index: 0, status: "pending", public_id: "p-approve", version: 1 }] })
      : new Response("unavailable", { status: 503 }))
    const first = await RulesSync.push(root, ready())
    expect(first.sent[0]).toMatchObject({ approve_retry: true })
    expect((await RulesStore.read(root)).pending_approvals).toEqual([expect.objectContaining({ public_id: "p-approve", action: "approve" })])
    answer = () => Response.json({ public_id: "p-approve", status: "active", version: 1 })
    await RulesSync.push(root, ready())
    const state = await RulesStore.read(root)
    expect(state.pending_approvals).toEqual([])
    expect(state.sent.find((s) => s.public_id === "p-approve")?.status).toBe("active")
  })

  test("a usage batch the server refuses for good is dropped, so later usage is reported", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([rule("aaaaaaaaaaaa", "Name staging models stg_<source>.")]))
    await RulesSync.pull(root, ready())
    await RulesStore.update(root, (s) => {
      s.pending_usage = { batch_id: "batch-x", items: [{ public_id: "p-aaaaaaaaaaaa", applied: 1, helpful: 0, harmful: 0, corrected_again: 0 }], sessions: ["s1"], corrected: {} }
    })
    answer = () => Response.json({ detail: { code: "batch_conflict", message: "conflict" } }, { status: 409 })
    await RulesSync.reportUsage(root, ready())
    expect((await RulesStore.read(root)).pending_usage).toBeUndefined()
  })

  test("a pull that skipped an unreadable rule does not keep the revision, so the next pull fetches all rules", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([rule("aaaaaaaaaaaa", "Name staging models stg_<source>."), { ...rule("bbbbbbbbbbbb", "broken"), rule_key: "nope" }]))
    await RulesSync.pull(root, ready())
    const state = await RulesStore.read(root)
    expect(state.revision).toBeUndefined()
    expect(state.last_error).toContain("1 team rule could not be read")
    seen.length = 0
    await RulesSync.pull(root, ready())
    expect(seen[0].body.known_revision).toBeUndefined()
  })

  test("usage counts a session only against the rule version it was shown", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([{ ...rule("aaaaaaaaaaaa", "Name staging models stg_<source>__<entity>."), public_id: "p-v2", version: 2 }]))
    await RulesSync.pull(root, ready())
    const lessonId = RulesStore.lessonId("R-aaaaaaaaaaaa")
    const lesson = (text: string) => ({ id: lessonId, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-10-27T00:00:00Z", updated: "2026-10-27T00:00:00Z" })
    const dir = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(dir, { recursive: true })
    for (const [session, text] of [["shown-v1", "Name staging models stg_<source>."], ["shown-v2", "Name staging models stg_<source>__<entity>."]]) {
      const state = { version: 1, session, firstMessage: "m", query: "q", touchedPaths: [], section: "", shown: [{ name: RulesStore.TEAM_STORE, lesson: lesson(text), tier: "core", at: "2026-10-28T00:00:00Z", queryHash: "h" }], requests: [], requestParts: [], compactions: [], counted: [] }
      await fs.writeFile(path.join(dir, `${Store.sha256(session)}.json`), JSON.stringify(state))
    }
    seen.length = 0
    answer = () => Response.json({ duplicate: false, applied_items: 1, skipped_items: 0 })
    await RulesSync.reportUsage(root, ready())
    expect(seen.find((r) => r.path === "/usage")?.body.items).toEqual([expect.objectContaining({ public_id: "p-v2", applied: 1 })])
  })

  test("a card's outcome is the one recorded for its outbox id, even when another run sent it", async () => {
    const root = await tmp()
    const id = await RulesSync.enqueue(root, item("Refused elsewhere."))
    answer = () => Response.json({ detail: { code: "invalid", message: "too vague" } }, { status: 422 })
    await RulesSync.push(root, ready())
    // This run did not send it: its outcome comes from what the other run recorded, not "sent".
    expect(RulesSync.outcomeOf(await RulesStore.read(root), undefined, id)).toMatchObject({ status: "sent", row: { status: "rejected", error: "too vague" } })
  })

  test("one item refused with an uncoded 422 is retried a few times, then refused", async () => {
    const root = await tmp()
    await RulesSync.enqueue(root, item("Unclear."))
    answer = () => Response.json({ detail: [{ msg: "invalid" }] }, { status: 422 })
    expect((await RulesSync.push(root, ready())).queued).toBe(1)
    expect((await RulesSync.push(root, ready())).queued).toBe(1)
    const last = await RulesSync.push(root, ready())
    expect(last.queued).toBe(0)
    expect(last.sent[0]).toMatchObject({ status: "rejected" })
  })

  test("a dropped usage batch marks its sessions reported, so the same batch is not rebuilt", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([rule("aaaaaaaaaaaa", "Name staging models stg_<source>.")]))
    await RulesSync.pull(root, ready())
    await RulesStore.update(root, (s) => {
      s.pending_usage = { batch_id: "batch-y", items: [{ public_id: "p-aaaaaaaaaaaa", applied: 1, helpful: 0, harmful: 0, corrected_again: 0 }], sessions: ["s9"], corrected: { "R-aaaaaaaaaaaa": 1 } }
    })
    answer = () => Response.json({ detail: { code: "batch_conflict", message: "conflict" } }, { status: 409 })
    await RulesSync.reportUsage(root, ready())
    const state = await RulesStore.read(root)
    expect(state.pending_usage).toBeUndefined()
    expect(state.usage_sessions).toContain("s9")
    expect(state.corrected_reported["R-aaaaaaaaaaaa"]).toBe(1)
  })

  test("too many proposals at once say so", async () => {
    const root = await tmp()
    const many = Array.from({ length: RulesStore.MAX_OUTBOX + 1 }, (_, i) => ({ item: item(`Rule ${i}.`) }))
    await expect(RulesSync.enqueueMany(root, many)).rejects.toThrow(`${RulesStore.MAX_OUTBOX + 1} proposals are more than can wait to be sent at once`)
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

  test("local rules the run edited or removed are not proposed, and they keep the candidate", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    const lesson = (id: string, text: string) =>
      ({ id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" })
    const p = Store.paths(root, "team-playbook")
    await fs.mkdir(path.dirname(p.candidate), { recursive: true })
    await fs.writeFile(p.approved, JSON.stringify([lesson("L-aaaaaaaaaaaa", "Name seeds seed_<entity>."), lesson("L-bbbbbbbbbbbb", "Quote reserved words.")]))
    await fs.writeFile(p.candidate, JSON.stringify([
      lesson("L-aaaaaaaaaaaa", "Name seeds seed_<entity>, in snake case."),
      lesson("L-cccccccccccc", "Prefix views with v_."),
    ]))
    const staged = (await RulesFromHistory.stagedRules({ root, name: "team-playbook", origin: "bootstrap", before: undefined }))!
    expect(staged.items.map((i) => i.text)).toEqual(["Prefix views with v_."])
    // One local rule edited, one removed.
    expect(staged.localChanges).toBe(2)
  })
})

describe("self-review fixes", () => {
  let server: ReturnType<typeof Bun.serve>
  let answer: (path: string, body: any) => Response = () => new Response("{}")
  const seen: { path: string; body: any }[] = []
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
  const ready = () => ({ status: "ready" as const, actAs: { url: `http://127.0.0.1:${server.port}`, instance: "t", apiKey: "k" }, scope: { apiUrl: `http://127.0.0.1:${server.port}`, tenant: "t", account: "a", datamateId: 1, repoRemote: "https://github.com/acme/demo" } })
  const item = (text: string) => ({ change: "add" as const, text, applies_to: [], origin: "session" as const, evidence_sessions: 1, corrections: [] })

  test("too_many_pending keeps the proposal queued; an uncoded 422 splits the batch and refuses only the bad item", async () => {
    const root = await tmp()
    await RulesSync.enqueue(root, item("waits"))
    answer = () => Response.json({ results: [{ index: 0, status: "invalid", error_code: "too_many_pending", error_detail: "50 pending" }] })
    expect((await RulesSync.push(root, ready())).queued).toBe(1)
    const root2 = await tmp()
    for (const text of ["fine", "bad"]) await RulesSync.enqueue(root2, item(text))
    answer = (_path, body) => body.items.some((i: { text: string }) => i.text === "bad")
      ? Response.json({ detail: [{ loc: ["body", "items", 0], msg: "too long" }] }, { status: 422 })
      : Response.json({ results: body.items.map((_: unknown, index: number) => ({ index, status: "pending", public_id: "p", version: 1 })) })
    const result = await RulesSync.push(root2, ready())
    expect(result.sent.map((s) => [s.text, s.status])).toEqual([["fine", "pending"], ["bad", "rejected"]])
    expect((await RulesStore.read(root2)).outbox).toEqual([])
  })

  test("a reset keeps what was already reported, so a relink does not count it again", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => {
      Object.assign(s, linked())
      s.usage_sessions = ["s1"]
      s.corrected_reported = { "R-0123456789ab": 2 }
      s.processed_signals = ["sig"]
    })
    await RulesStore.reset(root)
    const state = await RulesStore.read(root)
    expect(state).toMatchObject({ usage_sessions: ["s1"], corrected_reported: { "R-0123456789ab": 2 }, processed_signals: ["sig"] })
  })

  test("a project without a workspace never touches the team directory's playbook", async () => {
    const root = await tmp()
    const file = Store.paths(root, RulesStore.TEAM_STORE).approved
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "[]")
    await RulesStore.update(root, (s) => { s.personal_learning = false })
    expect((await fs.readdir(path.dirname(file))).filter((n) => n.startsWith("approved.json.before"))).toEqual([])
    expect(await fs.readdir(path.dirname(file))).not.toContain(".gitignore")
  })

  test("asking again from another session moves the card there", async () => {
    const root = await tmp()
    const draft = { text: "Use snake_case model names.", applies_to: [], change: "add" as const, origin: "explicit" as const, evidence: { sessions: 1 }, topics: [] }
    await RuleProposal.ask({ sessionID: "first", root, directory: root, learn: undefined, draft })
    const moved = (await RuleProposal.ask({ sessionID: "second", root, directory: root, learn: undefined, draft }))!
    expect(moved.sessionID).toBe("second")
    expect(RuleProposal.list(root, "second")).toHaveLength(1)
    RuleProposal.drop(root)
  })
})

describe("remember, whichever save tool the agent picks", () => {
  const env = { ...process.env }
  beforeAll(() => {
    delete process.env.ALTIMATE_DISABLE_WORKSPACE
    delete process.env.ALTIMATE_LEARN
    RuleProposal.setRendererForTest(true)
  })
  afterAll(() => {
    if (env.ALTIMATE_DISABLE_WORKSPACE !== undefined) process.env.ALTIMATE_DISABLE_WORKSPACE = env.ALTIMATE_DISABLE_WORKSPACE
    if (env.ALTIMATE_LEARN !== undefined) process.env.ALTIMATE_LEARN = env.ALTIMATE_LEARN
    RuleProposal.setRendererForTest(false)
  })
  const linkedRoot = async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    return root
  }

  test("with no client that shows cards attached, both save tools save as before cards", async () => {
    const root = await linkedRoot()
    RuleProposal.setRendererForTest(false)
    try {
      const said = "Remember as a rule: always use CTEs in staging models."
      const content = "Always use CTEs in staging models."
      expect(await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content, sessionID: "r0", said, via: "memory" })).toBeUndefined()
      expect(await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content, sessionID: "r0", said })).toBeUndefined()
      expect(RuleProposal.list(root)).toEqual([])
    } finally {
      RuleProposal.setRendererForTest(true)
    }
  })

  test("from the memory tool, only the text the person asked to remember gets a card", async () => {
    const root = await linkedRoot()
    const said = "Remember as a rule: always use CTEs in staging models."
    const other = await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "The orders model joins customers on customer_id.", sessionID: "r1", said, via: "memory" })
    expect(other).toBeUndefined()
    const asked = await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "Always use CTEs in staging models.", sessionID: "r1", said, via: "memory" })
    expect(asked?.output).toContain("Nothing was saved yet")
    RuleProposal.drop(root)
  })

  test("a requested rule that is not one line is sent back, not saved to memory; a long note is saved", async () => {
    const root = await linkedRoot()
    const long = "Always use CTEs in staging models and " + "keep every column explicit in the final select ".repeat(4)
    const rule = await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: long, sessionID: "r2", said: `Remember as a rule: ${long}`, via: "memory" })
    expect(rule?.title).toBe("Team rule: not proposed")
    const note = "The orders model joins customers on customer_id and filters test accounts in the final select " + "with a long explanation ".repeat(4)
    expect(await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: note, sessionID: "r2", said: `Remember: ${note}`, via: "memory" })).toBeUndefined()
  })

  test("an explicit rule is always a new rule, even when it shares words with a team rule", async () => {
    const root = await linkedRoot()
    await RulesStore.update(root, (s) => { s.rules = [rule("Staging models list their columns and never select star.")] })
    await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "Staging models always have a not_null test on the primary key columns.", sessionID: "r3", said: "Remember as a rule: staging models always have a not_null test on the primary key columns." })
    expect(RuleProposal.list(root, "r3")).toEqual([expect.objectContaining({ change: "add" })])
    expect(RuleProposal.list(root, "r3")[0].replaces).toBeUndefined()
    RuleProposal.drop(root)
  })

  test("an unclear \"remember\" saved as project memory becomes the Memory · Team rule · Skip card, and nothing is saved", async () => {
    const root = await linkedRoot()
    const said = "Remember: staging models live in models/staging."
    const result = await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "Staging models live in models/staging.", sessionID: "m1", said, via: "memory" })
    expect(result?.output).toContain("Nothing was saved yet")
    expect(RuleProposal.list(root, "m1")).toEqual([expect.objectContaining({ choose: true, actions: ["save_memory", "send", "dismiss"] })])
    RuleProposal.drop(root)
  })

  test("a fact the person asked to remember, or a note nobody asked for, is saved to memory as usual", async () => {
    const root = await linkedRoot()
    const fact = await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "Our warehouse is Snowflake in us-east-1.", sessionID: "m2", said: "Remember that our warehouse is Snowflake in us-east-1.", via: "memory" })
    expect(fact).toBeUndefined()
    const unasked = await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "Staging models live in models/staging.", sessionID: "m3", said: "Add a staging model for customers.", via: "memory" })
    expect(unasked).toBeUndefined()
    expect(RuleProposal.list(root)).toEqual([])
  })

  test("a project fact is classified as project-scoped memory", () => {
    expect(RuleClassify.memoryScope("Staging models live in models/staging.")).toBe("project")
  })
})

describe("telemetry", () => {
  const draft = { text: "Name boolean columns `is_<state>`.", applies_to: ["models/**"], change: "add" as const, origin: "session" as const, evidence: { sessions: 2, correction: { excerpt: "call it is_active", at: "2026-10-27T00:00:00Z" } }, topics: ["is_active"] }
  let events: Telemetry.Event[] = []
  let spy: ReturnType<typeof spyOn>
  beforeEach(() => {
    events = []
    spy = spyOn(Telemetry, "track").mockImplementation((event: Telemetry.Event) => void events.push(event))
  })
  afterEach(() => spy.mockRestore())
  const of = <T extends Telemetry.Event["type"]>(type: T) => events.filter((e): e is Extract<Telemetry.Event, { type: T }> => e.type === type)

  test("a card's showing and every answer are tracked, without its words", async () => {
    const root = await tmp()
    const card = (await RuleProposal.ask({ sessionID: "t1", root, directory: root, learn: undefined, draft }))!
    expect(of("rule_proposal_shown")).toEqual([expect.objectContaining({
      session_id: "t1", card_id: card.id, trigger: "recurrence", change: "add", linked: false, is_owner: false,
      actions: ["save_local", "edit", "dismiss"], evidence_sessions: 2, from_correction: true, applies_to_count: 1, repeat: false,
    })])
    await RuleProposal.reply(card.id, { action: "send" })
    await RuleProposal.reply(card.id, { action: "edit", text: "line one\nline two" })
    await RuleProposal.reply(card.id, { action: "edit", text: "Boolean columns start with `is_`." })
    await RuleProposal.reply(card.id, { action: "dismiss" })
    expect(of("rule_proposal_answered").map((e) => [e.action, e.status, e.outcome, e.edits])).toEqual([
      ["send", "not_available", undefined, 0],
      ["edit", "invalid_text", undefined, 0],
      ["edit", "ok", undefined, 1],
      ["dismiss", "ok", "dismissed", 1],
    ])
    const sent = JSON.stringify(events)
    for (const words of [draft.text, "Boolean columns", "is_active", "models/**"]) expect(sent).not.toContain(words)
  })

  test("asking again is a repeat; a dismissed topic is a skip, not a card", async () => {
    const root = await tmp()
    await RuleProposal.ask({ sessionID: "t2", root, directory: root, learn: undefined, draft: { ...draft, text: "Prefix views with `v_`." }, trigger: "shown_rule" })
    await RuleProposal.ask({ sessionID: "t2", root, directory: root, learn: undefined, draft: { ...draft, text: "Prefix views with `v_`." } })
    expect(of("rule_proposal_shown").map((e) => [e.trigger, e.repeat])).toEqual([["shown_rule", false], ["shown_rule", true]])
    await RulesStore.update(root, (s) => { s.dismissed.push({ topic: "is_active", until: new Date(Date.now() + 60_000).toISOString() }) })
    expect(await RuleProposal.ask({ sessionID: "t2", root, directory: root, learn: undefined, draft })).toBeUndefined()
    expect(of("rule_proposal_skipped")).toEqual([expect.objectContaining({ session_id: "t2", trigger: "recurrence", reason: "topic_dismissed" })])
  })

  test("a sync reports its trigger and outcome, never the reason text", async () => {
    const root = await tmp()
    await RulesSync.run(root, root, { enabled: false }, "manual")
    expect(of("rules_sync")).toEqual([expect.objectContaining({ trigger: "manual", status: "off", reason: "learning_off" })])
    const ready = { status: "ready" as const, actAs: { url: "http://x", instance: "t", apiKey: "k" }, scope: { apiUrl: "http://x", tenant: "t", account: "a", datamateId: 1, repoRemote: "https://github.com/acme/demo" } }
    RulesTelemetry.synced("refresh", {
      context: ready,
      push: { sent: [{ id: "o1", text: "Secret wording", status: "pending" }, { id: "o2", text: "x", status: "rejected", error: "too long" }], queued: 1 },
      pull: { ok: true, rules: 4, pending: 2, notices: [] },
      usage: { items: 3 },
    }, Date.now())
    expect(of("rules_sync")[1]).toMatchObject({ trigger: "refresh", status: "ok", rules: 4, pending: 2, sent: 1, refused: 1, queued: 1, notices: 0, usage_items: 3, push_failed: false, usage_failed: false })
    expect(JSON.stringify(events)).not.toContain("Secret wording")
  })

  test("\"remember\" with workspaces off, or in an unlinked project, is routed without a card", async () => {
    const root = await tmp()
    const env = process.env.ALTIMATE_DISABLE_WORKSPACE
    const remember = () => RulesRemember.proposeFor({ root, directory: root, learn: { enabled: true }, content: "Use CTEs.", sessionID: "t4", said: "remember: use CTEs" })
    try {
      process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
      expect(await remember()).toBeUndefined()
      process.env.ALTIMATE_DISABLE_WORKSPACE = "0"
      expect(await remember()).toBeUndefined()
    } finally {
      if (env === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
      else process.env.ALTIMATE_DISABLE_WORKSPACE = env
    }
    expect(of("rule_remember_routed").map((e) => [e.via, e.outcome])).toEqual([["training", "learning_off"], ["training", "not_linked"]])
  })
})

describe("review round three", () => {
  test("organisation-managed learn config beats a committed project setting", async () => {
    const root = await tmp()
    const managed = await tmp()
    await fs.mkdir(path.join(root, ".altimate-code"), { recursive: true })
    await fs.writeFile(path.join(root, ".altimate-code", "altimate-code.json"), JSON.stringify({ learn: { enabled: true, capture: true } }))
    await fs.writeFile(path.join(managed, "altimate-code.json"), JSON.stringify({ learn: { enabled: false } }))
    const env = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managed
    try {
      expect(await RulesService.effectiveLearn({ enabled: false }, root, root)).toMatchObject({ enabled: false, capture: true })
    } finally {
      if (env === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = env
    }
    expect(await RulesService.effectiveLearn({ enabled: false }, root, root)).toMatchObject({ enabled: true, capture: true })
  })

  test("team rules live in workspace-rules; a team playbook is the person's own store again", async () => {
    const root = await tmp()
    // An earlier build: state and mirror under `team/`, the person's own team playbook set aside.
    const legacy = path.join(root, ".altimate-code", "learn", "team")
    await fs.mkdir(legacy, { recursive: true })
    const own = JSON.stringify([{ id: "L-000000000001", text: "Our own rule.", tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" }])
    await fs.writeFile(path.join(legacy, "approved.json.before-workspace-rules-1"), own)
    await fs.writeFile(path.join(legacy, "rules.json"), JSON.stringify({ ...linked(), rules: [rule("Name staging models stg_<source>.")] }))
    await fs.writeFile(path.join(legacy, "approved.json"), canonicalMirror())
    await fs.writeFile(path.join(legacy, ".gitignore"), "*\n")
    expect((await RulesStore.read(root)).rules).toHaveLength(1)
    await RulesStore.update(root, () => {})
    expect(await fs.readFile(path.join(legacy, "approved.json"), "utf8")).toBe(own)
    expect(await fs.readdir(legacy)).toEqual(["approved.json"])
    expect(RulesStore.TEAM_STORE).toBe("workspace-rules")
    expect(parse(await fs.readFile(Store.paths(root, RulesStore.TEAM_STORE).approved, "utf8"))).toHaveLength(1)
  })

  test("a team playbook that is not ours is left alone by the migration", async () => {
    const root = await tmp()
    const legacy = path.join(root, ".altimate-code", "learn", "team")
    await fs.mkdir(legacy, { recursive: true })
    const own = JSON.stringify([{ id: "L-000000000001", text: "Our own rule.", tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" }])
    await fs.writeFile(path.join(legacy, "approved.json"), own)
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    expect(await fs.readFile(path.join(legacy, "approved.json"), "utf8")).toBe(own)
  })

  test("with no card client attached, the after-turn check leaves corrections for later", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    await appendSignal(root, { kind: "user_correction", sessionID: "t9", text: "no, call it ordered_at", reason: "correction" })
    RuleProposal.setRendererForTest(false)
    const deps = { source: async () => { throw new Error("not reached") }, generate: async () => { throw new Error("not reached") } } as unknown as RuleTrigger.TriggerDeps
    await RuleTrigger.afterTurn({ sessionID: "t9", root, directory: root, learn: { enabled: true, capture: true }, deps })
    const state = await RulesStore.read(root)
    expect(state.processed_signals).toEqual([])
    expect(state.last_check?.outcome).toContain("no client that shows cards")
  })

  test("a card already open in the session skips the after-turn check, and its corrections stay unprocessed", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    await appendSignal(root, { kind: "user_correction", sessionID: "t10", text: "no, call it shipped_at", reason: "correction" })
    RuleProposal.setRendererForTest(true)
    try {
      await RuleProposal.ask({ sessionID: "t10", root, directory: root, learn: undefined, draft: { text: "Name timestamps <event>_at.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } })
      const deps = { source: async () => { throw new Error("not reached") }, generate: async () => { throw new Error("not reached") } } as unknown as RuleTrigger.TriggerDeps
      await RuleTrigger.afterTurn({ sessionID: "t10", root, directory: root, learn: { enabled: true, capture: true }, deps })
      expect((await RulesStore.read(root)).processed_signals).toEqual([])
    } finally {
      RuleProposal.drop(root)
      RuleProposal.setRendererForTest(false)
    }
  })

  test("a dismissal stops counting once it expires, before any write drops it", () => {
    const state = RulesStore.State.parse({ version: 1, dismissed: [{ topic: "ordered_at", until: "2026-01-01T00:00:00Z" }] })
    expect(RulesStore.dismissed(state, "ordered_at", Date.parse("2025-12-31T00:00:00Z"))).toBe(true)
    expect(RulesStore.dismissed(state, "ordered_at", Date.parse("2026-01-02T00:00:00Z"))).toBe(false)
  })

  test("a restatement keeps the person's negation; just for me is personal; remember … for me stays in its clause", () => {
    expect(RulesRemember.restates("Use FLOAT for money.", "Remember: never use FLOAT for money")).toBe(false)
    expect(RulesRemember.restates("Never use FLOAT for money.", "Remember: never use FLOAT for money")).toBe(true)
    expect(RuleClassify.classify("Just for me, always use trailing commas").kind).toBe("memory")
    expect(RuleClassify.classify("Remember: the team always names models stg_, which is easier for me").kind).toBe("rule")
    expect(RuleClassify.classify("Remember this for me: I like trailing commas").kind).toBe("memory")
  })

  test("a sync whose push failed is not ok", () => {
    const events: unknown[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event: Telemetry.Event) => void events.push(event))
    try {
      const ready = { status: "ready" as const, actAs: { url: "http://x", instance: "t", apiKey: "k" }, scope: { apiUrl: "http://x", tenant: "t", account: "a", datamateId: 1, repoRemote: "https://github.com/acme/demo" } }
      RulesTelemetry.synced("refresh", { context: ready, push: { sent: [], queued: 2, error: "not bound" }, pull: { ok: true, rules: 1, pending: 0, notices: [] } }, Date.now())
    } finally {
      spy.mockRestore()
    }
    expect(events).toEqual([expect.objectContaining({ type: "rules_sync", status: "failed", push_failed: true, queued: 2 })])
  })
})

function canonicalMirror() {
  return JSON.stringify([{ id: "L-0123456789ab", text: "Name staging models stg_<source>.", tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-10-27T00:00:00Z", updated: "2026-10-27T00:00:00Z", provenance: "workspace rule 11111111-1111-1111-1111-111111111111 v1" }])
}

