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
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-delivery-")) })
afterEach(() => fs.rm(root, { recursive: true, force: true }))
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
  expect(await delivery.file("session", path.join(root, "profiles", "index.ts"))).toBe("Team rules for profiles/index.ts:\nReview profile changes.")
  expect(await delivery.file("session", "profiles/index.ts")).toBe("")
  expect(await delivery.file("session", "models/customer_id.sql")).toBe("Team rules for models/customer_id.sql:\nKeep `customer_id` explicit.")
  expect(await delivery.file("session", "models/amount_cents.sql")).toBe("")
  expect((await log()).map((entry) => entry.tier)).toEqual(["file", "file"])
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
