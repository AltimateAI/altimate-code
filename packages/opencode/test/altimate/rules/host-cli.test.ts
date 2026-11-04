// altimate_change - new file
//
// The plugin's entry points through the real CLI: `learn hook`, `learn signal add --detect`, `learn rules`,
// `learn proposals` and `learn proposals reply`.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RulesStore } from "../../../src/altimate/rules/store"
import { readSignals } from "../../../src/altimate/learn/signals"
import { readShownSnapshots } from "../../../src/altimate/learn/delivery"
import { tmpdir } from "../../fixture/fixture"
import { credentialDigest } from "../../../src/altimate/workspace/state"

const entry = path.resolve(import.meta.dir, "../../../src/index.ts")

const CREDENTIALS = { altimateUrl: "http://x", altimateInstanceName: "t", altimateApiKey: "k" }
/** The digest of the credential the test projects' rules were pulled with. */
const ME = credentialDigest(CREDENTIALS.altimateUrl, CREDENTIALS.altimateInstanceName, CREDENTIALS.altimateApiKey)

/** A home signed in as the account the rules were pulled for (no network), or, with `signed: false`, signed out. */
async function home(dir: string, signed = true): Promise<Record<string, string>> {
  const at = path.join(dir, signed ? "home-in" : "home-out")
  await fs.mkdir(path.join(at, ".altimate"), { recursive: true })
  if (signed) await fs.writeFile(path.join(at, ".altimate", "altimate.json"), JSON.stringify(CREDENTIALS))
  return { OPENCODE_TEST_HOME: at }
}

async function cli(cwd: string, args: string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env, ALTIMATE_DISABLE_TELEMETRY: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_COLOR: "1",
    OPENCODE_TEST_STATE_HOME: path.join(cwd, "state"), ...options.env,
  }
  // The test preload turns workspaces off; these tests need them on.
  if (!options.env?.ALTIMATE_DISABLE_WORKSPACE) delete env.ALTIMATE_DISABLE_WORKSPACE
  const proc = Bun.spawn(["bun", "run", "--conditions=browser", entry, ...args], {
    cwd, env, stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]), stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

async function linkedProject(dir: string, extra: Partial<RulesStore.State> = {}) {
  const root = await fs.realpath(dir)
  await RulesStore.update(root, (s) => Object.assign(s, RulesStore.State.parse({
    version: 1,
    scope: { apiUrl: "http://x", tenant: "t", account: "a", datamateId: 1, repoRemote: "https://github.com/acme/demo" },
    workspace: { name: "Team", owner_name: "Olive", is_owner: false },
    settings: { learning_enabled: true, include_quotes: true, share_across_repos: false },
    pulled_at: new Date().toISOString(),
    pulled_with: ME,
  }), extra))
  return root
}

const teamRule = {
  public_id: "11111111-1111-1111-1111-111111111111", rule_key: "R-0123456789ab", repo_identity: "https://github.com/acme/demo",
  text: "Name staging models stg_<source>__<entity>.", applies_to: [], tags: [], pinned: false, version: 1, updated_at: "2026-10-27T00:00:00Z",
}

describe("learn hook", () => {
  test("session start prints the team rules as host context and records them as shown to the host session", async () => {
    await using dir = await tmpdir({ git: true })
    const root = await linkedProject(dir.path, { rules: [teamRule] })
    const result = await cli(dir.path, ["learn", "hook", "session-start", "--host", "claude"], {
      stdin: JSON.stringify({ session_id: "abc", hook_event_name: "SessionStart" }), env: await home(dir.path),
    })
    expect(result.code).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart")
    expect(output.hookSpecificOutput.additionalContext).toContain("- Name staging models stg_<source>__<entity>.")
    expect((await readShownSnapshots(root)).snapshots.map((s) => s.session)).toEqual(["claude:abc"])
  }, 60_000)

  test("prints nothing and succeeds on bad input, signed out, or with learning off", async () => {
    await using dir = await tmpdir({ git: true })
    await linkedProject(dir.path, { rules: [teamRule] })
    const signedIn = await home(dir.path)
    const runs: { stdin: string; env: Record<string, string> }[] = [
      { stdin: "not json", env: signedIn },
      { stdin: "{}", env: signedIn },
      { stdin: JSON.stringify({ session_id: "abc" }), env: await home(dir.path, false) },
      { stdin: JSON.stringify({ session_id: "abc" }), env: { ...signedIn, ALTIMATE_LEARN: "0" } },
      { stdin: JSON.stringify({ session_id: "abc" }), env: { ...signedIn, ALTIMATE_DISABLE_WORKSPACE: "1" } },
    ]
    for (const run of runs) {
      const result = await cli(dir.path, ["learn", "hook", "session-start"], run)
      expect(result).toMatchObject({ code: 0, stdout: "" })
    }
  }, 120_000)

  test("prompt submit records a correction of the host session, nothing else, and nothing with learning off", async () => {
    await using dir = await tmpdir({ git: true })
    const root = await linkedProject(dir.path)
    const signedIn = await home(dir.path)
    const signedOut = await home(dir.path, false)
    const prompt = (text: string, env: Record<string, string> = {}, signed = true) =>
      cli(dir.path, ["learn", "hook", "user-prompt-submit", "--host", "codex"], { stdin: JSON.stringify({ session_id: "s1", prompt: text }), env: { ...(signed ? signedIn : signedOut), ...env } })
    expect(await prompt("add a staging model for customers")).toMatchObject({ code: 0, stdout: "" })
    expect(await prompt("no, that's wrong", {}, false)).toMatchObject({ code: 0, stdout: "" })
    expect(await prompt("no, we never use FLOAT for money", { ALTIMATE_LEARN: "0" })).toMatchObject({ code: 0, stdout: "" })
    expect(await prompt("no, we never use FLOAT for money")).toMatchObject({ code: 0, stdout: "" })
    expect((await readSignals(root)).map((s) => [s.sessionID, s.text])).toEqual([["codex:s1", "no, we never use FLOAT for money"]])
  }, 120_000)
})

describe("learn check", () => {
  test("takes only a host session, and with learning off ends without a model call", async () => {
    await using dir = await tmpdir({ git: true })
    await linkedProject(dir.path)
    const own = await cli(dir.path, ["learn", "check", "--session", "ses_123"])
    expect(own.code).not.toBe(0)
    expect(own.stderr).toContain("claude:<id> or codex:<id>")
    const off = await cli(dir.path, ["learn", "check", "--session", "claude:x", "--json"], { env: { ALTIMATE_LEARN: "0" } })
    expect(off.code).toBe(0)
    expect(JSON.parse(off.stdout).outcome).toContain("off")
    expect(await cli(dir.path, ["learn", "hook", "stop"], { stdin: JSON.stringify({ session_id: "x", transcript_path: "/nonexistent" }), env: { ALTIMATE_LEARN: "0" } }))
      .toMatchObject({ code: 0, stdout: "" })
  }, 120_000)
})

describe("learn signal add --detect", () => {
  test("records only a correction, only where learning is on", async () => {
    await using dir = await tmpdir({ git: true })
    const env = await home(dir.path)
    const add = (text: string) => cli(dir.path, ["learn", "signal", "add", "--kind", "user", "--detect", "--session", "claude:x", "--text", text], { env })
    expect((await add("no, that's wrong")).stdout).toContain("not linked")
    await linkedProject(dir.path)
    expect((await add("thanks, looks good")).stdout).toContain("Not a correction")
    expect((await add("no, that's wrong")).stdout).toContain("Recorded a correction")
    const ci = await cli(dir.path, ["learn", "signal", "add", "--kind", "ci", "--detect", "--text", "x"])
    expect(ci.code).not.toBe(0)
    expect(ci.stderr).toContain("--detect applies to --kind user")
  }, 120_000)
})

describe("learn proposals", () => {
  test("lists stored proposals and answers them; a wrong or missing answer fails", async () => {
    await using dir = await tmpdir({ git: true })
    const root = await linkedProject(dir.path, { rules: [teamRule] })
    const env = await home(dir.path)
    const card = {
      id: "card-1", sessionID: "claude:x", text: "Quote reserved words.", applies_to: [], change: "add", origin: "session",
      evidence: { sessions: 2 }, chars: 21, workspace: { name: "Team", owner_name: "Olive", is_owner: false },
      actions: ["send", "edit", "dismiss"], topics: ["reserved"],
    }
    await RulesStore.update(root, (s) => {
      s.proposals = [RulesStore.StoredProposal.parse({ card, directory: root, scope: s.scope, trigger: "recurrence", source_session: "claude:x", at: new Date().toISOString() })]
    })
    const listed = JSON.parse((await cli(dir.path, ["learn", "proposals", "--json"], { env })).stdout)
    expect(listed.proposals.map((c: { id: string }) => c.id)).toEqual(["card-1"])
    expect(listed.team_rules).toHaveLength(1)
    expect((await cli(dir.path, ["learn", "proposals"], { env })).stdout).toContain("card-1  add: Quote reserved words.")

    const none = await cli(dir.path, ["learn", "proposals", "reply", "card-1"], { env })
    expect(none.code).not.toBe(0)
    expect(none.stderr).toContain("Pass exactly one of")
    expect((await cli(dir.path, ["learn", "proposals", "reply", "card-1", "--send", "--dismiss"], { env })).code).not.toBe(0)
    const unavailable = await cli(dir.path, ["learn", "proposals", "reply", "card-1", "--approve", "--json"], { env })
    expect(unavailable.code).toBe(1)
    expect(JSON.parse(unavailable.stdout)).toMatchObject({ ok: false, code: "not_available" })

    const edited = await cli(dir.path, ["learn", "proposals", "reply", "card-1", "--edit", "Quote every reserved word."], { env })
    expect(edited).toMatchObject({ code: 0, stdout: "Wording updated.\n" })
    const dismissed = await cli(dir.path, ["learn", "proposals", "reply", "card-1", "--dismiss"], { env })
    expect(dismissed.code).toBe(0)
    expect(dismissed.stdout).toContain("won't be proposed again")
    const gone = await cli(dir.path, ["learn", "proposals", "reply", "card-1", "--dismiss"], { env })
    expect(gone).toMatchObject({ code: 1, stdout: "This proposal is no longer open.\n" })
    expect((await RulesStore.read(root)).proposals).toEqual([])
  }, 180_000)

  test("signed out, no team rules, review history or workspace proposals are listed", async () => {
    await using dir = await tmpdir({ git: true })
    const root = await linkedProject(dir.path, { rules: [teamRule] })
    await RulesStore.update(root, (s) => {
      s.proposals = [RulesStore.StoredProposal.parse({
        card: { id: "card-2", sessionID: "claude:x", text: "Quote reserved words.", applies_to: [], change: "add", origin: "session", evidence: { sessions: 2 }, chars: 21, actions: ["send", "edit", "dismiss"], topics: [] },
        directory: root, scope: s.scope, trigger: "recurrence", source_session: "claude:x", at: new Date().toISOString(),
      })]
    })
    const listed = JSON.parse((await cli(dir.path, ["learn", "proposals", "--json"], { env: await home(dir.path, false) })).stdout)
    expect(listed).toEqual({ workspace: null, proposals: [], team_rules: [], mine: [] })
    const reply = await cli(dir.path, ["learn", "proposals", "reply", "card-2", "--dismiss", "--json"], { env: await home(dir.path, false) })
    expect(JSON.parse(reply.stdout)).toMatchObject({ ok: false, code: "not_available" })
  }, 120_000)
})
