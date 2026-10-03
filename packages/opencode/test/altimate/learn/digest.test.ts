// altimate_change - new file
import { describe, expect, test } from "bun:test"
import {
  buildDigest,
  DIGEST_CAP,
  hasHighEntropyToken,
  hasSecretPattern,
  redactSecrets,
  sourceFromMessages,
  sourceFromTrajectory,
  createDigestAccumulator,
  sourceFromMessageStream,
} from "../../../src/altimate/learn/digest"
import type { MessageV2 } from "../../../src/session/message-v2"

describe("redactSecrets", () => {
  const secrets = [
    "AKIAIOSFODNN7EXAMPLE",
    "sk-abcdef1234567890XYZ",
    "ghp_abcdefghijklmnop1234",
    "xoxb-1234567890-abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk",
    "9fK2xQ7LmZ4pW8vB3nR6tY1uC5dH",
  ]
  for (const s of secrets)
    test(`redacts ${s.slice(0, 8)}…`, () => {
      const out = redactSecrets(`before ${s} after`)
      expect(out).not.toContain(s)
      expect(out).toContain("[REDACTED]")
    })

  test("redacts assignments, bearer tokens, URL credentials and private keys", () => {
    expect(redactSecrets("password=hunter2 ok")).toBe("password=[REDACTED] ok")
    expect(redactSecrets('{"api_key": "abc123"}')).not.toContain("abc123")
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop12345")).not.toContain("abcdefghijklmnop12345")
    expect(redactSecrets("postgres://user:pa55w0rd@host/db")).toBe("postgres://user:[REDACTED]@host/db")
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----")).toBe("[REDACTED]")
  })

  for (const [text, expected] of [
    ["postgres://admin:p@ssw0rd!@db.internal:5432/app", "postgres://admin:[REDACTED]@db.internal:5432/app"],
    ['const password: string = "hunter2secret"', "const password: string = [REDACTED]"],
    ['password => "hunter2secret"', "password => [REDACTED]"],
    [String.raw`{\"password\": \"hunter2secret\"}`, String.raw`{\"password\": [REDACTED]}`],
    [String.raw`{\"password\": \"hunter2 secret with \\\"quotes\\\"\"}`, String.raw`{\"password\": [REDACTED]}`],
    ["DB_PASS=hunter2secret", "DB_PASS=[REDACTED]"],
    [String.raw`DB_PASS=hunter\ two command`, "DB_PASS=[REDACTED] command"],
    [String.raw`DB_PASS=hunter\ two\ three command`, "DB_PASS=[REDACTED] command"],
    ["DB_PASS=hunter\\\ttwo command", "DB_PASS=[REDACTED] command"],
    [String.raw`APP_SECRET=hunter\ two command`, "APP_SECRET=[REDACTED] command"],
    ["DB_PWD=hunter2secret", "DB_PWD=[REDACTED]"],
    ["APP_SECRET=hunter2", "APP_SECRET=[REDACTED]"],
    ["AUTH_TOKEN=hunter2secret", "AUTH_TOKEN=[REDACTED]"],
    ["ENCRYPTION_KEY=hunter2secret", "ENCRYPTION_KEY=[REDACTED]"],
    ["MAX_TOKENS_PASSWORD=hunter2", "MAX_TOKENS_PASSWORD=[REDACTED]"],
    ["MAX_TOKENS_API_KEY=hunter2", "MAX_TOKENS_API_KEY=[REDACTED]"],
    ["MAX_TOKEN_SECRET=hunter2", "MAX_TOKEN_SECRET=[REDACTED]"],
  ]) test(`redacts credential values without leaving a secret behind: ${text}`, () => {
    expect(redactSecrets(text)).toBe(expected)
    expect(hasSecretPattern(text)).toBe(true)
    expect(redactSecrets(expected)).toBe(expected)
  })

  for (const [text, expected] of [
    ["sqlcmd -S mysql -P hunter2", "sqlcmd -S mysql -P [REDACTED]"],
    ["mysql -p mysql", "mysql -p [REDACTED]"],
    ["/usr/bin/sshpass -p hunter2 ssh -p 2222 host", "/usr/bin/sshpass -p [REDACTED] ssh -p 2222 host"],
    ["docker login -u analyst -p warehouse_secret", "docker login -u analyst -p [REDACTED]"],
    ["docker login -u x -p y", "docker login -u x -p [REDACTED]"],
    ["docker login -u x --password y", "docker login -u x --password [REDACTED]"],
    ["echo mysql -p hunter2", "echo mysql -p [REDACTED]"],
    ["echo $(printf ok) mysql -p docs", "echo $(printf ok) mysql -p [REDACTED]"],
    ["echo `printf ok` mysql -p docs", "echo `printf ok` mysql -p [REDACTED]"],
    ["echo one & mysql -p docs", "echo one & mysql -p [REDACTED]"],
    ["x.mysql -p hunter2", "x.mysql -p [REDACTED]"],
    ["Use redis-cli or sqlcmd -P hunter2 to connect.", "Use redis-cli or sqlcmd -P [REDACTED] to connect."],
  ]) test(`redacts command occurrence: ${text}`, () => {
    expect(redactSecrets(text)).toBe(expected)
    expect(hasSecretPattern(text)).toBe(true)
    expect(redactSecrets(expected)).toBe(expected)
  })

  for (const prefix of ["", "\n", "echo ok; ", "echo ok | ", "echo ok && ", "echo ok || ", "echo $(", "Use `", "$ ", "sudo ", "env ", "env MODE=dev "]) {
    test(`recognizes command occurrence after ${JSON.stringify(prefix)}`, () => {
      expect(redactSecrets(`${prefix}mysql -phunter2`)).toBe(`${prefix}mysql -p[REDACTED]`)
    })
  }

  test("restores command context after command substitutions", () => {
    expect(redactSecrets("mysql -h $(printf localhost) -phunter2")).toBe("mysql -h $(printf localhost) -p[REDACTED]")
    expect(redactSecrets("mysql -h `printf localhost` -phunter2")).toBe("mysql -h `printf localhost` -p[REDACTED]")
    expect(redactSecrets("echo $(echo $(mysql -phunter2)) mysql -p docs")).toBe("echo $(echo $(mysql -p[REDACTED])) mysql -p [REDACTED]")
  })

  test("redacts entire unquoted passwords containing escaped whitespace", () => {
    for (const [text, expected] of [
      [String.raw`mysql -p hunter\ two --host localhost`, "mysql -p [REDACTED] --host localhost"],
      [String.raw`mysql -phunter\ two --host localhost`, "mysql -p[REDACTED] --host localhost"],
      [String.raw`docker login -p hunter\ two registry`, "docker login -p [REDACTED] registry"],
      [String.raw`sshpass -p hunter\ two ssh -p 2222 host`, "sshpass -p [REDACTED] ssh -p 2222 host"],
      ["mysql -p hunter\\\ttwo --host localhost", "mysql -p [REDACTED] --host localhost"],
    ]) {
      expect(redactSecrets(text)).toBe(expected)
      expect(hasSecretPattern(text)).toBe(true)
      expect(redactSecrets(expected)).toBe(expected)
    }
  })

  for (const text of [
    `mysql --execute "SELECT 'curl -u';"`,
    `mysql -e "SELECT 'curl -u username';"`,
    `mysql --execute "SELECT -p hunter2`,
    `sqlcmd -Q "SELECT -P hunter2`,
    `redis-cli --eval 'return -a hunter2`,
    `curl -d "example -u hunter2`,
    `echo "mysql -p hunter2"`,
    `echo 'sqlcmd -P hunter2'`,
    `echo "one\ntwo; mysql -p hunter2"`,
    `echo "$(mysql -p hunter2)"`,
    "\\amysql -phunter2",
    "echo \\amysql -phunter2",
    "docker run -p 8080 image",
    "Use bearer tokens to authenticate.",
    "MAX_TOKENS=4096",
    "MAX_TOKEN=4096",
    "MAX_TOKENS_PER_REQUEST=4096",
    "MONKEY=foo",
    "BYPASS_CACHE=true",
  ]) test(`preserves noncredential context: ${text}`, () => {
    expect(redactSecrets(text)).toBe(text)
    expect(hasSecretPattern(text)).toBe(false)
  })

  for (const word of ["token", "tokens", "auth", "authentication", "scheme", "header", "credentials"]) {
    test(`preserves bearer terminology: ${word}`, () => {
      for (const text of [`Use bearer ${word} in docs.`, `Bearer ${word}`, `Use (bearer ${word} ) in docs.`, `Specify [Bearer ${word} ] in docs.`]) {
        expect(redactSecrets(text)).toBe(text)
        expect(hasSecretPattern(text)).toBe(false)
      }
      for (const text of [`Use bearer ${word}.`, `Authorization: Bearer ${word}`, `Authorization: Bearer ${word}.hunter2`, `Use (bearer ${word}) in docs.`, `Specify [Bearer ${word}] in docs.`]) {
        expect(redactSecrets(text)).toContain("[REDACTED]")
        expect(hasSecretPattern(text)).toBe(true)
      }
      expect(redactSecrets(`Bearer ${word}-hunter2`)).toBe("[REDACTED]")
    })
  }

  test("leaves ordinary text and long identifiers alone", () => {
    const t = "Run dbt build for stg_stripe__payments_amount_cents in models/staging, task-queue ok."
    expect(redactSecrets(t)).toBe(t)
    expect(hasHighEntropyToken(t)).toBe(false)
  })

  test("preserves ordinary numeric values while redacting credential assignments", () => {
    for (const text of ["order_id=123456789", "max_tokens=4096", "maxTokens=4096", "timeout=123456789"]) {
      expect(redactSecrets(text)).toBe(text)
      expect(hasSecretPattern(text)).toBe(false)
    }
    for (const text of [
      "password=4096", "api_key=123456789", "access_token=4096", "clientSecret=123", "dbPassword=4096",
      "authToken=4096", "apiKey=123456789", "DATABASEPASSWORD=4096", "service_api_key=4096",
      "db.password=4096", "tokenValue=4096", "secretValue=4096",
    ]) {
      expect(redactSecrets(text)).toContain("[REDACTED]")
      expect(hasSecretPattern(text)).toBe(true)
    }
  })
})

describe("redaction performance on 100 KB inputs", () => {
  const size = 100_000
  const repeat = (text: string) => text.repeat(Math.ceil(size / text.length)).slice(0, size)
  const families: Array<[string, string]> = [
    ["review6 repeated embedded command", "x.mysql ".repeat(12500)],
    ["plain text", "x".repeat(size)],
    ["known tools as arguments", repeat("mysql mysql redis-cli sqlcmd curl ")],
    ["shell command boundaries", repeat("mysql -phunter2; sqlcmd -P hunter2\n")],
    ["quoted SQL commands", repeat(`mysql --execute "SELECT 'curl -u';"\n`)],
    ["unterminated quote", `mysql --execute "${repeat("curl -u x; ")}`.slice(0, size)],
    ["escaped quotes", repeat('mysql -e "a\\"b"\n')],
    ["assignment near misses", repeat("password ")],
    ["credential assignments", repeat("password=hunter2 ")],
    ["unterminated braced assignment", `password={${"x".repeat(size - 10)}`],
    ["bearer terminology", repeat("Use bearer tokens to authenticate. ")],
    ["URL credential near misses", repeat("mysql://user:password ")],
    ["email near misses", repeat("user.example.invalid ")],
  ]
  for (const [name, input] of families) test(name, () => {
    expect(input.length).toBe(size)
    const start = performance.now()
    const redacted = redactSecrets(input)
    expect(performance.now() - start).toBeLessThan(200)
    if (name === "unterminated quote") expect(redacted).toBe(input)
  })

  test("review6 digest redacts before clipping within the same budget", () => {
    const start = performance.now()
    buildDigest({ prompts: ["x.mysql ".repeat(12500)], calls: [] })
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe("buildDigest", () => {
  test("large inputs and outputs are redacted within the bounded window and clipped", () => {
    // Only a short prefix is shown, and the redaction window extends far past it, so a shown secret is always redacted whole.
    const command = `${"x".repeat(3_984)}AKIAIOSFODNN7EXAMPLE`
    const digest = buildDigest({ prompts: [], calls: [{ name: "bash", input: { command } }] })
    expect(digest).not.toContain("AKIAIOSFODNN7")
    const output = `${"y".repeat(390)}AKIAIOSFODNN7EXAMPLE${"z".repeat(10_000)}`
    const tail = buildDigest({ prompts: [], calls: [{ name: "bash", input: {}, output }] })
    expect(tail).not.toContain("AKIAIOSFODNN7")
    expect(tail).toContain("chars]")
  })

  test("includes prompts, calls, files and final text, truncating call input/output", () => {
    const d = buildDigest({
      prompts: ["Add a staging model for orders"],
      calls: [
        { name: "bash", input: { command: "x".repeat(1000) }, output: "y".repeat(1000) },
        { name: "write", input: { filePath: "models/stg_orders.sql", content: "select 1" }, output: "ok" },
        { name: "bash", input: { command: "dbt build" }, error: "Compilation Error" },
      ],
      finalText: "Done.",
    })
    expect(d).toContain("Add a staging model for orders")
    expect(d).toContain("1. bash(")
    expect(d).toContain("→ ERROR: Compilation Error")
    expect(d).toContain("- models/stg_orders.sql")
    expect(d).toContain("Done.")
    expect(d).not.toContain("x".repeat(400))
    expect(d).not.toContain("y".repeat(401))
    expect(d).toContain("[+")
  })

  test("extracts files from apply_patch text", () => {
    const d = buildDigest({
      prompts: ["p"],
      calls: [{ name: "apply_patch", input: { patchText: "*** Begin Patch\n*** Add File: a/b.sql\n+x\n*** Update File: c.yml\n" } }],
    })
    expect(d).toContain("- a/b.sql")
    expect(d).toContain("- c.yml")
  })

  test("is capped at 24k chars and keeps prompt and final answer", () => {
    const calls = Array.from({ length: 400 }, (_, i) => ({ name: "bash", input: { command: `cmd ${i} ${"a".repeat(250)}` }, output: "o".repeat(500) }))
    const d = buildDigest({ prompts: ["THE TASK"], calls, finalText: "THE END" })
    expect(DIGEST_CAP).toBe(24_000)
    expect(d.length).toBeLessThanOrEqual(DIGEST_CAP)
    expect(d).toContain("THE TASK")
    expect(d).toContain("THE END")
    expect(d).toContain("tool calls omitted")
    expect(d).toContain("1. bash(")
    expect(d).toContain("400. bash(")
  })

  test("many prompts retain first and last requests plus tools, files, and final context", () => {
    const d = buildDigest({
      prompts: Array.from({ length: 100 }, (_, i) => `request ${i}: ${"p".repeat(3_000)}`),
      calls: [
        { name: "bash", input: { command: "first command" }, output: "first result" },
        { name: "write", input: { filePath: "models/stg_orders.sql", content: "select 1" }, output: "last result" },
      ],
      finalText: "THE END",
    })
    expect(d.length).toBeLessThanOrEqual(DIGEST_CAP)
    for (const text of ["request 0:", "request 99:", "1. bash(", "2. write(", "last result", "- models/stg_orders.sql", "THE END"])
      expect(d).toContain(text)
  })

  test("redacts secrets everywhere", () => {
    const d = buildDigest({
      prompts: ["use key sk-abcdef1234567890XYZ"],
      calls: [{ name: "bash", input: { command: "export TOKEN=ghp_abcdefghijklmnop1234" }, output: "password=hunter2" }],
      finalText: "AKIAIOSFODNN7EXAMPLE",
    })
    for (const s of ["sk-abcdef1234567890XYZ", "ghp_abcdefghijklmnop1234", "hunter2", "AKIAIOSFODNN7EXAMPLE"]) expect(d).not.toContain(s)
  })
})

describe("sources", () => {
  test("sourceFromTrajectory reads steps, tool calls and prompts", () => {
    const src = sourceFromTrajectory({
      user_prompts: ["do it"],
      steps: [
        { text: "thinking", tool_calls: [{ name: "bash", input: { command: "ls" }, output: "a", status: "completed" }] },
        { text: "final", tool_calls: [{ name: "bash", input: {}, error: "boom", status: "error" }] },
      ],
    })
    expect(src.prompts).toEqual(["do it"])
    expect(src.calls).toHaveLength(2)
    expect(src.calls[1].error).toBe("boom")
    expect(src.finalText).toBe("final")
  })

  test("sourceFromTrajectory rejects other shapes", () => {
    expect(() => sourceFromTrajectory({ nope: 1 })).toThrow("Not a trajectory export")
  })

  test("sourceFromMessages skips synthetic user text and maps tool states", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "real" }, { type: "text", text: "synthetic", synthetic: true }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", tool: "bash", state: { status: "completed", input: { c: 1 }, output: "ok" } },
          { type: "tool", tool: "bash", state: { status: "error", input: { c: 2 }, error: "bad" } },
          { type: "text", text: "all done" },
        ],
      },
    ] as never
    const src = sourceFromMessages(msgs)
    expect(src.prompts).toEqual(["real"])
    expect(src.calls.map((c) => [c.output, c.error])).toEqual([["ok", undefined], [undefined, "bad"]])
    expect(src.finalText).toBe("all done")
  })
})

describe("streaming session digests", () => {
  test("retains bounded first/last prompts and calls plus the final assistant and model", async () => {
    async function* messages(): AsyncIterable<MessageV2.WithParts> {
      for (let i = 0; i < 500; i++) {
        yield {
          info: { role: "user" },
          parts: [{ type: "text", text: `request ${i}: ${"p".repeat(3_000)}` }],
        } as MessageV2.WithParts
        yield {
          info: { role: "assistant", providerID: `provider-${i}`, modelID: `model-${i}` },
          parts: [
            { type: "tool", tool: "bash", state: { status: "completed", input: { command: `command ${i}: ${"x".repeat(2_000)}` }, output: "o".repeat(2_000) } },
            { type: "text", text: `assistant ${i}` },
          ],
        } as MessageV2.WithParts
      }
    }
    const source = await sourceFromMessageStream(messages())
    expect(JSON.stringify(source).length).toBeLessThan(DIGEST_CAP)
    expect(source.prompts).toHaveLength(2)
    expect(source.calls.length).toBeLessThan(30)
    expect(source.callCount).toBe(500)
    expect(source.model).toEqual({ providerID: "provider-499", modelID: "model-499" })
    const digest = buildDigest(source)
    for (const text of ["request 0:", "request 499:", "command 0:", "command 499:", "assistant 499", "Tool calls (500)", "tool calls omitted"])
      expect(digest).toContain(text)
    expect(digest.length).toBeLessThanOrEqual(DIGEST_CAP)
  })

  test("redacts complete text and sensitive JSON fields before retaining or clipping", () => {
    const accumulator = createDigestAccumulator()
    const password = "a".repeat(5_000)
    accumulator.add({
      info: { role: "user" },
      parts: [
        { type: "text", text: `Use postgres://user:${password}@localhost/db` },
        { type: "text", text: "synthetic", synthetic: true },
        { type: "text", text: "ignored", ignored: true },
      ],
    } as MessageV2.WithParts)
    accumulator.add({
      info: { role: "assistant", providerID: "provider", modelID: "model" },
      parts: [
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "models/orders.sql", password: 12345, content: 'mysql -p"hunter2"' }, output: "token=secret-output" } },
        { type: "tool", tool: "bash", state: { status: "error", input: {}, error: "password=secret-error" } },
        { type: "text", text: "-----BEGIN PRIVATE KEY-----" },
        { type: "text", text: `${"b".repeat(5_000)}\n-----END PRIVATE KEY-----` },
      ],
    } as MessageV2.WithParts)
    const source = accumulator.source()
    const retained = JSON.stringify(source)
    for (const secret of ["a".repeat(30), "b".repeat(30), "12345", "hunter2", "secret-output", "secret-error", "synthetic", "ignored"])
      expect(retained).not.toContain(secret)
    expect(retained).toContain("[REDACTED]")
    expect(buildDigest(source)).toContain("- models/orders.sql")
    expect(buildDigest(source)).toContain("ERROR: password=[REDACTED]")
  })
})
