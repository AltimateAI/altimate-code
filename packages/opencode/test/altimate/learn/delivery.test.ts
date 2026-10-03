// altimate_change - new file
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Delivery } from "../../../src/altimate/learn/delivery"
import { canonical, type Lesson } from "../../../src/altimate/learn/lesson"
import * as Store from "../../../src/altimate/learn/store"

let root: string
const NAME = "team-playbook"
const limits = { core_lessons: 1, retrieved_lessons: 1, budget_tokens: 500, session_max_lessons: 40 }
const lesson = (id: string, text: string, extra: Partial<Lesson> = {}): Lesson => ({
  id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0,
  created: "2026-09-30T00:00:00.000Z", updated: "2026-09-30T00:00:00.000Z", ...extra,
})
const fixtures = () => [
  lesson("L-0001", "Keep the project rules explicit.", { pinned: true }),
  lesson("L-0002", "Check the `billing` amounts before invoicing."),
  lesson("L-0003", "Use the `shipping` route for parcel tracking."),
  lesson("L-0004", "Validate the `customer_id` before writing profiles.", { trigger: { paths: ["profiles/**"] } }),
]
const envKeys = ["ALTIMATE_LEARN_REQUEST_LESSONS", "ALTIMATE_LEARN_FILE_HOOK", "ALTIMATE_LEARN_FILE_LESSONS"] as const
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
beforeEach(async () => {
  for (const key of envKeys) delete process.env[key]
  root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-delivery-"))
})
afterEach(async () => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await fs.rm(root, { recursive: true, force: true })
})
async function approve(lessons = fixtures(), name = NAME) {
  const p = Store.paths(root, name)
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.writeFile(p.approved, canonical(lessons))
}
async function log(name = NAME) {
  const raw = await fs.readFile(path.join(Store.paths(root, name).learnDir, "shown.jsonl"), "utf8")
  return raw.trim().split("\n").map((line) => JSON.parse(line))
}
async function applied(name = NAME) {
  return JSON.parse(await fs.readFile(Store.paths(root, name).approved, "utf8")).map((entry: Lesson) => entry.applied)
}
async function child(script: string) {
  const delivery = path.resolve(import.meta.dir, "../../../src/altimate/learn/delivery.ts")
  const proc = Bun.spawn([process.execPath, "--eval", `
    import { Delivery } from ${JSON.stringify(delivery)};
    const delivery = new Delivery(${JSON.stringify(root)}, ${JSON.stringify(limits)});
    ${script}
  `], { cwd: path.resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
  return JSON.parse(stdout)
}

test("unused project only gets existence checks, no reads or writes", async () => {
  const checks = spyOn(fs, "access")
  const spies = [spyOn(fs, "readFile"), spyOn(fs, "readdir"), spyOn(fs, "writeFile"), spyOn(fs, "appendFile"), spyOn(fs, "mkdir")]
  try {
    const delivery = new Delivery(root, limits)
    expect(await delivery.prepare("session", "first", "billing")).toEqual({ section: "", requestNote: "" })
    expect(await delivery.compact("session", "compact")).toBe("")
    expect(await delivery.file("session", "billing.ts")).toBe("")
    await delivery.flush("session")
    expect(delivery.active).toBe(false)
    expect(checks).toHaveBeenCalledTimes(4)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  } finally { checks.mockRestore(); for (const spy of spies) spy.mockRestore() }
  expect(await fs.readdir(root)).toEqual([])
})

test.each(["candidate", "empty"])("%s-only projects never acquire a write lock or write delivery state", async (kind) => {
  const p = Store.paths(root, NAME)
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.writeFile(kind === "candidate" ? p.candidate : p.approved, canonical(kind === "candidate" ? fixtures() : []))
  const mkdir = spyOn(fs, "mkdir"), writes = spyOn(fs, "writeFile"), reads = spyOn(fs, "readFile")
  try {
    expect(await new Delivery(root, limits).prepare("session", "first", "billing")).toEqual({ section: "", requestNote: "" })
    expect(mkdir).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    if (kind === "candidate") expect(reads).not.toHaveBeenCalled()
  } finally { mkdir.mockRestore(); writes.mockRestore(); reads.mockRestore() }
  expect(await fs.readdir(p.learnDir)).toEqual([kind === "candidate" ? "candidate.json" : "approved.json"])
})

test("selection freezes byte-identically across steps, edits, resume and a fresh process", async () => {
  await approve()
  const delivery = new Delivery(root, limits)
  const first = await delivery.prepare("session", "first", "Fix billing")
  expect(first).toEqual({ section: "## Team rules\nKeep the project rules explicit.\nCheck the `billing` amounts before invoicing.", requestNote: "" })
  expect(delivery.active).toBe(true)
  await approve(fixtures().map((entry) => ({ ...entry, text: "Replaced text.", helpful: 99 })))
  expect(await delivery.prepare("session", "first", "Changed query")).toEqual(first)
  expect(await new Delivery(root, limits).prepare("session", "first", "Changed query")).toEqual(first)
  expect(await child('console.log(JSON.stringify(await delivery.prepare("session", "first", "Changed query")))')).toEqual(first)
  expect(await log()).toHaveLength(2)
})

test("request retrieval persists per message without changing the section or selecting any id twice", async () => {
  await approve()
  const delivery = new Delivery(root, limits)
  const first = await delivery.prepare("session", "first", "billing")
  const second = await delivery.prepare("session", "second", "shipping")
  expect(second.section).toBe(first.section)
  expect(second.requestNote).toBe("Team rules for this request:\nUse the `shipping` route for parcel tracking.")
  expect(await delivery.prepare("session", "second", "shipping")).toEqual(second)
  expect(await child('console.log(JSON.stringify(await delivery.prepare("session", "second", "shipping")))')).toEqual(second)
  expect(await delivery.prepare("session", "third", "shipping")).toEqual({ section: first.section, requestNote: "" })
  expect((await log()).map((entry) => entry.id)).toEqual(["L-0001", "L-0002", "L-0003"])
})

test("request additions have a separate cap from session-start retrieval", async () => {
  await approve([1, 2, 3, 4].map((n) => lesson(`L-000${n}`, `Check invoice rule ${n}.`)))
  const delivery = new Delivery(root, { ...limits, core_lessons: 0, retrieved_lessons: 2, request_lessons: 1 })
  const first = await delivery.prepare("session", "first", "invoice")
  expect(first.section.split("\n")).toHaveLength(3)
  expect((await delivery.prepare("session", "second", "invoice")).requestNote).toBe("Team rules for this request:\nCheck invoice rule 3.")
  expect((await delivery.prepare("session", "third", "invoice")).requestNote).toBe("Team rules for this request:\nCheck invoice rule 4.")
  expect((await log()).map((entry) => entry.tier)).toEqual(["retrieved", "retrieved", "request", "request"])
})

test("request additions default to five even when session-start retrieval is disabled", async () => {
  await approve([1, 2, 3, 4, 5, 6].map((n) => lesson(`L-000${n}`, `Check invoice rule ${n}.`)))
  const delivery = new Delivery(root, { ...limits, core_lessons: 0, retrieved_lessons: 0 })
  expect((await delivery.prepare("session", "first", "invoice")).section).toBe("")
  expect((await delivery.prepare("session", "second", "invoice rule")).requestNote.split("\n")).toHaveLength(6)
  expect(await log()).toHaveLength(5)
})

test.each(["staging/new.sql", "@staging/new.sql", '"staging/new model.sql"', "staging\\new.sql"])("request ranking uses mentioned paths before the cap, including nonexistent %s", async (file) => {
  await approve([
    lesson("L-0001", "Keep cents integer cents.", { trigger: { paths: ["analysis/**"] } }),
    lesson("L-0002", "Check cents carefully before publishing a staging model with financial calculations.", { trigger: { paths: ["models/staging/**"] } }),
  ])
  const config = { ...limits, core_lessons: 0, retrieved_lessons: 0, request_lessons: 1 }
  const delivery = new Delivery(root, config, path.join(root, "models"))
  await delivery.prepare("session", "first", "Start work")
  const selected = await delivery.prepare("session", "second", `Keep cents in ${file}`)
  expect(selected.requestNote).toBe("Team rules for this request:\n[applies to: models/staging/**] Check cents carefully before publishing a staging model with financial calculations.")
  const fallback = await delivery.prepare("session", "third", `Keep cents in ${file}`)
  expect(fallback.requestNote).toBe("Team rules for this request:\n[applies to: analysis/**] Keep cents integer cents.")
  expect((await log()).map(({ id, tier }) => [id, tier])).toEqual([["L-0002", "request"], ["L-0001", "request"]])
})

test.each([{}, { file_hook: false }, { file_lessons: 0 }])("request ranking remembers touched files across resume even without file delivery (%j)", async (hook) => {
  await approve([lesson("L-0001", "Use clear names.")])
  const config = { ...limits, core_lessons: 0, retrieved_lessons: 0, request_lessons: 1, ...hook }
  const delivery = new Delivery(root, config)
  await delivery.prepare("session", "first", "Start work")
  expect(await delivery.file("session", path.join(root, "models/staging/x.sql"))).toBe("")
  await approve([
    lesson("L-0002", "Keep cents integer cents.", { trigger: { paths: ["analysis/**"] } }),
    lesson("L-0003", "Check cents carefully before publishing a staging model with financial calculations.", { trigger: { paths: ["models/staging/**"] } }),
  ])
  const selected = await new Delivery(root, config).prepare("session", "second", "Keep cents")
  expect(selected.requestNote).toContain("[applies to: models/staging/**]")
  expect((await log()).map(({ id, tier }) => [id, tier])).toEqual([["L-0003", "request"]])
})

test.each(["config", "env"])("zero request limit from %s disables additions while retaining session-start retrieval", async (source) => {
  await approve([1, 2, 3].map((n) => lesson(`L-000${n}`, `Check invoice rule ${n}.`)))
  if (source === "env") process.env.ALTIMATE_LEARN_REQUEST_LESSONS = "0"
  const delivery = new Delivery(root, { ...limits, core_lessons: 0, retrieved_lessons: 2, request_lessons: source === "config" ? 0 : 3 })
  const first = await delivery.prepare("session", "first", "invoice")
  expect(first.section.split("\n")).toHaveLength(3)
  expect(await delivery.prepare("session", "second", "invoice")).toEqual({ section: first.section, requestNote: "" })
  expect(await log()).toHaveLength(2)
})

test("first query augments only mentioned existing paths, relative to the current directory", async () => {
  await approve()
  await fs.mkdir(path.join(root, "src"))
  await fs.writeFile(path.join(root, "src", "billing.ts"), "")
  await new Delivery(root, { ...limits, core_lessons: 0 }, path.join(root, "src")).prepare("session", "first", "Fix billing.ts and missing.ts")
  expect((await log())[0].queryHash).toBe(Store.sha256("Fix billing.ts and missing.ts\nsrc/billing.ts"))
})

test("compaction rebuilds shown snapshots within budget and each marker applies only once", async () => {
  await approve()
  const delivery = new Delivery(root, limits)
  await delivery.prepare("session", "first", "billing")
  await delivery.prepare("session", "second", "shipping")
  await approve(fixtures().map((entry) => ({ ...entry, text: "Replaced text." })))
  const restored = new Delivery(root, limits)
  expect(await restored.hasSession("session")).toBe(true)
  expect(restored.active).toBe(true)
  const compacted = await restored.compact("session", "compact-one")
  for (const text of fixtures().slice(0, 3).map((entry) => entry.text)) expect(compacted).toContain(text)
  expect(compacted).not.toContain("Replaced text")
  expect((await delivery.prepare("session", "first", "billing")).section).toBe(compacted)
  const smaller = new Delivery(root, { ...limits, budget_tokens: 12 })
  expect(await smaller.compact("session", "compact-one")).toBe(compacted)
  expect(Math.ceil((await smaller.compact("session", "compact-two")).length / 4)).toBeLessThanOrEqual(12)
  expect(await log()).toHaveLength(3)
})

test("file hooks select by glob or identifier anchor, once per lesson, under the session cap", async () => {
  await approve([
    lesson("L-0001", "Review profile changes.", { trigger: { paths: ["profiles/**/*.ts"] } }),
    lesson("L-0002", "Keep `customer_id` explicit."),
    lesson("L-0003", "Convert `_cents` amounts consistently."),
  ])
  const delivery = new Delivery(root, { ...limits, core_lessons: 0, retrieved_lessons: 0, session_max_lessons: 2 })
  await delivery.prepare("session", "first", "Fix the build")
  expect(await delivery.file("session", path.join(root, "profiles", "index.ts"))).toBe("Team rules for profiles/index.ts:\n[applies to: profiles/**/*.ts] Review profile changes.")
  expect(await delivery.file("session", "profiles/index.ts")).toBe("")
  expect(await delivery.file("session", "models/customer_id.sql")).toBe("Team rules for models/customer_id.sql:\nKeep `customer_id` explicit.")
  expect(await delivery.file("session", "models/amount_cents.sql")).toBe("")
  expect((await log()).map((entry) => entry.tier)).toEqual(["file", "file"])
})

test.each(["config switch", "env switch", "config zero", "env zero"])("file hook %s disables both glob and identifier delivery", async (source) => {
  await approve([
    lesson("L-0001", "Review profile changes.", { trigger: { paths: ["profiles/**/*.ts"] } }),
    lesson("L-0002", "Keep `customer_id` explicit."),
  ])
  if (source === "env switch") process.env.ALTIMATE_LEARN_FILE_HOOK = "0"
  if (source === "env zero") process.env.ALTIMATE_LEARN_FILE_LESSONS = "0"
  const delivery = new Delivery(root, {
    ...limits, core_lessons: 0, retrieved_lessons: 0,
    file_hook: source !== "config switch", file_lessons: source === "config zero" ? 0 : 2,
  })
  await delivery.prepare("session", "first", "Fix the build")
  expect(await delivery.file("session", "profiles/index.ts")).toBe("")
  expect(await delivery.file("session", "models/customer_id.sql")).toBe("")
  expect(await fs.stat(path.join(Store.paths(root, NAME).learnDir, "shown.jsonl")).catch(() => undefined)).toBeUndefined()
  expect((await delivery.prepare("session", "second", "profile customer_id")).requestNote).toContain("customer_id")
  expect((await log()).map((entry) => entry.tier)).toEqual(["request", "request"])
})

test("file hook environment can enable a configured-off hook and cap each event", async () => {
  await approve([
    lesson("L-0001", "Review profile changes.", { trigger: { paths: ["profiles/**/*.ts"] } }),
    lesson("L-0002", "Keep `customer_id` explicit."),
  ])
  process.env.ALTIMATE_LEARN_FILE_HOOK = "1"
  process.env.ALTIMATE_LEARN_FILE_LESSONS = "1"
  const delivery = new Delivery(root, { ...limits, core_lessons: 0, retrieved_lessons: 0, file_hook: false, file_lessons: 0 })
  await delivery.prepare("session", "first", "Fix the build")
  expect(await delivery.file("session", "profiles/customer_id.ts")).toBe("Team rules for profiles/customer_id.ts:\n[applies to: profiles/**/*.ts] Review profile changes.")
  expect(await delivery.file("session", "profiles/customer_id.ts")).toBe("Team rules for profiles/customer_id.ts:\nKeep `customer_id` explicit.")
  expect(await delivery.file("session", "profiles/customer_id.ts")).toBe("")
  expect(await log()).toHaveLength(2)
})

test.each([undefined, 2])("file events add at most the default or configured cap (%s), excluding prior lessons before limiting", async (file_lessons) => {
  await approve([1, 2, 3, 4, 5, 6].map((n) => lesson(`L-000${n}`, `Review profile rule ${n}.`, { trigger: { paths: ["profiles/**"] } })))
  const delivery = new Delivery(root, { ...limits, core_lessons: 0, retrieved_lessons: 0, file_lessons })
  await delivery.prepare("session", "first", "Fix the build")
  expect((await delivery.file("session", "profiles/index.ts")).split("\n")).toHaveLength((file_lessons ?? 5) + 1)
  expect(await log()).toHaveLength(file_lessons ?? 5)
  expect((await delivery.file("session", "profiles/index.ts")).split("\n")).toHaveLength(file_lessons === undefined ? 2 : 3)
  expect(await log()).toHaveLength(file_lessons === undefined ? 6 : 4)
})

test("file hooks match affixes and share exclusions with request retrieval", async () => {
  await approve([lesson("L-0001", "Convert `_cents` amounts consistently.")])
  const delivery = new Delivery(root, { ...limits, core_lessons: 0 })
  await delivery.prepare("session", "first", "Fix the build")
  expect(await delivery.file("session", "models/amount_cents.sql")).toContain("Convert `_cents`")
  expect(await new Delivery(root, limits).file("session", "models/refund_cents.sql")).toBe("")
  expect((await delivery.prepare("session", "second", "amount_cents")).requestNote).toBe("")
  expect(await log()).toHaveLength(1)
})

test("file ranking applies the cap after specificity across a thousand lessons", async () => {
  const broad = Array.from({ length: 998 }, (_, i) => lesson(`L-${(i + 1).toString(16).padStart(4, "0")}`, "Review model changes.", {
    trigger: { paths: ["models/**"] }, helpful: 100,
  }))
  await approve([
    ...broad,
    lesson("L-03e7", "Check `x` configuration.", { trigger: { paths: ["**/*.yml"] }, helpful: 200 }),
    lesson("L-03e8", "Normalize timestamps.", { trigger: { paths: ["models/staging/**"] } }),
  ])
  const delivery = new Delivery(root, { ...limits, core_lessons: 0, retrieved_lessons: 0 })
  await delivery.prepare("session", "first", "Review model changes")
  const note = await delivery.file("session", "models/staging/x.sql")
  expect(note.split("\n")).toHaveLength(6)
  expect(note.split("\n")[1]).toBe("[applies to: models/staging/**] Normalize timestamps.")
  expect((await log()).map(({ id, tier }) => [id, tier])).toEqual([
    ["L-03e8", "file"], ["L-0001", "file"], ["L-0002", "file"], ["L-0003", "file"], ["L-0004", "file"],
  ])
})

test("file ranking uses the current request after a fresh process resumes", async () => {
  await approve([
    lesson("L-0001", "Review cents.", { trigger: { paths: ["models/**"] }, helpful: 100 }),
    lesson("L-0002", "Normalize timestamps.", { trigger: { paths: ["models/**"] } }),
  ])
  const delivery = new Delivery(root, { ...limits, core_lessons: 0, retrieved_lessons: 0, request_lessons: 0 })
  await delivery.prepare("session", "first", "Review cents")
  await delivery.prepare("session", "second", "Normalize timestamps")
  const note = await child('console.log(JSON.stringify(await delivery.file("session", "models/x.sql")))')
  expect(note.split("\n")[1]).toBe("[applies to: models/**] Normalize timestamps.")
  expect((await log()).map(({ id }) => id)).toEqual(["L-0002", "L-0001"])
})

test("scoped cached sections stay byte-identical after scope edits, resume and compaction", async () => {
  const rule = lesson("L-0001", "Keep cents explicit.", { trigger: { paths: ["models/staging/**", "src/**", "b/**", "a/**"] } })
  await approve([rule])
  const delivery = new Delivery(root, limits)
  const first = await delivery.prepare("session", "first", "cents")
  expect(first.section).toBe("## Team rules\n[applies to: a/**, b/**, src/**] Keep cents explicit.")
  await approve([{ ...rule, trigger: { paths: ["changed/**"] } }])
  expect(await child('console.log(JSON.stringify(await delivery.prepare("session", "first", "cents")))')).toEqual(first)
  expect(await new Delivery(root, limits).compact("session", "compact")).toBe(first.section)
  expect((await log())[0].tier).toBe("core")
})

test("existing session state restores the current query when replaying a cached request", async () => {
  await approve([
    lesson("L-0001", "Review model changes.", { trigger: { paths: ["models/**"] }, helpful: 100 }),
    lesson("L-0002", "Normalize timestamps.", { trigger: { paths: ["models/**"] } }),
  ])
  const config = { ...limits, core_lessons: 0, retrieved_lessons: 0 }
  const first = await new Delivery(root, config).prepare("session", "first", "Normalize timestamps")
  const file = path.join(root, ".altimate-code/learn/.sessions", Store.sha256("session") + ".json")
  const state = JSON.parse(await fs.readFile(file, "utf8"))
  delete state.query
  delete state.touchedPaths
  await fs.writeFile(file, canonical(state))
  const resumed = new Delivery(root, config)
  expect(await resumed.prepare("session", "first", "Normalize timestamps")).toEqual(first)
  expect((await resumed.file("session", "models/x.sql")).split("\n")[1]).toBe("[applies to: models/**] Normalize timestamps.")
})

test("selection logs contain exactly shown IDs, tiers, time, and hashed queries", async () => {
  await approve()
  const delivery = new Delivery(root, limits)
  await delivery.prepare("session", "first", "billing")
  await delivery.prepare("session", "second", "shipping")
  await delivery.file("session", "profiles/user.ts")
  const records = await log()
  expect(records.map(({ at, ...record }) => record)).toEqual([
    { session: "session", id: "L-0001", tier: "core", queryHash: Store.sha256("billing") },
    { session: "session", id: "L-0002", tier: "retrieved", queryHash: Store.sha256("billing") },
    { session: "session", id: "L-0003", tier: "request", queryHash: Store.sha256("shipping") },
    { session: "session", id: "L-0004", tier: "file", queryHash: Store.sha256("profiles/user.ts") },
  ])
  for (const entry of records) expect(new Date(entry.at).toISOString()).toBe(entry.at)
})

test("custom named stores share a global cap and retain separate selection logs", async () => {
  await approve([lesson("L-0001", "Use `billing` reconciliation.")], "billing-rules")
  await approve([lesson("L-0002", "Use `shipping` parcel tracking.")], "shipping-rules")
  const delivery = new Delivery(root, { ...limits, core_lessons: 0, session_max_lessons: 2 })
  await delivery.prepare("session", "first", "billing")
  await delivery.prepare("session", "second", "shipping")
  expect((await log("billing-rules"))[0].tier).toBe("retrieved")
  expect((await log("shipping-rules"))[0].tier).toBe("request")
  await delivery.flush("session")
  expect(await applied("billing-rules")).toEqual([1])
  expect(await applied("shipping-rules")).toEqual([1])
})

test("applied counters move only at flush and never count a lesson twice after resume", async () => {
  await approve()
  const delivery = new Delivery(root, limits)
  const first = await delivery.prepare("session", "first", "billing")
  await delivery.prepare("session", "second", "shipping")
  expect(await applied()).toEqual([0, 0, 0, 0])
  await delivery.flush("session")
  expect(await applied()).toEqual([1, 1, 1, 0])
  await delivery.flush("session")
  await child('await delivery.flush("session"); console.log(JSON.stringify(true))')
  expect(await applied()).toEqual([1, 1, 1, 0])
  expect((await delivery.prepare("session", "second", "shipping")).section).toBe(first.section)
  await delivery.file("session", "profiles/user.ts")
  await delivery.flush("session")
  expect(await applied()).toEqual([1, 1, 1, 1])
})

test("interrupted flush replays counter targets without double increments", async () => {
  await approve()
  const delivery = new Delivery(root, limits)
  await delivery.prepare("session", "first", "billing")
  const rename = fs.rename.bind(fs)
  const failure = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to).includes("/.sessions/")) throw new Error("Interrupted state commit")
    return rename(from, to)
  })
  try { await expect(delivery.flush("session")).rejects.toThrow("Interrupted state commit") }
  finally { failure.mockRestore() }
  expect(await applied()).toEqual([1, 1, 0, 0])
  await new Delivery(root, limits).flush("session")
  expect(await applied()).toEqual([1, 1, 0, 0])
  expect(await fs.stat(path.join(root, ".altimate-code/learn/.flush.json")).catch(() => undefined)).toBeUndefined()
})

test("concurrent requests serialize selection so a lesson is shown only once", async () => {
  await approve()
  const delivery = new Delivery(root, limits)
  await delivery.prepare("session", "first", "billing")
  const results = await Promise.all([
    delivery.prepare("session", "second", "shipping"),
    new Delivery(root, limits).prepare("session", "third", "shipping"),
    delivery.file("session", "src/shipping.ts"),
  ])
  expect(results.filter((result) => typeof result === "string" ? result : result.requestNote)).toHaveLength(1)
  expect((await log()).filter((entry) => entry.id === "L-0003")).toHaveLength(1)
})

test("colliding IDs in different named stores remain separate rules and attribution", async () => {
  await approve([lesson("L-0001", "Use `billing` reconciliation.")], "billing-rules")
  await approve([lesson("L-0001", "Use `shipping` parcel tracking.")], "shipping-rules")
  const delivery = new Delivery(root, { ...limits, core_lessons: 0 })
  expect((await delivery.prepare("session", "first", "billing")).section).toContain("billing")
  expect((await delivery.prepare("session", "second", "shipping")).requestNote).toContain("shipping")
  const section = await delivery.compact("session", "compact")
  expect(section).toContain("billing")
  expect(section).toContain("shipping")
  expect((await log("billing-rules"))[0]).toMatchObject({ id: "L-0001", tier: "retrieved" })
  expect((await log("shipping-rules"))[0]).toMatchObject({ id: "L-0001", tier: "request" })
  await delivery.flush("session")
  await new Delivery(root, limits).flush("session")
  expect(await applied("billing-rules")).toEqual([1])
  expect(await applied("shipping-rules")).toEqual([1])
})

test("first query resolves @mentions and quoted paths with spaces", async () => {
  await approve()
  await fs.mkdir(path.join(root, "src"))
  await fs.writeFile(path.join(root, "src", "billing.ts"), "")
  await fs.writeFile(path.join(root, "src", "shipping routes.ts"), "")
  const query = 'Fix @src/billing.ts and "src/shipping routes.ts"'
  await new Delivery(root, { ...limits, core_lessons: 0 }).prepare("session", "first", query)
  expect((await log())[0].queryHash).toBe(Store.sha256(query + "\nsrc/billing.ts\nsrc/shipping routes.ts"))
})

test("resuming a synthetic continuation restores the section without preparing another message", async () => {
  const missing = new Delivery(root, limits)
  const reads = spyOn(fs, "readFile")
  try {
    expect(await missing.section("session")).toBe("")
    expect(reads).not.toHaveBeenCalled()
    expect(missing.active).toBe(false)
  } finally { reads.mockRestore() }
  await approve()
  const first = await new Delivery(root, limits).prepare("session", "first", "billing")
  await approve(fixtures().map((entry) => ({ ...entry, text: "Replaced text." })))
  const resumed = new Delivery(root, limits)
  expect(await resumed.section("session")).toBe(first.section)
  expect(resumed.active).toBe(true)
  expect(await log()).toHaveLength(2)
})
