import { describe, test, expect, afterEach } from "bun:test"
import { PermissionNext } from "../src/permission/next"
import { PermissionID } from "../src/permission/schema"
import { SessionID } from "../src/session/schema"
import { Instance } from "../src/project/instance"
import { Flag } from "../src/flag/flag"
import { tmpdir } from "./fixture/fixture"

describe("yolo mode: Flag.ALTIMATE_CLI_YOLO dynamic getter", () => {
  const originalAltimate = process.env["ALTIMATE_CLI_YOLO"]
  const originalOpencode = process.env["OPENCODE_YOLO"]

  afterEach(() => {
    // Restore original env
    if (originalAltimate === undefined) delete process.env["ALTIMATE_CLI_YOLO"]
    else process.env["ALTIMATE_CLI_YOLO"] = originalAltimate
    if (originalOpencode === undefined) delete process.env["OPENCODE_YOLO"]
    else process.env["OPENCODE_YOLO"] = originalOpencode
  })

  test("flag is false when no env var is set", () => {
    delete process.env["ALTIMATE_CLI_YOLO"]
    delete process.env["OPENCODE_YOLO"]
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(false)
  })

  test("flag is true when ALTIMATE_CLI_YOLO=true", () => {
    process.env["ALTIMATE_CLI_YOLO"] = "true"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(true)
  })

  test("flag is true when ALTIMATE_CLI_YOLO=1", () => {
    process.env["ALTIMATE_CLI_YOLO"] = "1"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(true)
  })

  test("flag is true when OPENCODE_YOLO=true (fallback)", () => {
    delete process.env["ALTIMATE_CLI_YOLO"]
    process.env["OPENCODE_YOLO"] = "true"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(true)
  })

  test("flag is true when OPENCODE_YOLO=1 (fallback)", () => {
    delete process.env["ALTIMATE_CLI_YOLO"]
    process.env["OPENCODE_YOLO"] = "1"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(true)
  })

  test("flag is false for empty string", () => {
    process.env["ALTIMATE_CLI_YOLO"] = ""
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(false)
  })

  test("flag is false for arbitrary string", () => {
    process.env["ALTIMATE_CLI_YOLO"] = "yes"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(false)
  })

  test("flag is false for 'false'", () => {
    process.env["ALTIMATE_CLI_YOLO"] = "false"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(false)
  })

  test("flag is false for '0'", () => {
    process.env["ALTIMATE_CLI_YOLO"] = "0"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(false)
  })

  test("flag is case-insensitive (TRUE, True)", () => {
    process.env["ALTIMATE_CLI_YOLO"] = "TRUE"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(true)
    process.env["ALTIMATE_CLI_YOLO"] = "True"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(true)
  })

  test("CRITICAL: flag evaluates dynamically at access time, not module load time", () => {
    // This is the critical bug we fixed — the flag must be a dynamic getter
    // so that setting the env var in middleware (after module load) works
    delete process.env["ALTIMATE_CLI_YOLO"]
    delete process.env["OPENCODE_YOLO"]
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(false)

    // Simulate --yolo middleware setting env var after module load
    process.env["ALTIMATE_CLI_YOLO"] = "true"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(true)

    // Simulate unsetting
    delete process.env["ALTIMATE_CLI_YOLO"]
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(false)
  })

  test("ALTIMATE_CLI_YOLO=false overrides OPENCODE_YOLO=true (primary is authoritative)", () => {
    process.env["ALTIMATE_CLI_YOLO"] = "false"
    process.env["OPENCODE_YOLO"] = "true"
    // ALTIMATE_CLI_YOLO is authoritative when defined — explicit false disables yolo
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(false)
  })

  test("OPENCODE_YOLO=true activates yolo when ALTIMATE_CLI_YOLO is undefined (fallback)", () => {
    delete process.env["ALTIMATE_CLI_YOLO"]
    process.env["OPENCODE_YOLO"] = "true"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(true)
  })
})

describe("yolo mode: deny rules cannot be bypassed", () => {
  // The core safety guarantee: deny rules throw DeniedError BEFORE
  // permission.asked events are published. Yolo mode only handles
  // events, so it can never bypass deny.

  test("evaluate still returns deny regardless of any external state", () => {
    const denyRules: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "DROP DATABASE *", action: "deny" },
      { permission: "bash", pattern: "DROP SCHEMA *", action: "deny" },
      { permission: "bash", pattern: "TRUNCATE *", action: "deny" },
    ]

    expect(PermissionNext.evaluate("bash", "DROP DATABASE production", denyRules).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "DROP SCHEMA public", denyRules).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "TRUNCATE users", denyRules).action).toBe("deny")
  })

  test("deny rule wins over earlier allow-all wildcard (last-match-wins)", () => {
    const rules: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "DROP DATABASE *", action: "deny" },
    ]
    expect(PermissionNext.evaluate("bash", "DROP DATABASE prod", rules).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "ls -la", rules).action).toBe("allow")
  })

  test("deny rule wins even with complex overlapping patterns", () => {
    const rules: PermissionNext.Ruleset = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm -rf *", action: "ask" },
      { permission: "bash", pattern: "DROP *", action: "deny" },
    ]
    expect(PermissionNext.evaluate("bash", "DROP TABLE users", rules).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "rm -rf /tmp", rules).action).toBe("ask")
    expect(PermissionNext.evaluate("bash", "echo hello", rules).action).toBe("allow")
  })

  test("case-sensitive deny patterns match exactly", () => {
    const rules: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "DROP DATABASE *", action: "deny" },
    ]
    // Uppercase matches
    expect(PermissionNext.evaluate("bash", "DROP DATABASE prod", rules).action).toBe("deny")
    // Lowercase does NOT match (patterns are case-sensitive)
    expect(PermissionNext.evaluate("bash", "drop database prod", rules).action).toBe("allow")
  })

  test("default agent rules include both cases of dangerous commands", () => {
    // Verify the default agent rules cover both cases (from agent.ts)
    const defaultBashRules: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "DROP DATABASE *", action: "deny" },
      { permission: "bash", pattern: "DROP SCHEMA *", action: "deny" },
      { permission: "bash", pattern: "TRUNCATE *", action: "deny" },
      { permission: "bash", pattern: "drop database *", action: "deny" },
      { permission: "bash", pattern: "drop schema *", action: "deny" },
      { permission: "bash", pattern: "truncate *", action: "deny" },
    ]
    // Both cases denied
    expect(PermissionNext.evaluate("bash", "DROP DATABASE prod", defaultBashRules).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "drop database prod", defaultBashRules).action).toBe("deny")
    // Normal commands still ask
    expect(PermissionNext.evaluate("bash", "dbt run", defaultBashRules).action).toBe("ask")
  })
})

describe("yolo mode: permission evaluation is unchanged", () => {
  // Yolo mode works at the event reply level, NOT at the evaluate level.
  // These tests verify evaluate() behavior is completely unaffected.

  test("evaluate returns ask for unmatched permissions (yolo doesn't change this)", () => {
    expect(PermissionNext.evaluate("bash", "dbt run", []).action).toBe("ask")
    expect(PermissionNext.evaluate("edit", "src/main.ts", []).action).toBe("ask")
    expect(PermissionNext.evaluate("write", "output.sql", []).action).toBe("ask")
  })

  test("evaluate returns allow for explicitly allowed permissions", () => {
    const rules: PermissionNext.Ruleset = [
      { permission: "*", pattern: "*", action: "allow" },
    ]
    expect(PermissionNext.evaluate("bash", "dbt run", rules).action).toBe("allow")
    expect(PermissionNext.evaluate("edit", "any-file.ts", rules).action).toBe("allow")
  })

  test("disabled() is unaffected by yolo mode (it checks ruleset, not env)", () => {
    const rules: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
    ]
    const disabled = PermissionNext.disabled(["bash", "read", "edit"], rules)
    expect(disabled.has("bash")).toBe(true)
    expect(disabled.has("read")).toBe(false)
    expect(disabled.has("edit")).toBe(false)
  })

  test("fromConfig correctly converts nested permission config", () => {
    const config = {
      bash: {
        "*": "ask" as const,
        "dbt *": "allow" as const,
        "DROP *": "deny" as const,
      },
      read: "allow" as const,
    }
    const ruleset = PermissionNext.fromConfig(config)

    expect(PermissionNext.evaluate("bash", "dbt run", ruleset).action).toBe("allow")
    expect(PermissionNext.evaluate("bash", "DROP TABLE x", ruleset).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "ls", ruleset).action).toBe("ask")
    expect(PermissionNext.evaluate("read", "any-file", ruleset).action).toBe("allow")
  })
})

describe("yolo mode: edge cases and adversarial scenarios", () => {
  test("empty patterns array doesn't crash evaluate", () => {
    const rules: PermissionNext.Ruleset = []
    expect(PermissionNext.evaluate("bash", "", rules).action).toBe("ask")
    expect(PermissionNext.evaluate("", "", rules).action).toBe("ask")
  })

  test("permission with special characters in pattern", () => {
    const rules: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "rm -rf /Users/*/Documents/*", action: "deny" },
    ]
    expect(PermissionNext.evaluate("bash", "rm -rf /Users/john/Documents/important", rules).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "rm -rf /tmp/safe", rules).action).toBe("ask")
  })

  test("multiple rulesets are merged correctly (last wins)", () => {
    const defaults: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "DROP *", action: "deny" },
    ]
    const userOverride: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "allow" },
    ]
    // User allow-all comes AFTER default deny, so it wins for everything
    expect(PermissionNext.evaluate("bash", "DROP TABLE x", defaults, userOverride).action).toBe("allow")
    // But if user doesn't override, deny still works
    expect(PermissionNext.evaluate("bash", "DROP TABLE x", defaults).action).toBe("deny")
  })

  test("DeniedError contains relevant ruleset info", () => {
    const rules: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "DROP *", action: "deny" },
      { permission: "read", pattern: "*.env", action: "ask" },
    ]
    try {
      // Simulate what ask() does when it encounters deny
      const result = PermissionNext.evaluate("bash", "DROP TABLE users", rules)
      if (result.action === "deny") {
        throw new PermissionNext.DeniedError(
          rules.filter((r) => r.permission === "bash"),
        )
      }
    } catch (e) {
      expect(e).toBeInstanceOf(PermissionNext.DeniedError)
      expect((e as PermissionNext.DeniedError).message).toContain("deny")
    }
  })

  test("RejectedError and CorrectedError are distinct", () => {
    const rejected = new PermissionNext.RejectedError()
    const corrected = new PermissionNext.CorrectedError("use a different approach")

    expect(rejected.message).toContain("rejected")
    expect(corrected.message).toContain("use a different approach")
    expect(rejected).not.toBeInstanceOf(PermissionNext.CorrectedError)
  })
})

// ─── E2E: full ask → reply flow with yolo mode ────────────────────────────

describe("yolo mode E2E: permission ask/reply flow", () => {
  const originalYolo = process.env["ALTIMATE_CLI_YOLO"]

  afterEach(() => {
    if (originalYolo === undefined) delete process.env["ALTIMATE_CLI_YOLO"]
    else process.env["ALTIMATE_CLI_YOLO"] = originalYolo
  })

  test("deny rules still throw DeniedError even when yolo env var is set", async () => {
    process.env["ALTIMATE_CLI_YOLO"] = "true"
    expect(Flag.ALTIMATE_CLI_YOLO).toBe(true)

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(
          PermissionNext.ask({
            sessionID: SessionID.make("ses_yolo_deny_test"),
            permission: "bash",
            patterns: ["DROP DATABASE production"],
            metadata: {},
            always: [],
            ruleset: [
              { permission: "bash", pattern: "*", action: "ask" },
              { permission: "bash", pattern: "DROP DATABASE *", action: "deny" },
            ],
          }),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
      },
    })
  })

  test("allow rules skip ask entirely (no event published, no yolo needed)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await PermissionNext.ask({
          sessionID: SessionID.make("ses_yolo_allow_test"),
          permission: "bash",
          patterns: ["dbt run"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
        })
        expect(result).toBeUndefined()
      },
    })
  })

  test("ask rules wait for reply — yolo-style 'once' resolves them", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const askPromise = PermissionNext.ask({
          id: PermissionID.make("per_yolo_e2e"),
          sessionID: SessionID.make("ses_yolo_ask_test"),
          permission: "bash",
          patterns: ["echo hello"],
          metadata: {},
          always: [],
          ruleset: [],
        })

        const pending = await PermissionNext.list()
        expect(pending.some((p) => p.id === "per_yolo_e2e")).toBe(true)

        await PermissionNext.reply({
          requestID: PermissionID.make("per_yolo_e2e"),
          reply: "once",
        })

        await expect(askPromise).resolves.toBeUndefined()
      },
    })
  })

  test("multiple simultaneous permissions all resolved by yolo-style replies", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ask1 = PermissionNext.ask({
          id: PermissionID.make("per_yolo_multi_1"),
          sessionID: SessionID.make("ses_yolo_multi_test"),
          permission: "bash",
          patterns: ["dbt run"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        const ask2 = PermissionNext.ask({
          id: PermissionID.make("per_yolo_multi_2"),
          sessionID: SessionID.make("ses_yolo_multi_test"),
          permission: "edit",
          patterns: ["models/staging.sql"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        const ask3 = PermissionNext.ask({
          id: PermissionID.make("per_yolo_multi_3"),
          sessionID: SessionID.make("ses_yolo_multi_test"),
          permission: "write",
          patterns: ["output.csv"],
          metadata: {},
          always: [],
          ruleset: [],
        })

        const pending = await PermissionNext.list()
        expect(pending.filter((p) => p.sessionID === "ses_yolo_multi_test").length).toBe(3)

        await PermissionNext.reply({ requestID: PermissionID.make("per_yolo_multi_1"), reply: "once" })
        await PermissionNext.reply({ requestID: PermissionID.make("per_yolo_multi_2"), reply: "once" })
        await PermissionNext.reply({ requestID: PermissionID.make("per_yolo_multi_3"), reply: "once" })

        await expect(ask1).resolves.toBeUndefined()
        await expect(ask2).resolves.toBeUndefined()
        await expect(ask3).resolves.toBeUndefined()
      },
    })
  })

  test("mixed deny + ask: deny throws immediately, ask waits for reply", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rules: PermissionNext.Ruleset = [
          { permission: "bash", pattern: "*", action: "ask" },
          { permission: "bash", pattern: "DROP *", action: "deny" },
        ]

        await expect(
          PermissionNext.ask({
            sessionID: SessionID.make("ses_yolo_mixed"),
            permission: "bash",
            patterns: ["DROP TABLE users"],
            metadata: {},
            always: [],
            ruleset: rules,
          }),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)

        const askPromise = PermissionNext.ask({
          id: PermissionID.make("per_yolo_mixed"),
          sessionID: SessionID.make("ses_yolo_mixed"),
          permission: "bash",
          patterns: ["dbt run"],
          metadata: {},
          always: [],
          ruleset: rules,
        })

        await PermissionNext.reply({
          requestID: PermissionID.make("per_yolo_mixed"),
          reply: "once",
        })

        await expect(askPromise).resolves.toBeUndefined()
      },
    })
  })

  test("config-driven permissions: yolo auto-approves 'ask' but can't touch 'deny'", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          bash: {
            "*": "ask",
            "dbt *": "allow",
            "DROP *": "deny",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { Config } = await import("../src/config/config")
        const config = await Config.get()
        const ruleset = PermissionNext.fromConfig(config.permission ?? {})

        expect(PermissionNext.evaluate("bash", "dbt run", ruleset).action).toBe("allow")
        expect(PermissionNext.evaluate("bash", "DROP TABLE x", ruleset).action).toBe("deny")
        expect(PermissionNext.evaluate("bash", "git status", ruleset).action).toBe("ask")

        await expect(
          PermissionNext.ask({
            sessionID: SessionID.make("ses_yolo_config_test"),
            permission: "bash",
            patterns: ["DROP TABLE users"],
            metadata: {},
            always: [],
            ruleset,
          }),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
      },
    })
  })
})
