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
import { Config } from "../../../src/config/config"
import { WorkspaceApi } from "../../../src/altimate/workspace/api-client"
import * as WorkspaceState from "../../../src/altimate/workspace/state"
import { RulesFromHistory } from "../../../src/altimate/rules/from-history"
import { RulesRemember } from "../../../src/altimate/rules/remember"
import { RulesTelemetry } from "../../../src/altimate/rules/telemetry"
import { RulesService } from "../../../src/altimate/rules/service"
import { RuleTrigger } from "../../../src/altimate/rules/trigger"
import { appendSignal } from "../../../src/altimate/learn/signals"
import { Telemetry } from "../../../src/altimate/telemetry"
import { parse } from "../../../src/altimate/learn/lesson"
import * as Store from "../../../src/altimate/learn/store"
import { Bus } from "../../../src/bus"
import { MemoryStore } from "../../../src/memory/store"
import { TrainingStore } from "../../../src/altimate/training"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

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
    const lessons = parse(await fs.readFile(Store.paths(root, RulesStore.WORKSPACE_RULES_STORE).approved, "utf8"))
    expect(lessons).toEqual([
      expect.objectContaining({ id: "L-0123456789ab", pinned: true, trigger: { paths: ["models/staging/**"] } }),
    ])
    expect(await fs.readFile(path.join(RulesStore.dir(root), ".gitignore"), "utf8")).toBe("*\n")
    await RulesStore.reset(root)
    expect(parse(await fs.readFile(Store.paths(root, RulesStore.WORKSPACE_RULES_STORE).approved, "utf8"))).toEqual([])
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
    const dismissed = await RulesStore.read(root)
    expect(RulesStore.dismissed(dismissed, "ordered_at")).toBe(true)
    // For 30 days, and no longer.
    const until = Date.parse(dismissed.dismissed.find((d) => d.topic === "ordered_at")!.until)
    expect(Math.abs(until - (Date.now() + 30 * 24 * 60 * 60_000))).toBeLessThan(60_000)
    expect(RulesStore.dismissed(dismissed, "ordered_at", until + 1)).toBe(false)
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
  let answer: (path: string, body: any) => Response | Promise<Response> = () => new Response("{}")
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
    // Pretend a batch went out and its answer was lost. Its sessions still have snapshots, so their pairs stay reported.
    const sessions = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(sessions, { recursive: true })
    for (const session of ["s1", "s2"]) await fs.writeFile(path.join(sessions, `${Store.sha256(session)}.json`), "{}")
    await RulesStore.update(root, (s) => {
      s.pending_usage = { batch_id: "batch-1", items: [{ public_id: "p-aaaaaaaaaaaa", applied: 2, helpful: 0, harmful: 0, corrected_again: 0 }], pairs: ["s1|p-aaaaaaaaaaaa", "s2|p-aaaaaaaaaaaa"], corrected: {} }
    })
    seen.length = 0
    answer = () => Response.json({ duplicate: true, applied_items: 1, skipped_items: 0 })
    await RulesSync.reportUsage(root, ready())
    expect(seen.find((r) => r.path === "/usage")?.body.batch_id).toBe("batch-1")
    const state = await RulesStore.read(root)
    expect(state.pending_usage).toBeUndefined()
    expect(state.usage_reported).toEqual(expect.arrayContaining(["s1|p-aaaaaaaaaaaa", "s2|p-aaaaaaaaaaaa"]))
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
      s.pending_usage = { batch_id: "batch-x", items: [{ public_id: "p-aaaaaaaaaaaa", applied: 1, helpful: 0, harmful: 0, corrected_again: 0 }], pairs: ["s1|p-aaaaaaaaaaaa"], corrected: {} }
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
      const state = { version: 1, session, firstMessage: "m", query: "q", touchedPaths: [], section: "", shown: [{ name: RulesStore.WORKSPACE_RULES_STORE, lesson: lesson(text), tier: "core", at: "2026-10-28T00:00:00Z", queryHash: "h" }], requests: [], requestParts: [], compactions: [], counted: [] }
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

  test("a request-wide uncoded 422 never drops the outbox, however many syncs it lasts; nor does one for a single item", async () => {
    const root = await tmp()
    for (const text of ["one", "two", "three"]) await RulesSync.enqueue(root, item(text))
    answer = () => Response.json({ detail: [{ msg: "invalid" }] }, { status: 422 })
    seen.length = 0
    for (let run = 0; run < 5; run++) expect((await RulesSync.push(root, ready())).queued).toBe(3)
    expect((await RulesStore.read(root)).outbox.map((e) => e.item.text)).toEqual(["one", "two", "three"])
    // Split once (the batch, then each item); after that, the same outbox goes as one request per sync.
    expect(seen.filter((r) => r.path === "/proposals")).toHaveLength(4 + 4)
    // A changed outbox is split again: the new item may be the bad one.
    await RulesSync.enqueue(root, item("four"))
    seen.length = 0
    await RulesSync.push(root, ready())
    expect(seen.filter((r) => r.path === "/proposals")).toHaveLength(5)
    const single = await tmp()
    await RulesSync.enqueue(single, item("Alone."))
    for (let run = 0; run < 5; run++) expect((await RulesSync.push(single, ready())).queued).toBe(1)
  })

  test("a rule a session shows on a later turn is counted, after the session was already reported", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([
      { ...rule("aaaaaaaaaaaa", "Name staging models stg_<source>."), public_id: "p-a" },
      { ...rule("bbbbbbbbbbbb", "Seeds live under seeds/reference."), public_id: "p-b" },
    ]))
    await RulesSync.pull(root, ready())
    const lesson = (key: string, text: string) => ({ id: RulesStore.lessonId(`R-${key}`), text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-10-27T00:00:00Z", updated: "2026-10-27T00:00:00Z" })
    const dir = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(dir, { recursive: true })
    const write = (shown: ReturnType<typeof lesson>[]) => fs.writeFile(path.join(dir, `${Store.sha256("s1")}.json`), JSON.stringify({
      version: 1, session: "s1", firstMessage: "m", query: "q", touchedPaths: [], section: "", requests: [], requestParts: [], compactions: [], counted: [],
      shown: shown.map((l) => ({ name: RulesStore.WORKSPACE_RULES_STORE, lesson: l, tier: "core", at: "2026-10-28T00:00:00Z", queryHash: "h" })),
    }))
    await write([lesson("aaaaaaaaaaaa", "Name staging models stg_<source>.")])
    seen.length = 0
    answer = () => Response.json({ duplicate: false, applied_items: 1, skipped_items: 0 })
    await RulesSync.reportUsage(root, ready())
    // Turn 4 of the same session shows a second rule.
    await write([lesson("aaaaaaaaaaaa", "Name staging models stg_<source>."), lesson("bbbbbbbbbbbb", "Seeds live under seeds/reference.")])
    await RulesSync.reportUsage(root, ready())
    const usage = seen.filter((r) => r.path === "/usage").map((r) => r.body.items.map((i: { public_id: string; applied: number }) => [i.public_id, i.applied]))
    expect(usage).toEqual([[["p-a", 1]], [["p-b", 1]]])
  })

  test("an approval that failed is still on the card when another run sent the proposal", async () => {
    const root = await tmp()
    const id = await RulesSync.enqueue(root, item("Approve me later."), "approve")
    answer = (p) => (p === "/proposals"
      ? Response.json({ results: [{ index: 0, status: "pending", public_id: "p-later", version: 1 }] })
      : new Response("unavailable", { status: 503 }))
    await RulesSync.push(root, ready())
    expect(RulesSync.outcomeOf(await RulesStore.read(root), undefined, id)).toMatchObject({ status: "sent", row: { public_id: "p-later", approve_retry: true } })
  })

  test("bootstrap sends its staged rules past one push's batch, up to the workspace's pending limit; the rest stay queued", async () => {
    const root = await tmp()
    const env = process.env.ALTIMATE_DISABLE_WORKSPACE
    delete process.env.ALTIMATE_DISABLE_WORKSPACE
    const url = `http://127.0.0.1:${server.port}`
    const spies = [
      spyOn(WorkspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 1, repoRemote: "https://github.com/acme/demo" } } as never),
      spyOn(WorkspaceApi, "captureCredentials").mockResolvedValue({ url, instance: "t", apiKey: "k" }),
      spyOn(WorkspaceState, "accountDigest").mockResolvedValue(WorkspaceState.credentialDigest(url, "t", "k")),
      spyOn(WorkspaceApi, "whoami").mockResolvedValue(7),
    ]
    let proposals = 0
    let pending = 0
    // The workspace keeps at most 50 pending proposals per person (`MAX_PENDING_PER_PROPOSER`).
    answer = (p, body) => {
      if (p === "/proposals") {
        proposals++
        return Response.json({ results: body.items.map((_: unknown, index: number) => pending < 50
          ? { index, status: "pending", public_id: `p-${proposals}-${index}-${pending++}`, version: 1 }
          : { index, status: "invalid", error_code: "too_many_pending", error_detail: "50 proposals are waiting for review" }) })
      }
      if (p === "/sync") return Response.json(syncBody([]))
      return Response.json({ duplicate: false, applied_items: 0, skipped_items: 0 })
    }
    try {
      // The scope this identity resolves to, as an earlier pull would have stored it.
      await RulesStore.update(root, (s) => Object.assign(s, linked(), { scope: { apiUrl: url, tenant: "t", account: "user:7", datamateId: 1, repoRemote: "https://github.com/acme/demo" } }))
      const items = Array.from({ length: 60 }, (_, i) => item(`Staged rule ${i}.`))
      const staged = { workspace: { name: "Team", owner: "Olive" }, scope: (await RulesStore.read(root)).scope!, items, invalid: [], localChanges: 0 }
      const result = await RulesFromHistory.sendStaged({ root, directory: root, learn: { enabled: true }, name: "team-playbook", staged, before: new Set() })
      expect(result).toMatchObject({ sent: 50, queued: 10, refused: 0, lost: 0 })
      expect(result.message).toContain("10 kept queued (50 proposals are waiting for review)")
      expect(proposals).toBe(2)
      expect((await RulesStore.read(root)).outbox).toHaveLength(10)
    } finally {
      for (const spy of spies) spy.mockRestore()
      if (env === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
      else process.env.ALTIMATE_DISABLE_WORKSPACE = env
    }
  })

  test("two pushes at once send each proposal once", async () => {
    const root = await tmp()
    await RulesSync.enqueue(root, item("Only once."))
    let proposals = 0
    answer = async (p) => {
      if (p !== "/proposals") return new Response("{}")
      proposals++
      await Bun.sleep(150)
      return Response.json({ results: [{ index: 0, status: "pending", public_id: "p-once", version: 1 }] })
    }
    await Promise.all([RulesSync.push(root, ready()), RulesSync.push(root, ready())])
    expect(proposals).toBe(1)
    expect((await RulesStore.read(root)).outbox).toEqual([])
  })

  test("a dropped usage batch marks its sessions reported, so the same batch is not rebuilt", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([rule("aaaaaaaaaaaa", "Name staging models stg_<source>.")]))
    await RulesSync.pull(root, ready())
    await RulesStore.update(root, (s) => {
      s.pending_usage = { batch_id: "batch-y", items: [{ public_id: "p-aaaaaaaaaaaa", applied: 1, helpful: 0, harmful: 0, corrected_again: 0 }], pairs: ["s9|p-aaaaaaaaaaaa"], corrected: { "R-aaaaaaaaaaaa": 1 } }
    })
    // s9 still has a snapshot, so its pair is kept (a pair whose session is gone is let go).
    const sessions = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(sessions, { recursive: true })
    await fs.writeFile(path.join(sessions, `${Store.sha256("s9")}.json`), "{}")
    answer = () => Response.json({ detail: { code: "batch_conflict", message: "conflict" } }, { status: 409 })
    await RulesSync.reportUsage(root, ready())
    const state = await RulesStore.read(root)
    expect(state.pending_usage).toBeUndefined()
    expect(state.usage_reported).toContain("s9|p-aaaaaaaaaaaa")
    expect(state.corrected_reported["R-aaaaaaaaaaaa"]).toBe(1)
  })

  // A full sync as the signed-in user `user`: binding, credentials and `GET /users/me` stubbed, the server above.
  const asUser = (user: number) => {
    const url = `http://127.0.0.1:${server.port}`
    const key = `key-${user}`
    const env = process.env.ALTIMATE_DISABLE_WORKSPACE
    delete process.env.ALTIMATE_DISABLE_WORKSPACE
    const spies: { mockRestore(): void }[] = [
      spyOn(WorkspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 1, repoRemote: "https://github.com/acme/demo" } } as never),
      spyOn(WorkspaceApi, "captureCredentials").mockResolvedValue({ url, instance: "t", apiKey: key }),
      spyOn(WorkspaceState, "accountDigest").mockResolvedValue(WorkspaceState.credentialDigest(url, "t", key)),
      spyOn(WorkspaceApi, "whoami").mockResolvedValue(user),
    ]
    return {
      scope: { ...scope(), account: `user:${user}` },
      [Symbol.dispose]() {
        for (const spy of spies) spy.mockRestore()
        if (env === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
        else process.env.ALTIMATE_DISABLE_WORKSPACE = env
      },
    }
  }

  test("an account change drops the queued proposals, and the same sync's pull does not erase the notice", async () => {
    const root = await tmp()
    using user = asUser(8)
    await RulesStore.update(root, (s) => Object.assign(s, linked(), { scope: { ...user.scope, account: "user:7" } }))
    await RulesSync.enqueue(root, item("Queued for user 7."))
    answer = (p) => (p === "/sync" ? Response.json(syncBody([])) : Response.json({ duplicate: false, applied_items: 0, skipped_items: 0 }))
    seen.length = 0
    const report = await RulesSync.run(root, root, { enabled: true }, "manual")
    expect(report.pull).toMatchObject({ ok: true })
    expect(seen.filter((r) => r.path === "/proposals")).toEqual([])
    const state = await RulesStore.read(root)
    expect(state.outbox).toEqual([])
    expect(state.scope?.account).toBe("user:8")
    expect((await RulesSummary.summary(root, { enabled: true })).last_error).toContain("1 queued proposal was for another account or workspace")
  })

  test("a review notice is announced once, however many callers wait on the sync that pulled it", async () => {
    const root = await tmp()
    using user = asUser(7)
    await RulesStore.update(root, (s) => Object.assign(s, linked(), { scope: user.scope }))
    const reviewed = { public_id: "p-1", rule_key: "R-1", text: "Use cents.", change: "add", status: "active", reviewed_by_name: "Olive", reviewed_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T00:00:00Z" }
    answer = async (p) => {
      await Bun.sleep(20)
      return p === "/sync" ? Response.json(syncBody([], { my_reviewed: [reviewed] })) : Response.json({ duplicate: false, applied_items: 0, skipped_items: 0 })
    }
    const published: string[] = []
    const bus = spyOn(Bus, "publish").mockImplementation((async (def: { type: string }) => void published.push(def.type)) as never)
    try {
      await Promise.all([
        RulesService.syncNow(root, root, { enabled: true }, "manual"),
        RulesSync.runShared(root, root, { enabled: true }),
        RulesSync.sessionStart(root, root, { enabled: true }, { waitMs: 5_000 }),
      ])
    } finally {
      bus.mockRestore()
    }
    expect(published.filter((type) => type === "rule.proposal.reviewed")).toHaveLength(1)
    expect(published.filter((type) => type === "altimate.rules.changed")).toHaveLength(1)
  })

  test("answers to proposals sent for one account are not written into another account's state", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => { s.scope = scope() })
    await RulesSync.enqueue(root, item("Sent before the switch."))
    answer = async () => {
      // Another process adopted the state for someone else while this request was out.
      await RulesStore.update(root, (s) => { s.scope = { ...scope(), account: "someone-else" } })
      return Response.json({ results: [{ index: 0, status: "pending", public_id: "p-switch", version: 1 }] })
    }
    expect((await RulesSync.push(root, ready())).sent).toEqual([])
    const state = await RulesStore.read(root)
    expect(state.push_outcomes).toEqual({})
    expect(state.sent).toEqual([])
  })

  test("a busy state lock after sending is waited out: the sent proposal still leaves the outbox", async () => {
    const root = await tmp()
    await RulesSync.enqueue(root, item("Recorded late."))
    answer = () => Response.json({ results: [{ index: 0, status: "pending", public_id: "p-late", version: 1 }] })
    const update = RulesStore.update
    let failures = 0
    const spy = spyOn(RulesStore, "update").mockImplementation((async (...args: Parameters<typeof update>) => {
      if (failures++ === 0) throw new Error("Timed out waiting for lock: learn-state")
      return update(...args)
    }) as never)
    try {
      expect(await RulesSync.push(root, ready())).toMatchObject({ queued: 0, sent: [expect.objectContaining({ public_id: "p-late" })] })
    } finally {
      spy.mockRestore()
    }
    expect(failures).toBe(2)
    expect((await RulesStore.read(root)).outbox).toEqual([])
  })

  test("a write that fails after the state was saved is not applied again, and is not taken for another sender", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => { s.scope = scope() })
    await RulesSync.enqueue(root, item("Counted once."))
    answer = () => Response.json({ results: [{ index: 0, status: "pending", public_id: "p-once", version: 1 }] })
    const update = RulesStore.update
    let calls = 0
    // As if the mirror write failed after `rules.json` was written.
    const spy = spyOn(RulesStore, "update").mockImplementation((async (...args: Parameters<typeof update>) => {
      const written = await update(...args)
      if (calls++ === 0) throw new Error("EACCES: approved.json")
      return written
    }) as never)
    try {
      await expect(RulesSync.push(root, ready())).rejects.toThrow("EACCES")
    } finally {
      spy.mockRestore()
    }
    expect(calls).toBe(1)
    const state = await RulesStore.read(root)
    expect(state.pending_count).toBe(1)
    expect(state.sent.filter((s) => s.public_id === "p-once")).toHaveLength(1)
  })

  test("a learn lock that stays busy fails the push; it is not reported as another sync sending", async () => {
    const root = await tmp()
    await RulesSync.enqueue(root, item("Lock busy."))
    answer = () => Response.json({ results: [{ index: 0, status: "pending", public_id: "p-busy", version: 1 }] })
    const update = RulesStore.update
    const spy = spyOn(RulesStore, "update").mockImplementation((async () => {
      throw new Error("Timed out waiting for lock: learn-state")
    }) as never)
    try {
      await expect(RulesSync.push(root, ready())).rejects.toThrow("learn-state")
    } finally {
      spy.mockRestore()
    }
    void update
  })

  test("an \"Approve now\" is kept as pending before its review is asked, so a crash cannot lose it", async () => {
    const root = await tmp()
    await RulesSync.enqueue(root, item("Approve durably."), "approve")
    let intent: unknown
    answer = async (p) => {
      if (p === "/proposals") return Response.json({ results: [{ index: 0, status: "pending", public_id: "p-durable", version: 1 }] })
      // While the review is being asked, the intent is already on disk.
      intent = (await RulesStore.read(root)).pending_approvals
      return Response.json({ public_id: "p-durable", status: "active", version: 1 })
    }
    await RulesSync.push(root, ready())
    expect(intent).toEqual([expect.objectContaining({ public_id: "p-durable", action: "approve" })])
    const state = await RulesStore.read(root)
    expect(state.outbox).toEqual([])
    expect(state.pending_approvals).toEqual([])
    expect(state.sent.find((s) => s.public_id === "p-durable")?.status).toBe("active")
  })

  test("a committed project file cannot pose as an organization policy", async () => {
    const root = await tmp()
    await fs.mkdir(path.join(root, ".altimate-code"), { recursive: true })
    await fs.writeFile(path.join(root, ".altimate-code", "altimate-code.json"), JSON.stringify({ learn: { capture: true, capture_policy: true } }))
    const learn = await RulesService.effectiveLearn(undefined, root, root)
    expect(learn).toEqual({ capture: true })
    expect(learningDecision(learn, RulesStore.State.parse({ version: 1, personal_learning: false }), {})).toEqual({ on: false, source: "you" })
  })

  test("the dropped-proposals notice stops showing after a week, without any write", () => {
    const state = RulesStore.State.parse({ version: 1, scope_drop: { count: 2, at: "2026-10-01T00:00:00Z" } })
    expect(RulesStore.scopeDropNote(state, Date.parse("2026-10-07T00:00:00Z"))).toContain("2 queued proposals")
    expect(RulesStore.scopeDropNote(state, Date.parse("2026-10-09T00:00:00Z"))).toBeUndefined()
  })

  test("with no session snapshots at all, reported usage is let go", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([{ ...rule("aaaaaaaaaaaa", "Name staging models stg_<source>."), public_id: "p-a" }]))
    await RulesSync.pull(root, ready())
    await RulesStore.update(root, (s) => { s.usage_reported = ["gone|p-a"] })
    await RulesSync.reportUsage(root, ready())
    expect((await RulesStore.read(root)).usage_reported).toEqual([])
  })

  test("reported usage is kept while its session has a snapshot, and let go once the snapshot is gone", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([{ ...rule("aaaaaaaaaaaa", "Name staging models stg_<source>."), public_id: "p-a" }]))
    await RulesSync.pull(root, ready())
    const dir = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(dir, { recursive: true })
    const lesson = { id: RulesStore.lessonId("R-aaaaaaaaaaaa"), text: "Name staging models stg_<source>.", tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-10-27T00:00:00Z", updated: "2026-10-27T00:00:00Z" }
    await fs.writeFile(path.join(dir, `${Store.sha256("kept")}.json`), JSON.stringify({
      version: 1, session: "kept", firstMessage: "m", query: "q", touchedPaths: [], section: "", requests: [], requestParts: [], compactions: [], counted: [],
      shown: [{ name: RulesStore.WORKSPACE_RULES_STORE, lesson, tier: "core", at: "2026-10-28T00:00:00Z", queryHash: "h" }],
    }))
    await RulesStore.update(root, (s) => { s.usage_reported = ["gone|p-a", "kept|p-a"] })
    seen.length = 0
    expect(await RulesSync.reportUsage(root, ready())).toEqual({ items: 0 })
    expect(seen.filter((r) => r.path === "/usage")).toEqual([])
    expect((await RulesStore.read(root)).usage_reported).toEqual(["kept|p-a"])
  })

  test("the first team rule after none replaces the empty mirror without setting it aside", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([]))
    await RulesSync.pull(root, ready())
    answer = () => Response.json(syncBody([rule("aaaaaaaaaaaa", "Name staging models stg_<source>.")], { revision: 4 }))
    await RulesSync.pull(root, ready())
    const file = Store.paths(root, RulesStore.WORKSPACE_RULES_STORE).approved
    expect(parse(await fs.readFile(file, "utf8"))).toHaveLength(1)
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("approved.json.before"))).toEqual([])
  })

  test("bootstrap keeps sending while older queued proposals are ahead of its own", async () => {
    const root = await tmp()
    using user = asUser(7)
    await RulesStore.update(root, (s) => Object.assign(s, linked(), { scope: user.scope }))
    await RulesSync.enqueueMany(root, Array.from({ length: 120 }, (_, i) => ({ item: item(`Older ${i}.`) })))
    answer = (p, body) => p === "/proposals"
      ? Response.json({ results: body.items.map((it: { text: string }, index: number) => ({ index, status: "pending", public_id: `p-${it.text}`, version: 1 })) })
      : p === "/sync" ? Response.json(syncBody([])) : Response.json({ duplicate: false, applied_items: 0, skipped_items: 0 })
    const staged = { workspace: { name: "Team", owner: "Olive" }, scope: user.scope, items: [item("Mine, last in line.")], invalid: [], localChanges: 0 }
    const result = await RulesFromHistory.sendStaged({ root, directory: root, learn: { enabled: true }, name: "team-playbook", staged, before: new Set() })
    expect(result).toMatchObject({ sent: 1, queued: 0 })
    expect((await RulesStore.read(root)).outbox).toEqual([])
  })

  test("signing out stops delivering the pulled team rules, and keeps the queue", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked(), { scope: scope(), rules: [rule("aaaaaaaaaaaa", "Name staging models stg_<source>.")] }))
    await RulesSync.enqueue(root, item("Still queued."))
    const env = process.env.ALTIMATE_DISABLE_WORKSPACE
    delete process.env.ALTIMATE_DISABLE_WORKSPACE
    const spies: { mockRestore(): void }[] = [
      spyOn(WorkspaceState, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding: { datamateId: 1, repoRemote: "https://github.com/acme/demo" } } as never),
      spyOn(WorkspaceApi, "captureCredentials").mockResolvedValue(undefined as never),
    ]
    try {
      expect((await RulesSync.run(root, root, { enabled: true })).context).toMatchObject({ status: "skipped", code: "not_signed_in" })
    } finally {
      for (const spy of spies) spy.mockRestore()
      if (env === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
      else process.env.ALTIMATE_DISABLE_WORKSPACE = env
    }
    const state = await RulesStore.read(root)
    expect(state.rules).toEqual([])
    expect(state.workspace).toBeUndefined()
    expect(state.outbox.map((e) => e.item.text)).toEqual(["Still queued."])
    expect(parse(await fs.readFile(Store.paths(root, RulesStore.WORKSPACE_RULES_STORE).approved, "utf8"))).toEqual([])
  })

  test("a pull's answer is not applied to state another process adopted or advanced meanwhile", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked(), { scope: scope(), revision: 2 }))
    answer = async () => {
      // Meanwhile another process adopted someone else's scope.
      await RulesStore.update(root, (s) => { s.scope = { ...scope(), account: "someone-else" } })
      return Response.json(syncBody([rule("aaaaaaaaaaaa", "Name staging models stg_<source>.")], { revision: 3 }))
    }
    await RulesSync.pull(root, ready())
    let state = await RulesStore.read(root)
    expect(state.scope?.account).toBe("someone-else")
    expect(state.rules).toEqual([])
    // An older revision than the one already applied is not applied either.
    const newer = await tmp()
    await RulesStore.update(newer, (s) => Object.assign(s, linked(), { scope: scope(), revision: 9, rules: [rule("bbbbbbbbbbbb", "Seeds live under seeds/reference.")] }))
    answer = () => Response.json(syncBody([], { revision: 4 }))
    await RulesSync.pull(newer, ready())
    state = await RulesStore.read(newer)
    expect(state.revision).toBe(9)
    expect(state.rules.map((r) => r.text)).toEqual(["Seeds live under seeds/reference."])
  })

  test("a retried \"Approve now\" whose earlier attempt landed counts as approved", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => {
      Object.assign(s, linked(), { scope: scope() })
      s.sent.push({ public_id: "p-landed", text: "Approved already.", change: "add", status: "pending", sent_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T00:00:00Z" })
      s.pending_approvals.push({ public_id: "p-landed", version: 1, action: "approve", attempts: 1 })
    })
    answer = () => Response.json({ detail: { code: "invalid_status", message: "The rule is active", status: "active", version: 1 } }, { status: 409 })
    const pushed = await RulesSync.push(root, ready())
    expect(pushed.approval_error).toBeUndefined()
    const state = await RulesStore.read(root)
    expect(state.pending_approvals).toEqual([])
    expect(state.sent[0]).toMatchObject({ status: "active" })
    expect(state.sent[0].reason).toBeUndefined()
  })

  test("a resend the server answers as an already-pending proposal is not counted twice", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => {
      Object.assign(s, linked(), { scope: scope(), pending_count: 1 })
      s.sent.push({ public_id: "p-dup", text: "Once.", change: "add", status: "pending", sent_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T00:00:00Z" })
    })
    await RulesSync.enqueue(root, item("Once."))
    answer = () => Response.json({ results: [{ index: 0, status: "pending", public_id: "p-dup", version: 1, duplicate: true }] })
    await RulesSync.push(root, ready())
    expect((await RulesStore.read(root)).pending_count).toBe(1)
  })

  test("usage is reported before a pull that retires the rule it counts", async () => {
    const root = await tmp()
    using user = asUser(7)
    await RulesStore.update(root, (s) => Object.assign(s, linked(), { scope: user.scope, rules: [{ ...rule("aaaaaaaaaaaa", "Name staging models stg_<source>."), public_id: "p-old" }] }))
    const dir = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(dir, { recursive: true })
    const lesson = { id: RulesStore.lessonId("R-aaaaaaaaaaaa"), text: "Name staging models stg_<source>.", tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-10-27T00:00:00Z", updated: "2026-10-27T00:00:00Z" }
    await fs.writeFile(path.join(dir, `${Store.sha256("s-old")}.json`), JSON.stringify({
      version: 1, session: "s-old", firstMessage: "m", query: "q", touchedPaths: [], section: "", requests: [], requestParts: [], compactions: [], counted: [],
      shown: [{ name: RulesStore.WORKSPACE_RULES_STORE, lesson, tier: "core", at: "2026-10-28T00:00:00Z", queryHash: "h" }],
    }))
    seen.length = 0
    answer = (p) => p === "/sync" ? Response.json(syncBody([])) : Response.json({ duplicate: false, applied_items: 1, skipped_items: 0 })
    await RulesSync.run(root, root, { enabled: true }, "manual")
    expect(seen.find((r) => r.path === "/usage")?.body.items).toEqual([expect.objectContaining({ public_id: "p-old", applied: 1 })])
    expect((await RulesStore.read(root)).rules).toEqual([])
  })

  test("bootstrap queues only what the outbox has room for and keeps the rest local", async () => {
    const root = await tmp()
    using user = asUser(7)
    await RulesStore.update(root, (s) => Object.assign(s, linked(), { scope: user.scope }))
    await RulesSync.enqueueMany(root, Array.from({ length: RulesStore.MAX_OUTBOX - 5 }, (_, i) => ({ item: item(`Older ${i}.`) })))
    // The workspace is unreachable for this run: everything stays queued.
    answer = () => new Response("unavailable", { status: 503 })
    const staged = { workspace: { name: "Team", owner: "Olive" }, scope: user.scope, items: Array.from({ length: 8 }, (_, i) => item(`Mine ${i}.`)), invalid: [], localChanges: 0 }
    const result = await RulesFromHistory.sendStaged({ root, directory: root, learn: { enabled: true }, name: "team-playbook", staged, before: new Set() })
    expect(result).toMatchObject({ held: 3, queued: 5 })
    expect(result.message).toContain("3 not sent: the queue of proposals waiting to be sent is full")
    expect((await RulesStore.read(root)).outbox).toHaveLength(RulesStore.MAX_OUTBOX)
  })

  test("bootstrap does not queue rules listed for another account or workspace", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked(), { scope: { ...scope(), account: "someone-else" } }))
    const staged = { workspace: { name: "Team", owner: "Olive" }, scope: scope(), items: [item("Listed for the other one.")], invalid: [], localChanges: 0 }
    const result = await RulesFromHistory.sendStaged({ root, directory: root, learn: { enabled: true }, name: "team-playbook", staged, before: new Set() })
    expect(result).toMatchObject({ sent: 0, held: 1 })
    expect((await RulesStore.read(root)).outbox).toEqual([])
  })

  test("one review row or field this version cannot read, or a rule that fails the lint, does not fail the pull", async () => {
    const root = await tmp()
    const good = { public_id: "p-ok", rule_key: "R-1", text: "Use cents.", change: "add", status: "active", reviewed_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T00:00:00Z" }
    answer = () => Response.json(syncBody([
      rule("aaaaaaaaaaaa", "Name staging models stg_<source>."),
      rule("bbbbbbbbbbbb", "Line one\nline two."),
    ], { repo_identity: null, my_reviewed: [{ ...good, updated_at: null, public_id: "p-bad" }, good] }))
    const pulled = await RulesSync.pull(root, ready())
    expect(pulled).toMatchObject({ ok: true, rules: 1 })
    expect(pulled.notices.map((n) => n.public_id)).toEqual(["p-ok"])
    const state = await RulesStore.read(root)
    expect(state.revision).toBeUndefined()
    expect(state.last_error).toContain("did not pass the rule lint")
  })

  test("usage built for another account or workspace is neither sent nor marked reported", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([rule("aaaaaaaaaaaa", "Name staging models stg_<source>.")]))
    await RulesSync.pull(root, ready())
    await RulesStore.update(root, (s) => {
      s.pending_usage = { batch_id: "batch-other", scope: { ...scope(), account: "someone-else" }, items: [{ public_id: "p-aaaaaaaaaaaa", applied: 1, helpful: 0, harmful: 0, corrected_again: 0 }], pairs: ["s1|p-aaaaaaaaaaaa"], corrected: {} }
    })
    seen.length = 0
    expect(await RulesSync.reportUsage(root, ready())).toEqual({ items: 0 })
    expect(seen.filter((r) => r.path === "/usage")).toEqual([])
    const state = await RulesStore.read(root)
    expect(state.pending_usage?.batch_id).toBe("batch-other")
    expect(state.usage_reported).toEqual([])
  })

  test("a reported pair is let go once its session's snapshot is older than three months", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([{ ...rule("aaaaaaaaaaaa", "Name staging models stg_<source>."), public_id: "p-a" }]))
    await RulesSync.pull(root, ready())
    const dir = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(dir, { recursive: true })
    for (const session of ["old", "recent"]) await fs.writeFile(path.join(dir, `${Store.sha256(session)}.json`), "{}")
    const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60_000)
    await fs.utimes(path.join(dir, `${Store.sha256("old")}.json`), longAgo, longAgo)
    await RulesStore.update(root, (s) => { s.usage_reported = ["old|p-a", "recent|p-a"] })
    await RulesSync.reportUsage(root, ready())
    expect((await RulesStore.read(root)).usage_reported).toEqual(["recent|p-a"])
  })

  test("a push lock that cannot be taken for another reason fails the push; only a busy one reads as another sender", async () => {
    const root = await tmp()
    await RulesSync.enqueue(root, item("Lock trouble."))
    const { Flock } = await import("@opencode-ai/core/util/flock")
    const spy = spyOn(Flock, "withLock").mockRejectedValueOnce(new Error("EACCES: permission denied, mkdir rules-push.lock"))
    try {
      await expect(RulesSync.push(root, ready())).rejects.toThrow("EACCES")
      spy.mockRejectedValueOnce(new Error("Timed out waiting for lock: rules-push"))
      expect(await RulesSync.push(root, ready())).toMatchObject({ queued: 1, error: "another sync is still sending proposals" })
    } finally {
      spy.mockRestore()
    }
  })

  test("a session older than the window is neither counted nor remembered, so it is not counted again on every sync", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([{ ...rule("aaaaaaaaaaaa", "Name staging models stg_<source>."), public_id: "p-a" }]))
    await RulesSync.pull(root, ready())
    const dir = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(dir, { recursive: true })
    const lesson = { id: RulesStore.lessonId("R-aaaaaaaaaaaa"), text: "Name staging models stg_<source>.", tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-10-27T00:00:00Z", updated: "2026-10-27T00:00:00Z" }
    const file = path.join(dir, `${Store.sha256("ancient")}.json`)
    await fs.writeFile(file, JSON.stringify({
      version: 1, session: "ancient", firstMessage: "m", query: "q", touchedPaths: [], section: "", requests: [], requestParts: [], compactions: [], counted: [],
      shown: [{ name: RulesStore.WORKSPACE_RULES_STORE, lesson, tier: "core", at: "2026-09-01T00:00:00Z", queryHash: "h" }],
    }))
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60_000)
    await fs.utimes(file, longAgo, longAgo)
    await RulesStore.update(root, (s) => { s.usage_reported = ["ancient|p-a"] })
    seen.length = 0
    answer = () => Response.json({ duplicate: false, applied_items: 1, skipped_items: 0 })
    for (let run = 0; run < 3; run++) await RulesSync.reportUsage(root, ready())
    expect(seen.filter((r) => r.path === "/usage")).toEqual([])
    // Remembered longer than it can be counted: resumed within that time, it is not counted again.
    expect((await RulesStore.read(root)).usage_reported).toEqual(["ancient|p-a"])
  })

  test("a usage batch another scope saved while this run counted is not sent with this run's credential", async () => {
    const root = await tmp()
    answer = () => Response.json(syncBody([{ ...rule("aaaaaaaaaaaa", "Name staging models stg_<source>."), public_id: "p-a" }]))
    await RulesSync.pull(root, ready())
    const dir = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(dir, { recursive: true })
    const lesson = { id: RulesStore.lessonId("R-aaaaaaaaaaaa"), text: "Name staging models stg_<source>.", tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-10-27T00:00:00Z", updated: "2026-10-27T00:00:00Z" }
    await fs.writeFile(path.join(dir, `${Store.sha256("s-now")}.json`), JSON.stringify({
      version: 1, session: "s-now", firstMessage: "m", query: "q", touchedPaths: [], section: "", requests: [], requestParts: [], compactions: [], counted: [],
      shown: [{ name: RulesStore.WORKSPACE_RULES_STORE, lesson, tier: "core", at: "2026-10-28T00:00:00Z", queryHash: "h" }],
    }))
    const recurrence = await import("../../../src/altimate/learn/recurrence")
    const real = recurrence.analyzeRecurrence
    // While this run counts, another process saves a batch for someone else's scope.
    const spy = spyOn(recurrence, "analyzeRecurrence").mockImplementation((async (...args: Parameters<typeof real>) => {
      await RulesStore.update(root, (s) => {
        s.pending_usage = { batch_id: "batch-foreign", scope: { ...scope(), account: "someone-else" }, items: [{ public_id: "p-a", applied: 1, helpful: 0, harmful: 0, corrected_again: 0 }], pairs: ["s-other|p-a"], corrected: {} }
      })
      return real(...args)
    }) as never)
    seen.length = 0
    try {
      expect(await RulesSync.reportUsage(root, ready())).toEqual({ items: 0 })
    } finally {
      spy.mockRestore()
    }
    expect(seen.filter((r) => r.path === "/usage")).toEqual([])
    expect((await RulesStore.read(root)).pending_usage?.batch_id).toBe("batch-foreign")
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

  test("with workspaces off, a saved workspace's Learn from sessions decides nothing", () => {
    const saved = state({ settings: { learning_enabled: true } } as Partial<RulesStore.State>)
    expect(learningDecision(undefined, saved, {})).toEqual({ on: true, source: "workspace" })
    expect(learningDecision(undefined, saved, { ALTIMATE_DISABLE_WORKSPACE: "1" })).toEqual({ on: false, source: "default" })
    expect(learningDecision({ capture: true }, saved, { ALTIMATE_DISABLE_WORKSPACE: "1" })).toEqual({ on: true, source: "you" })
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

  test("cards of a disposed project are dropped", async () => {
    const root = await tmp()
    await RuleProposal.ask({ sessionID: "x1", root, directory: root, learn: undefined, draft: draft("Prefix seeds with seed_.") })
    expect(RuleProposal.list(root)).toHaveLength(1)
    await RuleProposal.drop(root)
    expect(RuleProposal.list(root)).toHaveLength(0)
  })

  test("an unanswered card expires after a day, and one the person asked for is then saved as before cards", async () => {
    const root = await tmp()
    const saved: string[] = []
    await RuleProposal.ask({ sessionID: "x2", root, directory: root, learn: undefined, draft: draft("Prefix snapshots with snap_."), unanswered: async (text) => void saved.push(text) })
    const asked = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(asked + RuleProposal.CARD_TTL_MS - 1_000)
    try {
      expect(RuleProposal.list(root)).toHaveLength(1)
      clock.mockReturnValue(asked + RuleProposal.CARD_TTL_MS + 1_000)
      expect(RuleProposal.list(root)).toHaveLength(0)
    } finally {
      clock.mockRestore()
    }
    await Bun.sleep(0)
    expect(saved).toEqual(["Prefix snapshots with snap_."])
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
    await expect(Store.reject(root, RulesStore.WORKSPACE_RULES_STORE)).rejects.toThrow(/workspace's team rules/)
    await expect(Store.promote(root, RulesStore.WORKSPACE_RULES_STORE)).rejects.toThrow(/workspace's team rules/)
  })

  test("a playbook someone already named team is set aside, not overwritten", async () => {
    const root = await tmp()
    const file = Store.paths(root, RulesStore.WORKSPACE_RULES_STORE).approved
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
  const env = process.env.ALTIMATE_DISABLE_WORKSPACE
  beforeAll(() => { delete process.env.ALTIMATE_DISABLE_WORKSPACE })
  afterAll(() => {
    if (env === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
    else process.env.ALTIMATE_DISABLE_WORKSPACE = env
  })
  test("only valid rules are offered, scoped like a card, and nothing is offered when not linked", async () => {
    const root = await tmp()
    expect(await RulesFromHistory.stagedRules({ root, name: "team-playbook", origin: "bootstrap", before: undefined, learn: { enabled: true } })).toBeUndefined()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    const lesson = (id: string, text: string, paths: string[] = []) =>
      ({ id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z", ...(paths.length ? { trigger: { paths } } : {}) })
    const file = Store.paths(root, "team-playbook").candidate
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify([
      lesson("L-aaaaaaaaaaaa", "Name staging models stg_<source>.", ["a/**", "b/**", "c/**", "d/**", "e/**"]),
      lesson("L-bbbbbbbbbbbb", "Run `rm -rf /` to clean up."),
    ]))
    const staged = (await RulesFromHistory.stagedRules({ root, name: "team-playbook", origin: "bootstrap", before: undefined, learn: { enabled: true } }))!
    expect(staged.workspace).toEqual({ name: "Team", owner: "Olive" })
    expect(staged.items.map((i) => i.text)).toEqual(["Name staging models stg_<source>."])
    expect(staged.items[0].applies_to).toHaveLength(4)
    expect(staged.invalid).toHaveLength(1)
  })

  test("with learning or workspaces off nothing is offered for review", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    expect(await RulesFromHistory.stagedRules({ root, name: "team-playbook", origin: "bootstrap", before: undefined, learn: { enabled: false } })).toBeUndefined()
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
    const staged = (await RulesFromHistory.stagedRules({ root, name: "team-playbook", origin: "bootstrap", before: undefined, learn: { enabled: true } }))!
    expect(staged.items.map((i) => i.text)).toEqual(["Prefix views with v_."])
    // One local rule edited, one removed.
    expect(staged.localChanges).toBe(2)
  })
})

describe("outbox, approvals and resets", () => {
  let server: ReturnType<typeof Bun.serve>
  let answer: (path: string, body: any) => Response | Promise<Response> = () => new Response("{}")
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
      s.usage_reported = ["s1|p-1"]
      s.corrected_reported = { "R-0123456789ab": 2 }
      s.processed_signals = ["sig"]
    })
    await RulesStore.reset(root)
    const state = await RulesStore.read(root)
    expect(state).toMatchObject({ usage_reported: ["s1|p-1"], corrected_reported: { "R-0123456789ab": 2 }, processed_signals: ["sig"] })
  })

  test("a project without a workspace never touches the team directory's playbook", async () => {
    const root = await tmp()
    const file = Store.paths(root, RulesStore.WORKSPACE_RULES_STORE).approved
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
  })
  afterAll(() => {
    if (env.ALTIMATE_DISABLE_WORKSPACE !== undefined) process.env.ALTIMATE_DISABLE_WORKSPACE = env.ALTIMATE_DISABLE_WORKSPACE
    if (env.ALTIMATE_LEARN !== undefined) process.env.ALTIMATE_LEARN = env.ALTIMATE_LEARN
    RuleProposal.setRendererForTest(undefined)
  })
  // A linked project with a client showing its cards (a renderer lease for its directory).
  const linkedRoot = async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    RuleProposal.setRendererForTest(root)
    return root
  }

  test("with no client showing this project's cards, or in a subagent's session, both save tools save as before cards", async () => {
    const root = await linkedRoot()
    const said = "Remember as a rule: always use CTEs in staging models."
    const content = "Always use CTEs in staging models."
    // A client showing another project's cards says nothing about this one.
    RuleProposal.setRendererForTest(await tmp())
    expect(await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content, sessionID: "r0", said, via: "memory" })).toBeUndefined()
    expect(await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content, sessionID: "r0", said })).toBeUndefined()
    RuleProposal.setRendererForTest(root)
    expect(await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content, sessionID: "r0", said, subagent: true })).toBeUndefined()
    expect(RuleProposal.list(root)).toEqual([])
  })

  test("a card the person asked for that closes unanswered is saved as before cards; an answered one is not", async () => {
    const root = await linkedRoot()
    const saved: string[] = []
    const unanswered = async (text: string) => void saved.push(text)
    const said = "Remember as a rule: always use CTEs in staging models."
    await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "Always use CTEs in staging models.", sessionID: "u1", said, unanswered })
    RuleProposal.drop(root)
    await Bun.sleep(0)
    expect(saved).toEqual(["Always use CTEs in staging models."])
    await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "Never select star in marts.", sessionID: "u2", said: "Remember as a rule: never select star in marts.", unanswered })
    const card = RuleProposal.list(root, "u2")[0]
    expect(await RuleProposal.reply(card.id, { action: "dismiss" })).toMatchObject({ ok: true })
    RuleProposal.drop(root)
    await Bun.sleep(0)
    expect(saved).toEqual(["Always use CTEs in staging models."])
  })

  test("asked again in the same session, a card takes the latest request's memory block and fallback", async () => {
    const root = await linkedRoot()
    const calls: string[] = []
    const text = "Staging models live in models/staging."
    await RuleProposal.ask({ sessionID: "m9", root, directory: root, learn: undefined, draft: { text, applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [], choose: true } })
    await RuleProposal.ask({ sessionID: "m9", root, directory: root, learn: undefined, unanswered: async () => void calls.push("second"), draft: { text, applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [], choose: true, memory: { id: "conventions/staging", tags: ["dbt"] } } })
    RuleProposal.drop(root)
    await Bun.sleep(0)
    expect(calls).toEqual(["second"])
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

  test("a Save as card says where Memory saves it, and saves it there", async () => {
    const root = await linkedRoot()
    const writes: { id: string; scope: string }[] = []
    const spy = spyOn(MemoryStore, "write").mockImplementation((async (block: { id: string; scope: string }) => void writes.push({ id: block.id, scope: block.scope })) as never)
    const choose = (text: string, memory?: { id: string; tags: string[] }) =>
      ({ text, applies_to: [], change: "add" as const, origin: "explicit" as const, evidence: { sessions: 1 }, topics: [], choose: true, ...(memory ? { memory } : {}) })
    try {
      const preference = (await RuleProposal.ask({ sessionID: "ms1", root, directory: root, learn: undefined, draft: choose("I like explicit column lists in staging models.") }))!
      expect(preference.memory_scope).toBe("global")
      // From the memory tool, its block goes to project memory whatever the wording reads as, and the card says so.
      const fromTool = (await RuleProposal.ask({ sessionID: "ms2", root, directory: root, learn: undefined, draft: choose("I like explicit column lists in marts.", { id: "conventions/marts", tags: [] }) }))!
      expect(fromTool.memory_scope).toBe("project")
      expect(await RuleProposal.reply(fromTool.id, { action: "save_memory" })).toMatchObject({ ok: true, message: "Saved to this project's memory." })
      expect(writes).toEqual([{ id: "conventions/marts", scope: "project" }])
      // Asked again from the memory tool, a preference's card now saves to project memory, and says so.
      const again = (await RuleProposal.ask({ sessionID: "ms1", root, directory: root, learn: undefined, draft: choose("I like explicit column lists in staging models.", { id: "conventions/staging", tags: [] }) }))!
      expect(again).toMatchObject({ id: preference.id, memory_scope: "project" })
    } finally {
      spy.mockRestore()
      await RuleProposal.drop(root)
    }
  })

  // Holds a stubbed call open until released, and says when it was entered.
  const hold = () => {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => (enter = resolve))
    const released = new Promise<void>((resolve) => (release = resolve))
    return { entered, released, enter, release }
  }
  const asked = (text: string) => ({ text, applies_to: [], change: "add" as const, origin: "explicit" as const, evidence: { sessions: 1 }, topics: [] })

  test("a card closed while its reply runs is not also saved by the fallback when the reply succeeds", async () => {
    const root = await linkedRoot()
    const saved: string[] = []
    const gate = hold()
    const run = spyOn(RulesSync, "runFresh").mockImplementation((async () => {
      gate.enter()
      await gate.released
      return undefined
    }) as never)
    try {
      const card = (await RuleProposal.ask({ sessionID: "b1", root, directory: root, learn: undefined, draft: asked("Prefix seeds with seed_."), unanswered: async (text) => void saved.push(text) }))!
      const replying = RuleProposal.reply(card.id, { action: "send" })
      await gate.entered
      const dropping = RuleProposal.drop(root)
      gate.release()
      await dropping
      expect(await replying).toMatchObject({ ok: true })
      expect(saved).toEqual([])
      expect((await RulesStore.read(root)).outbox.map((e) => e.item.text)).toEqual(["Prefix seeds with seed_."])
    } finally {
      run.mockRestore()
    }
  })

  test("a card closed while its reply runs is saved by the fallback when the reply fails", async () => {
    const root = await linkedRoot()
    const saved: string[] = []
    const gate = hold()
    const enqueue = spyOn(RulesSync, "enqueue").mockImplementation((async () => {
      gate.enter()
      await gate.released
      throw new Error("disk full")
    }) as never)
    try {
      const card = (await RuleProposal.ask({ sessionID: "b2", root, directory: root, learn: undefined, draft: asked("Quote reserved words."), unanswered: async (text) => void saved.push(text) }))!
      const replying = RuleProposal.reply(card.id, { action: "send" })
      await gate.entered
      // Dropping waits for the running reply: its fallback has to land before the instance goes.
      let dropped = false
      const dropping = RuleProposal.drop(root).then(() => void (dropped = true))
      await Bun.sleep(20)
      expect(dropped).toBe(false)
      gate.release()
      await dropping
      expect(saved).toEqual(["Quote reserved words."])
      expect(await replying).toMatchObject({ ok: false, code: "not_open" })
    } finally {
      enqueue.mockRestore()
    }
  })

  test("dropping a project's cards waits until the requested ones are saved", async () => {
    const root = await linkedRoot()
    let saved = false
    await RuleProposal.ask({ sessionID: "b3", root, directory: root, learn: undefined, draft: asked("Name seeds seed_<entity>."), unanswered: async () => {
      await Bun.sleep(30)
      saved = true
    } })
    await RuleProposal.drop(root)
    expect(saved).toBe(true)
  })

  test("training_save's card, closed unanswered, saves the entry the agent meant to write into the asking project", async () => {
    await using dir = await tmpdir({ git: true })
    const said = "Remember as a rule: always use CTEs in staging models."
    const content = "Always use CTEs in staging models."
    let directory: string | undefined
    try {
      directory = await Instance.provide({ directory: dir.path, fn: async () => {
        const root = await fs.realpath(Instance.worktree)
        await RulesStore.update(root, (s) => Object.assign(s, linked()))
        RuleProposal.setRendererForTest(Instance.directory)
        const session = await Session.create({})
        const result = await RulesRemember.proposeTeamRule(content, session.id, said, "training", undefined, { name: "staging-ctes", source: "the agent", citations: [] })
        expect(result?.title).toContain("Team rule proposed")
        expect(await TrainingStore.get("project", "rule", "staging-ctes")).toBeUndefined()
        return Instance.directory
      } })
      // Closed from outside the instance (as on dispose): the fallback still writes into the project that asked.
      await RuleProposal.drop(directory)
      await Instance.provide({ directory: dir.path, fn: async () => {
        const entry = await TrainingStore.get("project", "rule", "staging-ctes")
        expect(entry?.content).toContain(content)
        expect(entry?.meta.source).toBe("the agent")
      } })
    } finally {
      if (directory) await RuleProposal.drop(directory)
      RuleProposal.setRendererForTest(undefined)
      await disposeAllInstances()
    }
  })

  test("the fallback keeps training_save's per-kind limit: a new rule past it is not saved", async () => {
    await using dir = await tmpdir({ git: true })
    const count = spyOn(TrainingStore, "count").mockResolvedValue({ rule: 50 } as never)
    let directory: string | undefined
    try {
      directory = await Instance.provide({ directory: dir.path, fn: async () => {
        const root = await fs.realpath(Instance.worktree)
        await RulesStore.update(root, (s) => Object.assign(s, linked()))
        RuleProposal.setRendererForTest(Instance.directory)
        const session = await Session.create({})
        await RulesRemember.proposeTeamRule("Never select star in marts.", session.id, "Remember as a rule: never select star in marts.", "training", undefined, { name: "no-star" })
        return Instance.directory
      } })
      await RuleProposal.drop(directory)
      await Instance.provide({ directory: dir.path, fn: async () => {
        expect(await TrainingStore.get("project", "rule", "no-star")).toBeUndefined()
      } })
    } finally {
      count.mockRestore()
      if (directory) await RuleProposal.drop(directory)
      RuleProposal.setRendererForTest(undefined)
      await disposeAllInstances()
    }
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

describe("whose outbox it is", () => {
  const binding = { status: "bound" as const, binding: { datamateId: 1, repoRemote: "https://github.com/acme/demo" } }
  test("a rotated key or a fresh sign-in keeps the outbox; another user on the tenant gets a notice", async () => {
    const root = await tmp()
    const env = process.env.ALTIMATE_DISABLE_WORKSPACE
    delete process.env.ALTIMATE_DISABLE_WORKSPACE
    const spies: { mockRestore(): void }[] = [
      spyOn(WorkspaceState, "resolveBindingOutcome").mockResolvedValue(binding as never),
    ]
    const as = (apiKey: string, user: number) => {
      spies.push(spyOn(WorkspaceApi, "captureCredentials").mockResolvedValue({ url: "http://x/", instance: "t", apiKey }))
      spies.push(spyOn(WorkspaceState, "accountDigest").mockResolvedValue(WorkspaceState.credentialDigest("http://x/", "t", apiKey)))
      spies.push(spyOn(WorkspaceApi, "whoami").mockResolvedValue(user))
    }
    try {
      as("key-1", 7)
      const first = await RulesSync.context(root, { enabled: true })
      expect(first).toMatchObject({ status: "ready", scope: { apiUrl: "http://x", account: "user:7" } })
      await RulesStore.update(root, (s) => { s.scope = (first as { scope: RulesStore.Scope }).scope })
      await RulesSync.enqueue(root, { change: "add", text: "Queued offline.", applies_to: [], origin: "session", evidence_sessions: 1, corrections: [] })
      as("key-2", 7)
      const rotated = await RulesSync.context(root, { enabled: true })
      await RulesSync.adopt(root, rotated as never)
      expect((await RulesStore.read(root)).outbox).toHaveLength(1)
      as("key-3", 8)
      const other = await RulesSync.context(root, { enabled: true })
      await RulesSync.adopt(root, other as never)
      const state = await RulesStore.read(root)
      expect(state.outbox).toEqual([])
      expect(state.scope?.account).toBe("user:8")
      expect(RulesStore.scopeDropNote(state)).toContain("1 queued proposal was for another account or workspace")
    } finally {
      for (const spy of spies) spy.mockRestore()
      if (env === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
      else process.env.ALTIMATE_DISABLE_WORKSPACE = env
    }
  })
})

describe("learning precedence, stores and the after-turn check", () => {
  test("a learn key set by a layer above project files beats the project file; the rest follow it on disk", async () => {
    const root = await tmp()
    await fs.mkdir(path.join(root, ".altimate-code"), { recursive: true })
    await fs.writeFile(path.join(root, ".altimate-code", "altimate-code.json"), JSON.stringify({ learn: { enabled: true, capture: true } }))
    // As if managed config (or the account's) set `learn.enabled: false` and `learn.capture: false` above the project.
    Config.setLearnKeysAboveProjectForTest(root, ["enabled", "capture"])
    try {
      expect(await RulesService.effectiveLearn({ enabled: false, capture: false }, root, root)).toEqual({ enabled: false, capture: false, capture_policy: true })
    } finally {
      Config.setLearnKeysAboveProjectForTest(root, undefined)
    }
    expect(await RulesService.effectiveLearn({ enabled: false }, root, root)).toEqual({ enabled: true, capture: true })
  })

  test("an organization's capture setting beats the person's /rules choice", () => {
    const state = RulesStore.State.parse({ version: 1, personal_learning: true })
    expect(learningDecision({ capture: false, capture_policy: true }, state, {})).toEqual({ on: false, source: "organization" })
    expect(learningDecision({ capture: false }, state, {})).toEqual({ on: true, source: "you" })
  })

  test("team rules live in workspace-rules; a store named team is the person's own and sync never touches it", async () => {
    const root = await tmp()
    const team = path.join(root, ".altimate-code", "learn", "team")
    await fs.mkdir(team, { recursive: true })
    const own = JSON.stringify([{ id: "L-000000000001", text: "Our own rule.", tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" }])
    await fs.writeFile(path.join(team, "approved.json"), own)
    await RulesStore.update(root, (s) => Object.assign(s, linked(), { rules: [rule("Name staging models stg_<source>.")] }))
    expect(await fs.readFile(path.join(team, "approved.json"), "utf8")).toBe(own)
    expect(RulesStore.WORKSPACE_RULES_STORE).toBe("workspace-rules")
    expect(parse(await fs.readFile(Store.paths(root, RulesStore.WORKSPACE_RULES_STORE).approved, "utf8"))).toHaveLength(1)
  })

  test("with no client showing this project's cards, the after-turn check leaves corrections for later", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    await appendSignal(root, { kind: "user_correction", sessionID: "t9", text: "no, call it ordered_at", reason: "correction" })
    RuleProposal.setRendererForTest(await tmp())
    const events: Telemetry.Event[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event: Telemetry.Event) => void events.push(event))
    try {
      const deps = { source: async () => { throw new Error("not reached") }, generate: async () => { throw new Error("not reached") } } as unknown as RuleTrigger.TriggerDeps
      await RuleTrigger.afterTurn({ sessionID: "t9", root, directory: root, learn: { enabled: true, capture: true }, deps })
    } finally {
      spy.mockRestore()
      RuleProposal.setRendererForTest(undefined)
    }
    const state = await RulesStore.read(root)
    expect(state.processed_signals).toEqual([])
    expect(state.last_check?.outcome).toContain("no client that shows cards")
    expect(events).toEqual([expect.objectContaining({ type: "rule_proposal_skipped", reason: "no_renderer" })])
  })

  test("a card already open in the session skips the after-turn check without drafting, and its corrections stay unprocessed", async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    await appendSignal(root, { kind: "user_correction", sessionID: "t10", text: "no, call it shipped_at", reason: "correction" })
    RuleProposal.setRendererForTest(root)
    let drafted = 0
    const events: Telemetry.Event[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event: Telemetry.Event) => void events.push(event))
    try {
      await RuleProposal.ask({ sessionID: "t10", root, directory: root, learn: undefined, draft: { text: "Name timestamps <event>_at.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } })
      const deps = { source: async () => { drafted++; throw new Error("not reached") }, generate: async () => { drafted++; throw new Error("not reached") } } as unknown as RuleTrigger.TriggerDeps
      await RuleTrigger.afterTurn({ sessionID: "t10", root, directory: root, learn: { enabled: true, capture: true }, deps })
    } finally {
      spy.mockRestore()
      RuleProposal.drop(root)
      RuleProposal.setRendererForTest(undefined)
    }
    expect(drafted).toBe(0)
    expect(events.filter((e) => e.type === "rule_proposal_skipped")).toEqual([expect.objectContaining({ reason: "card_open" })])
    expect((await RulesStore.read(root)).processed_signals).toEqual([])
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


describe("cards across the feature's edges", () => {
  const env = { ...process.env }
  beforeAll(() => {
    delete process.env.ALTIMATE_DISABLE_WORKSPACE
    delete process.env.ALTIMATE_LEARN
  })
  afterAll(() => {
    if (env.ALTIMATE_DISABLE_WORKSPACE !== undefined) process.env.ALTIMATE_DISABLE_WORKSPACE = env.ALTIMATE_DISABLE_WORKSPACE
    if (env.ALTIMATE_LEARN !== undefined) process.env.ALTIMATE_LEARN = env.ALTIMATE_LEARN
    RuleProposal.setRendererForTest(undefined)
  })
  const linkedRoot = async () => {
    const root = await tmp()
    await RulesStore.update(root, (s) => Object.assign(s, linked()))
    RuleProposal.setRendererForTest(root)
    return root
  }
  const add = (text: string) => ({ deltas: [{ op: "ADD", text, reason: "corrected in two sessions" }] })
  const deps = (result: unknown, during?: () => void): RuleTrigger.TriggerDeps => ({
    source: async () => ({ prompts: ["fix the orders model"], calls: [] }),
    generate: async (_source, onUsage) => async () => {
      during?.()
      onUsage?.({ inputTokens: 120, outputTokens: 30, estimatedCost: 0.002 } as never)
      return result
    },
  })

  test("the same correction in two sessions proposes a workspace's first rule, and the drafting call's usage is reported", async () => {
    const root = await linkedRoot()
    await appendSignal(root, { kind: "user_correction", sessionID: "c1", text: "no, the column is ordered_at", reason: "correction" })
    await appendSignal(root, { kind: "user_correction", sessionID: "c2", text: "use ordered_at for the order time", reason: "correction" })
    const events: Telemetry.Event[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event: Telemetry.Event) => void events.push(event))
    try {
      await RuleTrigger.afterTurn({ sessionID: "c2", root, directory: root, learn: { enabled: true, capture: true }, deps: deps(add("Name order timestamps ordered_at.")) })
    } finally {
      spy.mockRestore()
    }
    expect(RuleProposal.list(root, "c2")).toEqual([expect.objectContaining({ text: "Name order timestamps ordered_at.", change: "add" })])
    expect(events).toContainEqual(expect.objectContaining({ type: "rule_drafted", trigger: "recurrence", status: "ok", input_tokens: 120, output_tokens: 30 }))
    await RuleProposal.drop(root)
  })

  test("a client that goes away while the card is drafted leaves the corrections for a later check", async () => {
    const root = await linkedRoot()
    await appendSignal(root, { kind: "user_correction", sessionID: "g1", text: "no, call it shipped_at", reason: "correction" })
    await appendSignal(root, { kind: "user_correction", sessionID: "g2", text: "shipped_at, not ship_date", reason: "correction" })
    const other = await tmp()
    await RuleTrigger.afterTurn({ sessionID: "g2", root, directory: root, learn: { enabled: true, capture: true }, deps: deps(add("Name ship timestamps shipped_at."), () => RuleProposal.setRendererForTest(other)) })
    expect(RuleProposal.list(root)).toEqual([])
    const state = await RulesStore.read(root)
    expect(state.processed_signals).toEqual([])
    expect(state.last_check?.outcome).toContain("went away")
  })

  test("an explicit remember carries a correction only when it is about the same thing", async () => {
    const root = await linkedRoot()
    await appendSignal(root, { kind: "user_correction", sessionID: "e1", text: "no, the column is ordered_at", reason: "correction" })
    const unrelated = await RuleTrigger.explicit({ sessionID: "e1", root, directory: root, learn: undefined, text: "Never use FLOAT for money columns.", said: "Remember as a rule: never use FLOAT for money columns." })
    expect(unrelated.status).toBe("shown")
    expect(unrelated.status === "shown" && unrelated.card?.evidence.correction).toBeFalsy()
    await appendSignal(root, { kind: "user_correction", sessionID: "e1", text: "money columns must not be FLOAT, use integer cents", reason: "correction" })
    await RuleProposal.drop(root)
    const related = await RuleTrigger.explicit({ sessionID: "e1", root, directory: root, learn: undefined, text: "Never use FLOAT for money columns.", said: "Remember as a rule: never use FLOAT for money columns." })
    expect(related.status === "shown" && related.card?.evidence.correction?.excerpt).toContain("integer cents")
    await RuleProposal.drop(root)
  })

  test("a card answered after the account or workspace changed is not sent there; a requested one is saved as before", async () => {
    const root = await linkedRoot()
    const saved: string[] = []
    const card = (await RuleProposal.ask({ sessionID: "s1", root, directory: root, learn: undefined, unanswered: async (text) => void saved.push(text), draft: { text: "Prefix seeds with seed_.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } }))!
    await RulesStore.update(root, (s) => { s.scope = { ...s.scope!, account: "someone-else" } })
    expect(await RuleProposal.reply(card.id, { action: "send" })).toMatchObject({ ok: false, code: "not_open" })
    expect((await RulesStore.read(root)).outbox).toEqual([])
    expect(saved).toEqual(["Prefix seeds with seed_."])
    expect(RuleProposal.list(root)).toEqual([])
  })

  test("a requested card is kept on disk while open, cleared once answered", async () => {
    const root = await linkedRoot()
    const card = (await RuleProposal.ask({ sessionID: "k1", root, directory: root, learn: undefined, unanswered: async () => {}, request: { session: "k1", via: "training" }, draft: { text: "Quote reserved words.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } }))!
    expect((await RulesStore.read(root)).remember_requests).toEqual([expect.objectContaining({ card: card.id, text: "Quote reserved words.", pid: process.pid })])
    await RuleProposal.reply(card.id, { action: "dismiss" })
    expect((await RulesStore.read(root)).remember_requests).toEqual([])
  })

  test("a requested card whose process died is saved as before by the next process, once; a PID reused by a restart does not hide it", async () => {
    await using dir = await tmpdir({ git: true })
    const dead = Bun.spawn(["true"])
    await dead.exited
    const now = new Date().toISOString()
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const root = await fs.realpath(Instance.worktree)
        await RulesStore.update(root, (s) => {
          s.remember_requests.push({ card: "c-dead", text: "Alias every joined table.", session: "x1", directory: Instance.directory, via: "training", training: { name: "alias-joins" }, pid: dead.pid, boot: "earlier", at: now })
          // A restarted server can get the crashed one's PID (PID 1 in a container): its boot id tells them apart.
          s.remember_requests.push({ card: "c-restart", text: "Quote reserved identifiers.", session: "x3", directory: Instance.directory, via: "training", training: { name: "quote-reserved" }, pid: process.pid, boot: "before-restart", at: now })
          // Another live process's (our parent), recently written: its own card settles it.
          s.remember_requests.push({ card: "c-live", text: "Still open elsewhere.", session: "x2", directory: Instance.directory, via: "training", pid: process.ppid, boot: "another-live-process", at: now })
        })
        await RulesRemember.recoverRequests(root, Instance.directory)
        await RulesRemember.recoverRequests(root, Instance.directory)
        expect((await TrainingStore.get("project", "rule", "alias-joins"))?.content).toContain("Alias every joined table.")
        expect((await TrainingStore.get("project", "rule", "quote-reserved"))?.content).toContain("Quote reserved identifiers.")
        // A live process's fresh request is that process's to save.
        expect((await RulesStore.read(root)).remember_requests.map((r) => r.card)).toEqual(["c-live"])
      } })
    } finally {
      await disposeAllInstances()
    }
  })

  test("a request whose save fails for a passing reason is kept for the next start; one that can never be saved is dropped", async () => {
    await using dir = await tmpdir({ git: true })
    const now = new Date().toISOString()
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const root = await fs.realpath(Instance.worktree)
        await RulesStore.update(root, (s) => {
          s.remember_requests.push({ card: "c-busy", text: "Alias every joined table.", session: "y1", directory: Instance.directory, via: "training", training: { name: "alias-busy" }, pid: process.pid, boot: "earlier", at: now })
        })
        const save = spyOn(TrainingStore, "save").mockRejectedValue(new Error("EBUSY: resource busy"))
        try {
          await RulesRemember.recoverRequests(root, Instance.directory)
        } finally {
          save.mockRestore()
        }
        // Kept, claimed by this boot: the next start (another boot) tries again.
        expect((await RulesStore.read(root)).remember_requests).toEqual([expect.objectContaining({ card: "c-busy", boot: RulesStore.PROCESS_BOOT })])
        await RulesStore.update(root, (s) => { s.remember_requests[0].boot = "next-start" })
        const count = spyOn(TrainingStore, "count").mockResolvedValue({ rule: 50 } as never)
        try {
          await RulesRemember.recoverRequests(root, Instance.directory)
        } finally {
          count.mockRestore()
        }
        // The per-kind limit can never be met as asked: dropped (logged).
        expect((await RulesStore.read(root)).remember_requests).toEqual([])
      } })
    } finally {
      await disposeAllInstances()
    }
  })

  test("a claim renews the request, and this process retries its own leftover request once its card is gone, never an open one", async () => {
    await using dir = await tmpdir({ git: true })
    const twoDaysAgo = new Date(Date.now() - 2 * RuleProposal.CARD_TTL_MS).toISOString()
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const root = await fs.realpath(Instance.worktree)
        await RulesStore.update(root, (s) => {
          // Another boot's, its PID alive (our parent), older than a card can live: orphaned, claimed by this process.
          s.remember_requests.push({ card: "c-stale", text: "Alias every joined table.", session: "q1", directory: Instance.directory, via: "training", training: { name: "alias-stale" }, pid: process.ppid, boot: "elsewhere", at: twoDaysAgo })
        })
        const save = spyOn(TrainingStore, "save").mockRejectedValueOnce(new Error("EBUSY: resource busy"))
        try {
          await RulesRemember.recoverRequests(root, Instance.directory)
        } finally {
          save.mockRestore()
        }
        // Claimed: owned by this boot with a fresh time, so no other live process takes it while this one runs.
        const [kept] = (await RulesStore.read(root)).remember_requests
        expect(kept).toMatchObject({ card: "c-stale", boot: RulesStore.PROCESS_BOOT, pid: process.pid })
        expect(Date.now() - Date.parse(kept.at)).toBeLessThan(60_000)
        // Its card is not open here: the next refresh in this same process retries it.
        await RulesRemember.recoverRequests(root, Instance.directory)
        expect((await TrainingStore.get("project", "rule", "alias-stale"))?.content).toContain("Alias every joined table.")
        expect((await RulesStore.read(root)).remember_requests).toEqual([])
        // A card this process still shows is never recovered from under it.
        RuleProposal.setRendererForTest(Instance.directory)
        await RulesStore.update(root, (s) => Object.assign(s, linked()))
        const card = (await RuleProposal.ask({ sessionID: "q2", root, directory: Instance.directory, learn: undefined, unanswered: async () => {}, request: { session: "q2", via: "training", training: { name: "still-open" } }, draft: { text: "Still open here.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } }))!
        await RulesRemember.recoverRequests(root, Instance.directory)
        expect(await TrainingStore.get("project", "rule", "still-open")).toBeUndefined()
        expect((await RulesStore.read(root)).remember_requests.map((r) => r.card)).toEqual([card.id])
        await RuleProposal.drop(Instance.directory)
      } })
    } finally {
      RuleProposal.setRendererForTest(undefined)
      await disposeAllInstances()
    }
  })

  test("a requested card is shown only once its request is on disk; otherwise there is no card", async () => {
    const root = await linkedRoot()
    const update = RulesStore.update
    const spy = spyOn(RulesStore, "update").mockImplementationOnce((async () => {
      throw new Error("Timed out waiting for lock: learn-state")
    }) as never)
    try {
      const card = await RuleProposal.ask({ sessionID: "p1", root, directory: root, learn: undefined, unanswered: async () => {}, request: { session: "p1", via: "training" }, draft: { text: "Quote reserved words.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } })
      expect(card).toBeUndefined()
      expect(RuleProposal.list(root, "p1")).toEqual([])
    } finally {
      spy.mockRestore()
    }
    void update
    // And through the save tools: no card, so the tool saves as before.
    const full = spyOn(RulesStore, "update").mockImplementationOnce((async () => {
      throw new Error("Timed out waiting for lock: learn-state")
    }) as never)
    try {
      expect(await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "Always use CTEs in staging models.", sessionID: "p2", said: "Remember as a rule: always use CTEs in staging models.", unanswered: async () => {}, request: { session: "p2", via: "training" } })).toBeUndefined()
    } finally {
      full.mockRestore()
    }
  })

  test("dismissing or sending a requested card ends its request in the same write as the decision", async () => {
    const root = await linkedRoot()
    const draft = (text: string) => ({ text, applies_to: [], change: "add" as const, origin: "explicit" as const, evidence: { sessions: 1 }, topics: [] })
    const dismissed = (await RuleProposal.ask({ sessionID: "w1", root, directory: root, learn: undefined, unanswered: async () => {}, request: { session: "w1", via: "training" }, draft: draft("Prefix seeds with seed_.") }))!
    const sent = (await RuleProposal.ask({ sessionID: "w2", root, directory: root, learn: undefined, unanswered: async () => {}, request: { session: "w2", via: "training" }, draft: draft("Quote reserved words.") }))!
    // Any write after the decision fails: the request must already be gone with the decision itself.
    let seenAtSync: unknown
    const run = spyOn(RulesSync, "runFresh").mockImplementation((async () => {
      const state = await RulesStore.read(root)
      seenAtSync = { requests: state.remember_requests.map((r) => r.card), outbox: state.outbox.map((e) => e.item.text) }
      return undefined
    }) as never)
    try {
      await RuleProposal.reply(sent.id, { action: "send" })
    } finally {
      run.mockRestore()
    }
    expect(seenAtSync).toEqual({ requests: [dismissed.id], outbox: ["Quote reserved words."] })
    const update = RulesStore.update
    let calls = 0
    const after = spyOn(RulesStore, "update").mockImplementation((async (...args: Parameters<typeof update>) => {
      if (calls++ > 0) throw new Error("disk gone")
      return update(...args)
    }) as never)
    try {
      await RuleProposal.reply(dismissed.id, { action: "dismiss" })
    } finally {
      after.mockRestore()
    }
    expect((await RulesStore.read(root)).remember_requests).toEqual([])
  })

  test("a card answered while its request cannot be removed is never saved again by recovery", async () => {
    // Not linked: the card offers "Save for this project", an answer that succeeds without a rules-state write.
    const root = await tmp()
    const card = (await RuleProposal.ask({ sessionID: "a1", root, directory: root, learn: undefined, unanswered: async () => {}, request: { session: "a1", via: "training", training: { name: "answered-once" } }, draft: { text: "Alias joined tables.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } }))!
    const saves: string[] = []
    const save = spyOn(TrainingStore, "save").mockImplementation((async (input: { name: string }) => void saves.push(input.name)) as never)
    const update = RulesStore.update
    const stuck = spyOn(RulesStore, "update").mockImplementation((async () => {
      throw new Error("Timed out waiting for lock: learn-state")
    }) as never)
    try {
      expect(await RuleProposal.reply(card.id, { action: "save_local" })).toMatchObject({ ok: true })
    } finally {
      stuck.mockRestore()
    }
    void update
    try {
      expect((await RulesStore.read(root)).remember_requests.map((r) => r.card)).toEqual([card.id])
      // The next refresh removes it instead of saving it a second time.
      await RulesRemember.recoverRequests(root, root)
      expect((await RulesStore.read(root)).remember_requests).toEqual([])
      expect(saves).toEqual([RuleProposal.slug("Alias joined tables.")])
    } finally {
      save.mockRestore()
    }
  })

  test("a send the workspace refuses keeps the card open and its request back on disk", async () => {
    const root = await linkedRoot()
    const card = (await RuleProposal.ask({ sessionID: "r1", root, directory: root, learn: undefined, unanswered: async () => {}, request: { session: "r1", via: "training" }, draft: { text: "Prefix seeds with seed_.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } }))!
    const run = spyOn(RulesSync, "runFresh").mockResolvedValue(undefined as never)
    const outcome = spyOn(RulesSync, "outcomeOf").mockReturnValue({ status: "sent", row: { id: "x", text: "", status: "invalid", error: "too vague" } } as never)
    try {
      expect(await RuleProposal.reply(card.id, { action: "send" })).toMatchObject({ ok: false, code: "refused" })
    } finally {
      run.mockRestore()
      outcome.mockRestore()
    }
    expect(RuleProposal.list(root, "r1").map((c) => c.id)).toEqual([card.id])
    expect((await RulesStore.read(root)).remember_requests.map((r) => r.card)).toEqual([card.id])
    await RuleProposal.drop(root)
  })

  test("a send that fails after its proposal was queued does not keep its request again: the queue has it", async () => {
    const root = await linkedRoot()
    const saved: string[] = []
    const card = (await RuleProposal.ask({ sessionID: "q9", root, directory: root, learn: undefined, unanswered: async (text) => void saved.push(text), request: { session: "q9", via: "training" }, draft: { text: "Name seeds seed_<entity>.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } }))!
    const run = spyOn(RulesSync, "runFresh").mockResolvedValue(undefined as never)
    const outcome = spyOn(RulesSync, "outcomeOf").mockImplementation(() => { throw new Error("state unreadable") })
    try {
      expect(await RuleProposal.reply(card.id, { action: "send" })).toMatchObject({ ok: false, code: "failed" })
    } finally {
      run.mockRestore()
      outcome.mockRestore()
    }
    const state = await RulesStore.read(root)
    expect(state.outbox.map((e) => e.item.text)).toEqual(["Name seeds seed_<entity>."])
    expect(state.remember_requests).toEqual([])
    await RuleProposal.drop(root)
    expect(saved).toEqual([])
  })

  test("a send whose queue write landed but whose call failed is treated as queued, not kept again", async () => {
    const root = await linkedRoot()
    const saved: string[] = []
    const card = (await RuleProposal.ask({ sessionID: "m9", root, directory: root, learn: undefined, unanswered: async (text) => void saved.push(text), request: { session: "m9", via: "training" }, draft: { text: "Name macros with a verb.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } }))!
    const update = RulesStore.update
    let failAfterWrite = true
    // The state (outbox and request) is saved, then the mirror write fails.
    const spy = spyOn(RulesStore, "update").mockImplementation((async (...args: Parameters<typeof update>) => {
      const result = await update(...args)
      if (failAfterWrite) {
        failAfterWrite = false
        throw new Error("EACCES: approved.json")
      }
      return result
    }) as never)
    try {
      expect(await RuleProposal.reply(card.id, { action: "send" })).toMatchObject({ ok: false, code: "failed" })
    } finally {
      spy.mockRestore()
    }
    const state = await RulesStore.read(root)
    expect(state.outbox.map((e) => e.item.text)).toEqual(["Name macros with a verb."])
    expect(state.remember_requests).toEqual([])
    // Queued: closing the card later saves no second, local copy.
    await RuleProposal.drop(root)
    expect(saved).toEqual([])
  })

  test("asked again by a remember whose request cannot be written, the card is not handed back", async () => {
    const root = await linkedRoot()
    const draft = { text: "Name timestamps <event>_at.", applies_to: [], change: "add" as const, origin: "session" as const, evidence: { sessions: 2 }, topics: [], choose: true }
    const shown = (await RuleProposal.ask({ sessionID: "g1", root, directory: root, learn: undefined, draft }))!
    const spy = spyOn(RulesStore, "update").mockImplementationOnce((async () => {
      throw new Error("Timed out waiting for lock: learn-state")
    }) as never)
    try {
      expect(await RuleProposal.ask({ sessionID: "g1", root, directory: root, learn: undefined, unanswered: async () => {}, request: { session: "g1", via: "memory", memory: { id: "conventions/time", tags: [] } }, draft: { ...draft, origin: "explicit", memory: { id: "conventions/time", tags: [] } } })).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    // Left exactly as it was: the memory block and its scope label are not taken over by a request that was not kept.
    expect(RuleProposal.list(root, "g1")).toEqual([shown])
    await RuleProposal.drop(root)
  })

  test("this process renews the record of a card it still shows, so no other process takes it as ownerless", async () => {
    const root = await linkedRoot()
    const card = (await RuleProposal.ask({ sessionID: "n1", root, directory: root, learn: undefined, unanswered: async () => {}, request: { session: "n1", via: "training" }, draft: { text: "Quote reserved words.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } }))!
    await RulesStore.update(root, (s) => { s.remember_requests[0].at = new Date(Date.now() - 2 * RuleProposal.CARD_TTL_MS).toISOString() })
    await RulesRemember.recoverRequests(root, root)
    const [record] = (await RulesStore.read(root)).remember_requests
    expect(record.card).toBe(card.id)
    expect(Date.now() - Date.parse(record.at)).toBeLessThan(60_000)
    await RuleProposal.drop(root)
  })

  test("a card whose fallback fails for a passing reason keeps its request; a refused save clears it", async () => {
    const root = await linkedRoot()
    const draft = (text: string) => ({ text, applies_to: [], change: "add" as const, origin: "explicit" as const, evidence: { sessions: 1 }, topics: [] })
    await RuleProposal.ask({ sessionID: "f1", root, directory: root, learn: undefined, request: { session: "f1", via: "training" }, unanswered: async () => { throw new Error("ENOSPC: no space left") }, draft: draft("Quote reserved words.") })
    await RuleProposal.ask({ sessionID: "f2", root, directory: root, learn: undefined, request: { session: "f2", via: "training" }, unanswered: async () => { throw new RuleProposal.SaveRefusedError("project training already holds 50 rules") }, draft: draft("Alias joined tables.") })
    await RuleProposal.drop(root)
    expect((await RulesStore.read(root)).remember_requests.map((r) => r.text)).toEqual(["Quote reserved words."])
  })

  test("with 50 requested cards open, a new request is saved without a card instead of evicting one", async () => {
    const root = await linkedRoot()
    await RulesStore.update(root, (s) => {
      for (let i = 0; i < RulesStore.MAX_REMEMBER_REQUESTS; i++)
        s.remember_requests.push({ card: `c-${i}`, text: `Rule ${i}.`, session: "z", directory: root, via: "training", pid: process.pid, boot: RulesStore.PROCESS_BOOT, at: new Date().toISOString() })
    })
    const result = await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "Always use CTEs in staging models.", sessionID: "z1", said: "Remember as a rule: always use CTEs in staging models.", unanswered: async () => {}, request: { session: "z1", via: "training" } })
    expect(result).toBeUndefined()
    expect(RuleProposal.list(root, "z1")).toEqual([])
    expect((await RulesStore.read(root)).remember_requests).toHaveLength(RulesStore.MAX_REMEMBER_REQUESTS)
  })

  test("a card answered after its day is closed, not answered; a requested one is saved as before", async () => {
    const root = await linkedRoot()
    const saved: string[] = []
    const card = (await RuleProposal.ask({ sessionID: "d1", root, directory: root, learn: undefined, unanswered: async (text) => void saved.push(text), draft: { text: "Prefix seeds with seed_.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } }))!
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + RuleProposal.CARD_TTL_MS + 1_000)
    try {
      expect(await RuleProposal.reply(card.id, { action: "send" })).toMatchObject({ ok: false, code: "not_open", error: "This proposal expired." })
    } finally {
      clock.mockRestore()
    }
    expect((await RulesStore.read(root)).outbox).toEqual([])
    expect(saved).toEqual(["Prefix seeds with seed_."])
  })

  test("a card sent while rules sync is unavailable says so, instead of promising it is sent when the workspace is reachable", async () => {
    const root = await linkedRoot()
    const card = (await RuleProposal.ask({ sessionID: "o1", root, directory: root, learn: { enabled: false }, draft: { text: "Prefix seeds with seed_.", applies_to: [], change: "add", origin: "explicit", evidence: { sessions: 1 }, topics: [] } }))!
    const result = await RuleProposal.reply(card.id, { action: "send" })
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.message).toContain("rules sync is not available")
  })

  test("training_save content that reads as a memory is saved to memory, not redirected to a tool the agent may not have", async () => {
    const root = await linkedRoot()
    const memories: { text: string }[] = []
    const result = await RulesRemember.proposeFor({ root, directory: root, learn: undefined, content: "I prefer CTEs over subqueries.", sessionID: "m5", said: "Remember: I prefer CTEs over subqueries.", saveMemory: async (text) => { memories.push({ text }); return "global" } })
    expect(result).toMatchObject({ title: "Saved to memory", metadata: { action: "memory", scope: "global" } })
    expect(memories).toEqual([{ text: "I prefer CTEs over subqueries." }])
  })

  test("the after-turn check proposes an edit of a team rule the session was shown, a retire, or nothing when the rule already says it", async () => {
    const root = await linkedRoot()
    const text = "Name order timestamp columns ordered_at in staging models."
    await RulesStore.update(root, (s) => { s.rules = [rule(text)] })
    const id = RulesStore.lessonId(rule(text).rule_key)
    const dir = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(dir, { recursive: true })
    const shown = (session: string) => fs.writeFile(path.join(dir, `${Store.sha256(session)}.json`), JSON.stringify({
      version: 1, session, firstMessage: "m", query: "q", touchedPaths: [], section: "", requests: [], requestParts: [], compactions: [], counted: [],
      shown: [{ name: RulesStore.WORKSPACE_RULES_STORE, lesson: { id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: "2026-10-27T00:00:00Z", updated: "2026-10-27T00:00:00Z" }, tier: "core", at: "2026-01-01T00:00:00Z", queryHash: "h" }],
    }))
    const check = async (session: string, delta: unknown) => {
      await shown(session)
      await appendSignal(root, { kind: "user_correction", sessionID: session, text: "no, the order timestamp columns in staging models are named order_ts", reason: "correction" })
      await RuleTrigger.afterTurn({ sessionID: session, root, directory: root, learn: { enabled: true, capture: true }, deps: deps({ deltas: [delta] }) })
      const cards = RuleProposal.list(root, session)
      await RuleProposal.drop(root)
      return cards
    }
    expect(await check("e-edit", { op: "EDIT", id, text: "Name order timestamp columns order_ts in staging models.", reason: "renamed" }))
      .toEqual([expect.objectContaining({ change: "edit", replaces: expect.objectContaining({ text }) })])
    expect(await check("e-retire", { op: "REMOVE", id, reason: "no longer true" })).toEqual([expect.objectContaining({ change: "retire" })])
    const events: Telemetry.Event[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event: Telemetry.Event) => void events.push(event))
    try {
      expect(await check("e-covered", { op: "HELPFUL", id, reason: "the rule says it" })).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "rule_proposal_skipped", trigger: "shown_rule", reason: "covered" }))
  })

  test("with project config disabled, the live re-read ignores the project file", async () => {
    const root = await tmp()
    await fs.mkdir(path.join(root, ".altimate-code"), { recursive: true })
    await fs.writeFile(path.join(root, ".altimate-code", "altimate-code.json"), JSON.stringify({ learn: { capture: true } }))
    const flag = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
    try {
      expect(await RulesService.effectiveLearn(undefined, root, root)).toBeUndefined()
    } finally {
      if (flag === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
      else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = flag
    }
  })

  test("a team-rules mirror left behind by a failed write is repaired by the next write", async () => {
    const root = await tmp()
    const file = Store.paths(root, RulesStore.WORKSPACE_RULES_STORE).approved
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify([{ ...RulesStore.toLesson(rule("Stale team rule.")) }]))
    await RulesStore.update(root, (s) => { s.personal_learning = false })
    expect(parse(await fs.readFile(file, "utf8"))).toEqual([])
  })
})
