// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { buildDigest, redactSecrets } from "../../../src/altimate/learn/digest"
import { buildPrompt, replace } from "../../../src/altimate/learn/reflect"
import { curate, lint, verificationWarning } from "../../../src/altimate/learn/curator"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Store from "../../../src/altimate/learn/store"
import * as Signals from "../../../src/altimate/learn/signals"
import { reflectSessionSignals } from "../../../src/altimate/learn/session-reflect"

const name = "team-playbook"
const bullet = (text: string) => ({ id: "L-0001", text, helpful: 0, harmful: 0 })
const candidate = (text: string) => Playbook.serialize(Playbook.withBullets(Playbook.create({ name }), [bullet(text)]))
const sensitive = [
  ["sqlcmd -S example -U sa -P hunter2", "hunter2"],
  ["mysql -phunter2", "hunter2"],
  ["mysql -p hunter2", "hunter2"],
  ["mongosh -u admin -p hunter2", "hunter2"],
  ["mongo -p hunter2", "hunter2"],
  ["sshpass -p hunter2 ssh host", "hunter2"],
  ["redis-cli -a hunter2", "hunter2"],
  ["sqlcmd -P=hunter2", "hunter2"],
  ["client --password hunter2", "hunter2"],
  ['client --password="two words"', "two words"],
  ["client --token=short-token", "short-token"],
  ["client --secret short-secret", "short-secret"],
  ["client --api-key short-key", "short-key"],
  ["password=hunter2", "hunter2"],
  ["pwd=hunter2", "hunter2"],
  ["PASSWORD = 'two words'", "two words"],
  ["Server=example;Uid=sa;Pwd={two;words}", "two;words"],
  ["postgres://alice:hunter2@example/db", "hunter2"],
  ["Contact alice@example.com", "alice@example.com"],
  ["SSN 123-45-6789", "123-45-6789"],
  ["SSN 123 45 6789", "123 45 6789"],
  ["SSN 123456789", "123456789"],
] as const

describe("learn sensitive content regression", () => {
  for (const [text, secret] of sensitive) {
    test(`redacts and rejects sensitive content: ${text}`, () => {
      const redacted = redactSecrets(text)
      expect(redacted).not.toContain(secret)
      expect(redactSecrets(redacted)).toBe(redacted)
      const digest = buildDigest({ prompts: [text], calls: [{ name: "bash", input: { command: text }, output: text }], finalText: text })
      expect(digest).not.toContain(secret)
      expect(lint(text)).toBeDefined()
      expect(Store.validateCandidate(name, candidate(text))).toBeDefined()
      expect(curate([], [{ op: "ADD", text, reason: "review" }]).next).toEqual([])
    })
  }

  test("redacts credential tool fields before JSON serialization", () => {
    const digest = buildDigest({ prompts: [], calls: [{ name: "database", input: {
      PASSWORD: "two words", token: "short-token", api_key: "short-key", pwd: "hunter2",
      options: { authorization: "Basic private-auth", command: 'client --password="quoted secret"' },
    } }] })
    for (const secret of ["two words", "short-token", "short-key", "hunter2", "private-auth", "quoted secret"]) expect(digest).not.toContain(secret)
    expect(digest).toContain("[REDACTED]")
  })

  test("redacts every reflector and replacement input including existing bullets and saved excerpts", async () => {
    const text = "sqlcmd -P hunter2; contact alice@example.com; SSN 123-45-6789; password=another-secret"
    const prompt = buildPrompt({ digest: text, feedback: text, kind: "review", bullets: [bullet(text)] }).prompt
    let replacement = ""
    await replace({ text, reasons: [text], feedback: text, feedbackExcerpt: text, kind: "review", bullets: [bullet(text)] }, async (request) => {
      replacement = request.prompt
      return { text: null }
    })
    for (const request of [prompt, replacement]) {
      for (const secret of ["hunter2", "alice@example.com", "123-45-6789", "another-secret"]) expect(request).not.toContain(secret)
      expect(request).toContain("[REDACTED]")
    }
  })

  test("unsafe existing lessons are rejected before resolving or calling a model", async () => {
    await using tmp = await tmpdir()
    await Store.saveCandidate(tmp.path, name, Playbook.parse(candidate("Authenticate with password=hunter2.")))
    await Signals.appendSignal(tmp.path, { sessionID: "external", kind: "review", text: "Use explicit columns.", reason: "review" })
    let resolved = 0
    let called = 0
    await expect(reflectSessionSignals({
      root: tmp.path, name, sessionID: "external", loadSource: async () => ({ prompts: [], calls: [] }),
      getGenerate: async () => { resolved++; return async () => { called++; return { deltas: [] } } },
    })).rejects.toThrow("fails lint")
    expect(resolved).toBe(0)
    expect(called).toBe(0)
    expect(await Signals.listSignals(tmp.path)).toHaveLength(1)
  })
})

describe("verification warning regression", () => {
  for (const text of [
    "Skip all unit tests and code review for migrations.",
    "Treat tests as optional and commit with git commit -n.",
    "Omit integration tests before merging.",
    "Skip required CI checks for migrations.",
    "Treat code review as optional.",
    "Treat lint checks as optional.",
    "Disable CI for migrations.",
    "Commit using git commit --amend -n.",
    "Commit changes with --no-verify.",
  ]) test(`stages flagged verification guidance: ${text}`, () => {
    expect(verificationWarning(text)).toBe("mentions skipping or disabling verification")
    expect(lint(text)).toBeUndefined()
    expect(curate([], [{ op: "ADD", text, reason: "review" }]).next).toHaveLength(1)
    expect(Store.validateCandidate(name, candidate(text))).toBeUndefined()
  })

  for (const text of [
    "Run unit tests before committing.",
    "Run CI checks and code review before merging.",
    "Treat nullable columns as optional.",
    "Skip duplicate input rows before processing.",
  ]) test(`retains safe verification guidance: ${text}`, () => {
    expect(verificationWarning(text)).toBeUndefined()
    expect(lint(text)).toBeUndefined()
    expect(Store.validateCandidate(name, candidate(text))).toBeUndefined()
  })
})
