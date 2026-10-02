// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { buildDigest, hasSecretPattern, redactSecrets, type DigestSource } from "../../../src/altimate/learn/digest"
import { buildPrompt, FEEDBACK_CAP, replace } from "../../../src/altimate/learn/reflect"
import { lint } from "../../../src/altimate/learn/curator"
import { clipSignalText } from "../../../src/altimate/learn/signals"
import { ToolRetryTracker } from "../../../src/altimate/learn/capture"

describe("review: credential patterns match redaction and lesson lint", () => {
  const cases: Array<[string, string]> = [
    ["curl -u alice:hunter2", "hunter2"],
    ["curl --user alice:hunter2", "hunter2"],
    ['curl --user="alice:two words"', "two words"],
    ["curl -ualice:hunter2", "hunter2"],
    ["curl --proxy-user alice:hunter2", "hunter2"],
    ["--proxy-user u:p", "u:p"],
    ['curl --proxy-user="alice:two words"', "two words"],
    ["api key: hunter2", "hunter2"],
    ["api key: x", "x"],
    ["API key: hunter2", "hunter2"],
    ["api_key=hunter2", "hunter2"],
    ["api_key=x", "x"],
    ["token: hunter2", "hunter2"],
    ["token: x", "x"],
    ["secret: hunter2", "hunter2"],
    ["secret: x", "x"],
    ["password: |\n  hunter2", "hunter2"],
    ['password: "first\nhunter2\nlast"', "hunter2"],
    ["password: 'first\nhunter2\nlast'", "hunter2"],
    ['password: "first\\\"hunter2\nlast"', "hunter2"],
    ['client --password "first\nhunter2\nlast"', "hunter2"],
    ['mysql -p"first\nhunter2\nlast"', "hunter2"],
    ["ｐａｓｓｗｏｒｄ: hunter2", "hunter2"],
    ["pass\u200bword: hunter2", "hunter2"],
    ["to\u200dken: hunter2", "hunter2"],
    ["Authorization: Basic YWxpY2U6cHc=", "YWxpY2U6cHc="],
    ["Authorization: Basic x", "Basic x"],
    ["Authorization: Bearer x", "Bearer x"],
    ["Authorization: Bearer !@#$%^*", "!@#$%^*"],
    ["Bearer hunter2", "hunter2"],
    ...["redis", "postgres", "mysql", "mongodb", "mongodb+srv", "amqp", "https", "custom+db"].flatMap((scheme): Array<[string, string]> => [
      [`${scheme}://alice:hunter2@localhost/db`, "hunter2"],
      [`${scheme}://:hunter2@localhost/db`, "hunter2"],
    ]),
  ]
  for (const [text, secret] of cases) test(text, () => {
    const redacted = redactSecrets(text)
    expect(redacted).not.toContain(secret)
    expect(redacted).toContain("[REDACTED]")
    expect(redactSecrets(redacted)).toBe(redacted)
    expect(hasSecretPattern(text)).toBe(true)
    expect(lint(text)).toBeDefined()
  })
})

describe("review: short password flags depend on the command", () => {
  for (const text of [
    "Run git log -p before merging.",
    "Connect using psql -p 5432.",
    "Create output with mkdir -p models.",
    "Connect using snowsql -p 5432.",
    "Connect using mysql -P 3306.",
    "Measure sqlcmd -p 1 output.",
    "Run mysql --version; git log -p before merging.",
    "Run mysql --version | git log -p before merging.",
    "Run mysql --version && psql -p 5432.",
    "Note mysql syntax. Run git log -p before merging.",
    "Note mariadb syntax. Connect using psql -p 5432.",
    "Note mysql syntax. Create output with mkdir -p models.",
    'Run mysql -e "select amount -p delta".',
    'Run sqlcmd -Q "select amount -P delta".',
  ]) test(`preserves ${text}`, () => {
    expect(redactSecrets(text)).toBe(text)
    expect(hasSecretPattern(text)).toBe(false)
    expect(lint(text)).toBeUndefined()
  })

  for (const [command, flag] of [["mysql", "-p"], ["mariadb", "-p"], ["mysqldump", "-p"], ["mysqladmin", "-p"], ["mariadb-dump", "-p"], ["mysqlcheck", "-p"], ["mysql-custom-tool", "-p"], ["mariadb-admin", "-p"], ["sqlcmd", "-P"], ["bcp", "-P"]]) {
    for (const value of [" hunter2", "hunter2", "=hunter2", ' "hunter2 two words"']) test(`redacts ${command} ${flag}${value}`, () => {
      const text = `${command} -S example ${flag}${value}`
      expect(redactSecrets(text)).not.toContain("hunter2")
      expect(hasSecretPattern(text)).toBe(true)
      expect(lint(text)).toBe("looks like a secret")
    })
  }

  for (const [command, flag] of [["mysqladmin", "-p"], ["mariadb-dump", "-p"], ["sqlcmd", "-P"], ["client", "--password"]]) {
    for (const text of [`${command} \\\n  ${flag} hunter2`, `${command} ${flag} \\\n  hunter2`]) test(`redacts continued ${JSON.stringify(text)}`, () => {
      expect(redactSecrets(text)).not.toContain("hunter2")
      expect(hasSecretPattern(text)).toBe(true)
      expect(lint(text)).toBeDefined()
    })
  }

  test("YAML block and quoted multiline redaction preserve the following field", () => {
    for (const value of ["|\n  first\n  hunter2", '"first\nhunter2"', "'first\nhunter2'"]) {
      const text = `password: ${value}\nnext: keep`
      expect(redactSecrets(text)).toBe("password: [REDACTED]\nnext: keep")
    }
  })

  for (const secret of ["!", "?", ".", "hunter2!", "hunter2?"]) test(`preserves redaction of punctuation passwords ${secret}`, () => {
    expect(redactSecrets(`mysql -p${secret}`)).toBe("mysql -p[REDACTED]")
    expect(hasSecretPattern(`mysql -p${secret}`)).toBe(true)
  })

  for (const text of ["mysql -h db.example. -phunter2", "sqlcmd -S db.example. -P hunter2"]) test(`redacts passwords after a fully qualified hostname: ${text}`, () => {
    expect(redactSecrets(text)).not.toContain("hunter2")
    expect(hasSecretPattern(text)).toBe(true)
    expect(lint(text)).toBe("looks like a secret")
  })
})

// Put the @ just beyond the old cap: clipping first leaves a password that no longer matches a URL.
const crossing = (cap: number) => "x".repeat(cap - " https://alice:hunter2".length) + " https://alice:hunter2@localhost/db"
const longPassword = (cap: number) => `https://alice:hunter2${"x".repeat(cap)}@localhost/db`
const clean = (text: string) => {
  expect(text).not.toContain("hunter2")
  // The longer replacement marker may itself be clipped at the same boundary.
  expect(text).toContain("[REDACT")
}

describe("review: redact before every model input clipping boundary", () => {
  const sources: Array<[string, DigestSource]> = [
    ["user prompt", { prompts: [crossing(2_000)], calls: [] }],
    ["final assistant text", { prompts: [], calls: [], finalText: crossing(3_000) }],
    ["tool output", { prompts: [], calls: [{ name: "query", input: {}, output: crossing(400) }] }],
    ["tool error", { prompts: [], calls: [{ name: "query", input: {}, error: crossing(400) }] }],
    ["written file", { prompts: [], calls: [{ name: "write", input: { filePath: crossing(1_498) } }] }],
    ["raw tool input scan", { prompts: [], calls: [{ name: "query", input: longPassword(4_000) }] }],
    ["structured tool field scan", { prompts: [], calls: [{ name: "query", input: { command: longPassword(4_000) } }] }],
  ]
  for (const [name, source] of sources) test(name, () => clean(buildDigest(source)))

  test("reflection feedback", () => {
    clean(buildPrompt({ digest: "", bullets: [], feedback: crossing(FEEDBACK_CAP), kind: "review" }).prompt)
  })

  for (const field of ["feedback", "reasons"] as const) test(`replacement ${field}`, async () => {
    await replace({
      text: "Use explicit columns.", bullets: [], kind: "review",
      feedback: field === "feedback" ? crossing(FEEDBACK_CAP) : "review",
      reasons: field === "reasons" ? [crossing(FEEDBACK_CAP)] : ["review"],
    }, async ({ prompt }) => { clean(prompt); return { text: null } })
  })

  test("signal scan before the stored text cap", () => clean(clipSignalText(longPassword(20_000))))

  test("captured retry errors before their stored text cap", () => {
    const tracker = new ToolRetryTracker()
    for (let i = 0; i < 3; i++) {
      const episode = tracker.observe({ id: `tool-${i}`, messageID: "message", tool: "query", state: { status: "error", error: crossing(500) } })
      if (i === 2) clean(episode!.error)
    }
  })
})
