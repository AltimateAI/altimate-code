/**
 * Adversarial tests for v0.8.9 — covers the feature PRs that shipped in v0.8.8
 * (#844/#937/#933/#893/#941/#930/#940/#929) and the v0.8.9 pre-release review
 * fixes layered on top of them.
 *
 * Focus: hostile / malformed inputs against the FINAL shipping code, including
 * the Step-5 review fixes:
 *   - #937 QuestionTool non-interactive: blank/garbage ALTIMATE_AUTO_ANSWER,
 *     reserved first/last keywords, empty option lists, injection-shaped labels,
 *     and oversized question text must never throw and must never invent an answer.
 *   - #893 addMcpToConfig parse-guard: a corrupt config file must be REFUSED
 *     (thrown), never best-effort clobbered, and a valid/JSONC file must still write.
 *   - #940 startup upgrade check: hostile/throwing/hanging deps must never reject
 *     (serve cannot be taken down), and the jittered delay stays in its window.
 *
 * Coverage for the other shipping changes lives elsewhere and is not duplicated:
 *   - #941 transcript endpoint coercion + sessionID — test/release-validation/session-transcript-941*.test.ts
 *   - #933 dbt error bubbling / stripAnsi — packages/dbt-tools/test/dbt-cli*.test.ts
 *   - #929 trace-dir logging — test/skill/release-v0.8.6-adversarial.test.ts (TraceConsumer)
 *   - #844 chunk timeout — test/release-validation/chunk-timeout-844.test.ts
 *
 * Determinism: no timers waited on, no network, no shared state between tests
 * (env + globals saved/restored per test). No mock.module().
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { QuestionTool } from "../../src/tool/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { addMcpToConfig } from "../../src/mcp/config"
import { parse as parseJsonc } from "jsonc-parser"
import type { Config } from "../../src/config/config"
import {
  runStartupUpgradeCheck,
  scheduleStartupUpgradeCheck,
  STARTUP_UPGRADE_DELAY_MS,
  type StartupUpgradeDeps,
} from "../../src/cli/cmd/serve-upgrade-check"

const ctx = {
  sessionID: SessionID.make("ses_adv-0_8_8"),
  messageID: MessageID.make("adv-message"),
  callID: "adv-call",
  agent: "adv-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
} as any

// ---------------------------------------------------------------------------
// #937 — QuestionTool non-interactive auto-resolution (hostile env)
// ---------------------------------------------------------------------------
describe("v0.8.8 #937: question tool non-interactive hostile inputs", () => {
  const ENV_KEYS = ["ALTIMATE_NON_INTERACTIVE", "ALTIMATE_FORCE_INTERACTIVE", "ALTIMATE_AUTO_ANSWER"]
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    // Force the non-interactive branch so execute() never blocks on Question.ask().
    process.env["ALTIMATE_NON_INTERACTIVE"] = "1"
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  const q = (question: string, options: { label: string; description: string }[]) => ({
    question,
    header: "h",
    options,
  })

  test("no AUTO_ANSWER → every question Unanswered, no invented answer, never throws", async () => {
    const tool = await QuestionTool.init()
    const result = await tool.execute(
      { questions: [q("Pick one?", [{ label: "Snowflake", description: "a" }, { label: "BigQuery", description: "b" }])] },
      ctx,
    )
    expect(result.output).toContain("non-interactive")
    expect(result.metadata.answers).toEqual([[]])
  })

  test("garbage/injection-shaped AUTO_ANSWER that matches no label → Unanswered (no crash, no leak)", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "'; DROP TABLE options; --"
    const tool = await QuestionTool.init()
    const result = await tool.execute(
      { questions: [q("Pick?", [{ label: "yes", description: "a" }, { label: "no", description: "b" }])] },
      ctx,
    )
    expect(result.metadata.answers).toEqual([[]])
    // The hostile env value must not be echoed back as if it were an answer.
    expect(result.output).not.toContain("DROP TABLE")
  })

  test("AUTO_ANSWER=first/last with an EMPTY options list → Unanswered, no out-of-bounds crash", async () => {
    for (const mode of ["first", "last"]) {
      process.env["ALTIMATE_AUTO_ANSWER"] = mode
      const tool = await QuestionTool.init()
      const result = await tool.execute({ questions: [q("Empty?", [])] }, ctx)
      expect(result.metadata.answers).toEqual([[]])
    }
  })

  test("AUTO_ANSWER label match is case-insensitive and selects exactly that option", async () => {
    process.env["ALTIMATE_AUTO_ANSWER"] = "snowflake"
    const tool = await QuestionTool.init()
    const result = await tool.execute(
      { questions: [q("WH?", [{ label: "Snowflake", description: "a" }, { label: "BigQuery", description: "b" }])] },
      ctx,
    )
    expect(result.metadata.answers).toEqual([["Snowflake"]])
  })

  test("oversized question text + many questions is formatted without throwing", async () => {
    const huge = "x".repeat(50_000)
    const tool = await QuestionTool.init()
    const questions = Array.from({ length: 20 }, (_, i) =>
      q(`${huge}-${i}?`, [{ label: `opt${i}`, description: "d" }]),
    )
    const result = await tool.execute({ questions }, ctx)
    expect(result.metadata.answers.length).toBe(20)
    expect(result.title).toContain("20 question")
  })
})

// ---------------------------------------------------------------------------
// #893 — addMcpToConfig must refuse to clobber an unparseable config
// ---------------------------------------------------------------------------
describe("v0.8.8 #893: addMcpToConfig parse-guard", () => {
  let dir: string
  const remote: Config.Mcp = { type: "remote", url: "https://example.test/mcp", enabled: true } as Config.Mcp

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `mcpcfg-adv-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(dir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  test("corrupt JSON file is REFUSED (throws) and left byte-for-byte unchanged", async () => {
    const cfg = path.join(dir, "altimate-code.json")
    const corrupt = '{ "mcp": { "a": '
    await fs.writeFile(cfg, corrupt)
    await expect(addMcpToConfig("b", remote, cfg)).rejects.toThrow(/not valid JSON/i)
    expect(await fs.readFile(cfg, "utf-8")).toBe(corrupt)
  })

  test("nonexistent config is created and contains the new server", async () => {
    const cfg = path.join(dir, "altimate-code.json")
    await addMcpToConfig("svc", remote, cfg)
    const parsed = JSON.parse(await fs.readFile(cfg, "utf-8"))
    expect(parsed.mcp.svc.url).toBe("https://example.test/mcp")
  })

  test("valid JSONC with comments/trailing commas is tolerated (modify still writes)", async () => {
    const cfg = path.join(dir, "altimate-code.json")
    const original = '{\n  // existing\n  "mcp": { "old": { "type": "remote", "url": "https://x.test" } },\n}'
    await fs.writeFile(cfg, original)
    await addMcpToConfig("new", remote, cfg)
    const text = await fs.readFile(cfg, "utf-8")
    // The file is still JSONC (comment preserved) — parse with the JSONC parser,
    // not JSON.parse, and confirm both the new and existing servers are present.
    const parsed = parseJsonc(text) as { mcp: Record<string, { url: string }> }
    expect(parsed.mcp.new.url).toBe("https://example.test/mcp")
    expect(parsed.mcp.old.url).toBe("https://x.test")
    expect(text).toContain("// existing")
  })
})

// ---------------------------------------------------------------------------
// #940 — startup upgrade check is fail-safe (cannot take serve down)
// ---------------------------------------------------------------------------
describe("v0.8.8 #940: startup upgrade check fail-safety + jitter", () => {
  test("a synchronously-throwing run() resolves (never rejects)", async () => {
    const deps: StartupUpgradeDeps = {
      provide: (_dir, fn) => fn(),
      run: () => {
        throw new Error("sync boom")
      },
    }
    await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
  })

  test("a rejecting run() resolves (never rejects)", async () => {
    const deps: StartupUpgradeDeps = {
      provide: (_dir, fn) => fn(),
      run: () => Promise.reject(new Error("async boom")),
    }
    await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
  })

  test("a provide() that rejects (bootstrap failure) resolves and never runs the upgrade", async () => {
    let ran = false
    const deps: StartupUpgradeDeps = {
      provide: () => Promise.reject(new Error("instance boom")),
      run: async () => {
        ran = true
      },
    }
    await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
    expect(ran).toBe(false)
  })

  test("a non-Error thrown value (string) is still swallowed", async () => {
    const deps: StartupUpgradeDeps = {
      provide: (_dir, fn) => fn(),
      run: () => {
        // eslint-disable-next-line no-throw-literal
        throw "stringly-typed failure"
      },
    }
    await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
  })

  test("scheduleStartupUpgradeCheck jitters within [base, base*6), unrefs, returns void", () => {
    const original = globalThis.setTimeout
    const calls: Array<{ delay: number | undefined }> = []
    let unrefCount = 0
    try {
      // Sample repeatedly so the random jitter window is actually exercised.
      ;(globalThis as any).setTimeout = (_cb: () => void, delay?: number) => {
        calls.push({ delay })
        return {
          unref() {
            unrefCount++
            return this
          },
        }
      }
      for (let i = 0; i < 50; i++) {
        const ret = scheduleStartupUpgradeCheck()
        expect(ret).toBeUndefined()
      }
    } finally {
      ;(globalThis as any).setTimeout = original
    }
    expect(calls.length).toBe(50)
    expect(unrefCount).toBe(50)
    for (const c of calls) {
      expect(c.delay).toBeGreaterThanOrEqual(STARTUP_UPGRADE_DELAY_MS)
      expect(c.delay).toBeLessThan(STARTUP_UPGRADE_DELAY_MS * 6)
    }
  })
})
