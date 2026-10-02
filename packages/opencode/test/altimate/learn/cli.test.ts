// altimate_change - new file
//
// `learn signal add`, `learn signals` and `learn reflect` without feedback, through the real CLI.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Store from "../../../src/altimate/learn/store"
import { tmpdir } from "../../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../../src/index.ts")

async function learn(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", "run", "--conditions=browser", entry, "learn", ...args], {
    cwd,
    env: { ...process.env, ALTIMATE_DISABLE_TELEMETRY: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

test.each([false, true])("learn promote explains auto-loading before review (yes=%s)", async (yes) => {
  await using dir = await tmpdir({ git: true })
  const name = Playbook.DEFAULT_NAME
  const candidate = Playbook.withBullets(Playbook.create({ name }), [
    { id: "L-0001", text: "Run unit tests before committing.", helpful: 0, harmful: 0 },
  ])
  await Store.saveCandidate(dir.path, name, candidate)

  const result = await learn(dir.path, "promote", ...(yes ? ["--yes"] : []))
  const notice = "Review the lessons below: they will be auto-loaded into every session for this project (and for your team if you publish)."
  const diff = "+- [L-0001] Run unit tests before committing."
  expect(result.stdout).toContain(notice)
  expect(result.stdout).toContain(diff)
  expect(result.stdout.indexOf(notice)).toBeLessThan(result.stdout.indexOf(diff))
  if (!yes) {
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("Refusing to promote without confirmation")
    expect(await Store.readPromoted(dir.path, name)).toBeUndefined()
    expect(await Store.readCandidate(dir.path, name)).toBe(Playbook.serialize(candidate))
    return
  }
  expect(result.code).toBe(0)
  expect(result.stdout.indexOf(diff)).toBeLessThan(result.stdout.indexOf(`Promoted "${name}"`))
  expect(await Store.readPromoted(dir.path, name)).toBe(Playbook.serialize(candidate))
  const history = (await fs.readFile(Store.paths(dir.path, name).history, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({ action: "promote" })
  expect(history[0].published).toBeUndefined()
}, 60_000)

test("learn show displays pending recovery count", async () => {
  await using dir = await tmpdir({ git: true })
  const state = path.join(dir.path, ".altimate-code", "learn", "team-playbook")
  await fs.mkdir(state, { recursive: true })
  await fs.writeFile(path.join(state, "pending-replacements.jsonl"), JSON.stringify({
    id: "L-0001",
    text: "Convert `_cents` columns in staging.",
    reasons: ["The staging convention changed."],
    feedback: "Use the approved currency macro.",
    kind: "review",
    attempts: 1,
  }) + "\n")
  const shown = await learn(dir.path, "show")
  expect(shown.code).toBe(0)
  expect(shown.stdout).toContain("Pending recoveries: 1")
}, 60_000)

describe("learn signal add / signals", () => {
  test("add records a review signal, signals lists it, --json and --all work, a repeat is deduped", async () => {
    await using dir = await tmpdir({ git: true })
    const added = await learn(dir.path, "signal", "add", "--kind", "review", "--text", "Reviewer: add a unique test on order_id")
    expect(added.code).toBe(0)
    expect(added.stdout).toContain("Recorded sig_")

    const stored = await Signals.readSignals(dir.path)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ kind: "review", sessionID: "external", status: "open" })
    expect(stored[0].text).toContain("unique test on order_id")

    const again = await learn(dir.path, "signal", "add", "--kind", "review", "--text", "Reviewer: add a unique test on order_id")
    expect(again.stdout).toContain("Already recorded")

    const list = await learn(dir.path, "signals")
    expect(list.stdout).toContain("review")
    expect(list.stdout).toContain("unique test on order_id")

    const json = JSON.parse((await learn(dir.path, "signals", "--json")).stdout)
    expect(json).toHaveLength(1)

    await Signals.consumeSignals(dir.path, [stored[0].id], "reflect@x")
    expect((await learn(dir.path, "signals")).stdout).toContain("No open learning signals")
    expect((await learn(dir.path, "signals", "--all")).stdout).toContain("consumed(reflect@x)")
  }, 60_000)

  test("add --file with --kind user and a session; secrets are redacted", async () => {
    await using dir = await tmpdir({ git: true })
    const file = path.join(dir.path, "ci.log")
    await fs.writeFile(file, "FAILED dbt test\nkey sk-abcdef1234567890XYZ\n")
    const r = await learn(dir.path, "signal", "add", "--kind", "user", "--file", file, "--session", "ses_abc")
    expect(r.code).toBe(0)
    const [s] = await Signals.readSignals(dir.path)
    expect(s).toMatchObject({ kind: "user_correction", sessionID: "ses_abc" })
    expect(s.text).toContain("FAILED dbt test")
    expect(s.text).not.toContain("sk-abcdef1234567890XYZ")
  }, 60_000)

  test("add needs exactly one of --text / --file and a valid kind", async () => {
    await using dir = await tmpdir({ git: true })
    expect((await learn(dir.path, "signal", "add", "--kind", "ci")).code).not.toBe(0)
    expect((await learn(dir.path, "signal", "add", "--kind", "ci", "--text", "a", "--file", "b")).code).not.toBe(0)
    expect((await learn(dir.path, "signal", "add", "--kind", "bogus", "--text", "a")).code).not.toBe(0)
    expect((await learn(dir.path, "signal", "add", "--kind", "ci", "--file", "/nonexistent/x.log")).code).not.toBe(0)
    expect(await Signals.readSignals(dir.path)).toEqual([])
  }, 60_000)

  test("reflect with no open signals says so and exits 0, for --session and --pending", async () => {
    await using dir = await tmpdir({ git: true })
    const one = await learn(dir.path, "reflect", "--session", "ses_none")
    expect(one.code).toBe(0)
    expect(one.stdout).toContain("nothing to learn")
    const all = await learn(dir.path, "reflect", "--pending")
    expect(all.code).toBe(0)
    expect(all.stdout).toContain("nothing to learn")
  }, 60_000)

  test("reflect --pending cannot be combined with --feedback", async () => {
    await using dir = await tmpdir({ git: true })
    const r = await learn(dir.path, "reflect", "--pending", "--feedback", "x.log")
    expect(r.code).not.toBe(0)
  }, 60_000)
})
