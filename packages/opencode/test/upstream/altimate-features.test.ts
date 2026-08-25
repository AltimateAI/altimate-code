/**
 * Behavioral smoke tests for altimate-specific features that survived the
 * v1.4.0 upstream bridge merge.
 *
 * Unlike `bridge-merge.test.ts` (which checks file presence, marker integrity,
 * and branding), this suite either:
 *
 *   1. Runs the actual code path for modules that are importable in the
 *      current bridge-merge branch state, OR
 *   2. Asserts source-level invariants for modules whose import chain is
 *      currently broken by missing transitive deps (cross-spawn,
 *      @effect/platform-node). Source-level assertions still catch real
 *      regressions during future merges — they catch any patch that drops
 *      the wiring entirely.
 *
 * Coverage areas:
 *   - Filesystem.statAsync (added) and containsReal (security-critical)
 *   - Flag declarations added during bridge merge
 *   - errorMessage fallback behavior
 *   - Wildcard-driven safety denial logic on builder agent
 *   - Source invariants for Agent build/builder alias, Anthropic provider,
 *     Skill cache invalidation hook, OAuth callback HTML escaping, Config
 *     plugin helpers, UserMessage.variant, Account.active being async
 *
 * All tests must pass deterministically — no env vars, no network, no clock.
 */
import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../../src/util/filesystem"
import { Flag } from "../../src/flag/flag"
import { errorMessage } from "../../src/util/error"
import { Wildcard } from "../../src/util/wildcard"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")
const srcDir = path.join(repoRoot, "packages", "opencode", "src")

async function readSrc(...rel: string[]): Promise<string> {
  return fs.readFile(path.join(srcDir, ...rel), "utf-8")
}

// Reimplement PermissionNext.evaluate logic (which is just last-wildcard-match-wins
// over Wildcard.match) so we can test agent safety denials WITHOUT importing
// the broken Permission module. If anyone changes `evaluate`'s semantics in
// next.ts this test won't track that — but the agent-level tests in
// test/agent/agent.test.ts already pin the semantics. This file's job is to
// guard the rule data (which the bridge merge could silently drop).
type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }
function evaluate(permission: string, pattern: string, ruleset: Rule[]): Rule {
  const match = ruleset.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}

// The bash + sql_execute_write safety denials are appended as a final ruleset
// in agent.ts (after user config) so they always win. We mirror those rules
// here so we can verify the WIRING stays intact even when the agent-level
// import chain is broken by an in-progress bridge merge.
const SAFETY_BASH: Rule[] = [
  { permission: "bash", pattern: "DROP DATABASE *", action: "deny" },
  { permission: "bash", pattern: "DROP SCHEMA *", action: "deny" },
  { permission: "bash", pattern: "TRUNCATE *", action: "deny" },
  { permission: "bash", pattern: "drop database *", action: "deny" },
  { permission: "bash", pattern: "drop schema *", action: "deny" },
  { permission: "bash", pattern: "truncate *", action: "deny" },
]
const SAFETY_SQL: Rule[] = [
  { permission: "sql_execute_write", pattern: "DROP DATABASE *", action: "deny" },
  { permission: "sql_execute_write", pattern: "DROP SCHEMA *", action: "deny" },
  { permission: "sql_execute_write", pattern: "TRUNCATE *", action: "deny" },
  { permission: "sql_execute_write", pattern: "drop database *", action: "deny" },
  { permission: "sql_execute_write", pattern: "drop schema *", action: "deny" },
  { permission: "sql_execute_write", pattern: "truncate *", action: "deny" },
]

// ===========================================================================
// 1. Filesystem.statAsync (added) + containsReal (security-critical)
// ===========================================================================
describe("altimate features: Filesystem.statAsync + containsReal", () => {
  test("statAsync returns a stat object for an existing file", async () => {
    const s = await Filesystem.statAsync(import.meta.path)
    expect(s).toBeDefined()
    expect(s!.isFile()).toBe(true)
    expect(typeof s!.size).toBe("number")
  })

  test("statAsync returns undefined for a non-existent path (does NOT throw)", async () => {
    const s = await Filesystem.statAsync("/nonexistent/path/__definitely_not_real__")
    expect(s).toBeUndefined()
  })

  test("containsReal returns true when child is inside parent", async () => {
    const tmp = await fs.mkdtemp(path.join(await fs.realpath((await import("os")).tmpdir()), "altimate-fs-"))
    try {
      const child = path.join(tmp, "subdir", "file.txt")
      await fs.mkdir(path.dirname(child), { recursive: true })
      await fs.writeFile(child, "hello")
      expect(Filesystem.containsReal(tmp, child)).toBe(true)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  test("containsReal returns false when child is OUTSIDE parent", async () => {
    const tmp = await fs.mkdtemp(path.join(await fs.realpath((await import("os")).tmpdir()), "altimate-fs-"))
    try {
      expect(Filesystem.containsReal(tmp, "/etc/passwd")).toBe(false)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  test("containsReal rejects path-traversal attempts using ..", async () => {
    const tmp = await fs.mkdtemp(path.join(await fs.realpath((await import("os")).tmpdir()), "altimate-fs-"))
    try {
      const sneaky = path.join(tmp, "subdir", "..", "..", "etc", "passwd")
      expect(Filesystem.containsReal(tmp, sneaky)).toBe(false)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})

// ===========================================================================
// 2. Flag declarations added during bridge merge
// ===========================================================================
describe("altimate features: Flag declarations added in bridge merge", () => {
  // These flags are referenced by upstream-merged code (oltp.ts, heap.ts,
  // plugin/meta.ts, server/instance.ts). Removing them would crash v1.4.0
  // callers.

  test("OTEL_EXPORTER_OTLP_ENDPOINT is undefined when env not set", () => {
    const prev = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
    delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
    try {
      expect(Flag.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = prev
    }
  })

  test("OTEL_EXPORTER_OTLP_HEADERS is undefined when env not set", () => {
    const prev = process.env["OTEL_EXPORTER_OTLP_HEADERS"]
    delete process.env["OTEL_EXPORTER_OTLP_HEADERS"]
    try {
      expect(Flag.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env["OTEL_EXPORTER_OTLP_HEADERS"] = prev
    }
  })

  test("OPENCODE_PURE is false when env not set, true when set to 'true' or '1'", () => {
    const prev = process.env["OPENCODE_PURE"]
    delete process.env["OPENCODE_PURE"]
    try {
      expect(Flag.OPENCODE_PURE).toBe(false)
      process.env["OPENCODE_PURE"] = "true"
      expect(Flag.OPENCODE_PURE).toBe(true)
      process.env["OPENCODE_PURE"] = "1"
      expect(Flag.OPENCODE_PURE).toBe(true)
      process.env["OPENCODE_PURE"] = "false"
      expect(Flag.OPENCODE_PURE).toBe(false)
      process.env["OPENCODE_PURE"] = ""
      expect(Flag.OPENCODE_PURE).toBe(false)
    } finally {
      if (prev === undefined) delete process.env["OPENCODE_PURE"]
      else process.env["OPENCODE_PURE"] = prev
    }
  })

  test("OPENCODE_AUTO_HEAP_SNAPSHOT defaults to false", () => {
    const prev = process.env["OPENCODE_AUTO_HEAP_SNAPSHOT"]
    delete process.env["OPENCODE_AUTO_HEAP_SNAPSHOT"]
    try {
      expect(Flag.OPENCODE_AUTO_HEAP_SNAPSHOT).toBe(false)
    } finally {
      if (prev !== undefined) process.env["OPENCODE_AUTO_HEAP_SNAPSHOT"] = prev
    }
  })

  test("OPENCODE_DISABLE_EMBEDDED_WEB_UI defaults to false", () => {
    const prev = process.env["OPENCODE_DISABLE_EMBEDDED_WEB_UI"]
    delete process.env["OPENCODE_DISABLE_EMBEDDED_WEB_UI"]
    try {
      expect(Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI).toBe(false)
    } finally {
      if (prev !== undefined) process.env["OPENCODE_DISABLE_EMBEDDED_WEB_UI"] = prev
    }
  })

  test("OPENCODE_PLUGIN_META_FILE reads env at access time", () => {
    const prev = process.env["OPENCODE_PLUGIN_META_FILE"]
    delete process.env["OPENCODE_PLUGIN_META_FILE"]
    try {
      expect(Flag.OPENCODE_PLUGIN_META_FILE).toBeUndefined()
      process.env["OPENCODE_PLUGIN_META_FILE"] = "/tmp/x.json"
      expect(Flag.OPENCODE_PLUGIN_META_FILE).toBe("/tmp/x.json")
    } finally {
      if (prev === undefined) delete process.env["OPENCODE_PLUGIN_META_FILE"]
      else process.env["OPENCODE_PLUGIN_META_FILE"] = prev
    }
  })
})

// ===========================================================================
// 3. errorMessage fallback behavior
// ===========================================================================
describe("altimate features: errorMessage fallback behavior", () => {
  test("errorMessage(new Error()) (no message) returns descriptive string, not bare 'Error'", () => {
    const msg = errorMessage(new Error())
    // Either a stack-derived hint or "Empty error" — never just the bare name.
    expect(msg.length).toBeGreaterThan(5)
    expect(msg).not.toBe("Error")
  })

  test("errorMessage(new Error('boom')) returns the message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
  })

  test("errorMessage(null) returns a usable fallback (not '[object Object]')", () => {
    const msg = errorMessage(null)
    expect(typeof msg).toBe("string")
    expect(msg.length).toBeGreaterThan(0)
    expect(msg).not.toBe("[object Object]")
  })

  test("errorMessage(undefined) returns a usable fallback", () => {
    const msg = errorMessage(undefined)
    expect(typeof msg).toBe("string")
    expect(msg.length).toBeGreaterThan(0)
  })

  test("errorMessage({ message: 'oops' }) extracts the string message", () => {
    expect(errorMessage({ message: "oops" })).toBe("oops")
  })
})

// ===========================================================================
// 4. Builder/analyst agent safety denials (data-level invariants on agent.ts)
// ===========================================================================
//
// We can't import the Agent module in this branch state, so we verify the
// safety rules are PRESENT in agent.ts source AND that the underlying
// matcher (Wildcard.match) actually denies destructive bash and SQL even
// when wildcard-allowed by user config.
describe("altimate features: agent safety denial wiring", () => {
  test("agent.ts source declares sql_execute_write safety denials block (added by bridge)", async () => {
    const src = await readSrc("agent", "agent.ts")
    // The exact safetyDenials block that must survive the merge.
    expect(src).toContain("sql_execute_write:")
    expect(src).toMatch(/"DROP DATABASE \*"\s*:\s*"deny"/)
    expect(src).toMatch(/"TRUNCATE \*"\s*:\s*"deny"/)
    // Both the bash AND sql_execute_write categories must be wired in.
    const sqlBlock = src.slice(src.indexOf("sql_execute_write:"))
    expect(sqlBlock).toMatch(/"DROP DATABASE \*"\s*:\s*"deny"/)
  })

  test("agent.ts source has 'build' alias resolving to 'builder'", async () => {
    const src = await readSrc("agent", "agent.ts")
    expect(src).toMatch(/agent === ["']build["']/)
    // v1.17.9 merge refactored agent lookup into Effect.fnUntraced; the local
    // map variable is `agents` (was `x`). The alias must still resolve to the
    // 'builder' entry — match either the current `agents["builder"]` form or
    // the legacy `x["builder"]`/`x.builder`.
    expect(src).toMatch(/agents\["builder"\]|agents\.builder|x\["builder"\]|x\.builder/)
  })

  test("agent.ts source registers 'builder' (NOT 'build') as the canonical primary agent", async () => {
    const src = await readSrc("agent", "agent.ts")
    // The result map key must be 'builder', not 'build' — otherwise the
    // alias indirection in get() loops onto a missing key.
    expect(src).toMatch(/^\s+builder:\s*\{/m)
    expect(src).not.toMatch(/^\s+build:\s*\{/m)
  })

  test("agent.ts source still includes 'analyst' agent definition", async () => {
    const src = await readSrc("agent", "agent.ts")
    expect(src).toMatch(/^\s+analyst:\s*\{/m)
  })

  test("Wildcard-driven evaluate denies 'DROP DATABASE foo' on the safety-bash ruleset", () => {
    const result = evaluate("bash", "DROP DATABASE foo", SAFETY_BASH)
    expect(result.action).toBe("deny")
  })

  test("Wildcard-driven evaluate denies 'TRUNCATE x' on the safety-sql ruleset", () => {
    const result = evaluate("sql_execute_write", "TRUNCATE x", SAFETY_SQL)
    expect(result.action).toBe("deny")
  })

  test("Wildcard-driven evaluate: even after a wildcard 'allow', the safety deny wins via last-match", () => {
    // Mimic what agent.ts does: user config first, then safety denials appended last.
    const userAllow: Rule[] = [{ permission: "bash", pattern: "*", action: "allow" }]
    const merged = [...userAllow, ...SAFETY_BASH]
    expect(evaluate("bash", "DROP DATABASE prod", merged).action).toBe("deny")
    // Non-destructive bash still allowed
    expect(evaluate("bash", "ls -la", merged).action).toBe("allow")
  })
})

// ===========================================================================
// 5. Anthropic provider survives the bridge (PR #18186 reverted)
// ===========================================================================
describe("altimate features: anthropic provider stays bundled", () => {
  test("provider.ts wires createAnthropic into BUNDLED_PROVIDERS (npm key → factory)", async () => {
    const src = await readSrc("provider", "provider.ts")
    expect(src).toMatch(/"@ai-sdk\/anthropic"\s*:\s*createAnthropic/)
  })

  test("anthropic-beta header includes claude-code-20250219", async () => {
    const src = await readSrc("provider", "provider.ts")
    expect(src).toContain("claude-code-20250219")
  })

  test("provider.ts wires altimate-specific snowflake-cortex and databricks loaders", async () => {
    const src = await readSrc("provider", "provider.ts")
    expect(src).toContain('"snowflake-cortex":')
    expect(src).toContain("databricks:")
  })

  test("plugin/index.ts has BUILTIN list with opencode-anthropic-auth", async () => {
    const src = await readSrc("plugin", "index.ts")
    expect(src).toContain("BUILTIN")
    expect(src).toContain("opencode-anthropic-auth")
  })
})

// ===========================================================================
// 6. Config: pluginSpecifier / pluginOptions helpers (added during bridge)
// ===========================================================================
//
// We can't directly import Config (the chain is broken). But we can verify
// the helpers exist and their bodies are the trivially-correct one-liners
// they need to be.
// v1.17.9 merge re-homed these helpers from config/config.ts into the dedicated
// config/plugin.ts module, and moved the spec type into core's V1 config
// namespace (ConfigPluginV1.Spec, defined in @opencode-ai/core/v1/config/plugin
// as `string | [string, Options]`). The fork bodies (array-or-string /
// array-or-undefined) survive unchanged — only their home and type-name moved.
describe("altimate features: Config plugin helpers added in bridge", () => {
  test("config/plugin.ts exports pluginSpecifier with the array-or-string body", async () => {
    const src = await readSrc("config", "plugin.ts")
    expect(src).toMatch(/export function pluginSpecifier\(plugin: ConfigPluginV1\.Spec\): string/)
    expect(src).toMatch(/Array\.isArray\(plugin\)\s*\?\s*plugin\[0\]\s*:\s*plugin/)
  })

  test("config/plugin.ts exports pluginOptions with the array-or-undefined body", async () => {
    const src = await readSrc("config", "plugin.ts")
    expect(src).toMatch(/export function pluginOptions\(plugin: ConfigPluginV1\.Spec\)/)
    expect(src).toMatch(/Array\.isArray\(plugin\)\s*\?\s*plugin\[1\]\s*:\s*undefined/)
  })

  test("core V1 config declares the plugin Spec type as string | [string, Options]", async () => {
    const src = await fs.readFile(
      path.join(repoRoot, "packages", "core", "src", "v1", "config", "plugin.ts"),
      "utf-8",
    )
    // Schema.Union of a bare string and a [string, Options] tuple — the
    // structural equivalent of the old `string | [string, PluginOptions]`.
    expect(src).toMatch(/export const Spec\s*=\s*Schema\.Union\(\[\s*Schema\.String\s*,/)
    expect(src).toMatch(/Schema\.Tuple\(\[Schema\.String,\s*Options\]\)/)
  })
})

// ===========================================================================
// 7. Skill cache invalidation hook (added by altimate)
// ===========================================================================
describe("altimate features: Skill.invalidate cache hook", () => {
  test("skill.ts source defines and exports Skill.invalidate", async () => {
    const src = await readSrc("skill", "skill.ts")
    expect(src).toMatch(/export function invalidate\s*\(\s*\)/)
    // The invalidate function calls State.invalidate against the stateInit fn
    expect(src).toMatch(/State\.invalidate/)
  })

  test("server.ts calls Skill.invalidate on the server invalidate path", async () => {
    const src = await readSrc("server", "server.ts")
    expect(src).toContain("Skill.invalidate()")
  })
})

// ===========================================================================
// 8. SystemPrompt.skills() output is sorted alphabetically (altimate change)
// ===========================================================================
describe("altimate features: SystemPrompt.skills sorting", () => {
  test("system.ts sorts the filtered skill list by code point, not by locale", async () => {
    const src = await readSrc("session", "system.ts")
    // The sort must survive an upstream merge, and it must stay LOCALE-INDEPENDENT.
    // `localeCompare` without an explicit locale follows the runtime's LANG/ICU data, so two
    // machines emit the skills block in a different order — and this block sits near the head of
    // the system prompt, where an exact-prefix cache stops at the first differing byte. This
    // guard used to pin the literal `localeCompare` line it was written against; it now pins the
    // property, so a future rewrite is free as long as ordering stays machine-independent.
    expect(src).toMatch(/filtered\s*=\s*\[\.\.\.filtered\]\.sort\(byCodePoints\(/)
    expect(src).not.toMatch(/sort\(\(a, b\)\s*=>\s*a\.name\.localeCompare\(b\.name\)\)/)
  })
})

// ===========================================================================
// 9. Telemetry stays fail-safe outside Instance context
// ===========================================================================
describe("altimate features: telemetry fail-safe init", () => {
  test("telemetry/index.ts catches Config.get() failures so init never throws", async () => {
    const src = await readSrc("altimate", "telemetry", "index.ts")
    // The try/catch around Config.get() — must be present so init() can be
    // called from CLI middleware before Instance.provide().
    expect(src).toMatch(/try\s*\{\s*const userConfig = \(await Config\.get\(\)\)/)
    // The ALTIMATE_TELEMETRY_DISABLED env var escape hatch.
    expect(src).toContain("ALTIMATE_TELEMETRY_DISABLED")
  })

  test("telemetry/index.ts awaits Account.active() (now async after bridge)", async () => {
    const src = await readSrc("altimate", "telemetry", "index.ts")
    // bridge merge note: Account.active() became async in v1.4.0
    expect(src).toMatch(/await Account\.active\(\)/)
  })
})

// ===========================================================================
// 10. Account.active is async (callers were sync in upstream)
// ===========================================================================
describe("altimate features: Account.active returns Promise", () => {
  test("account/index.ts declares active() with a Promise return type", async () => {
    const src = await readSrc("account", "index.ts")
    // The exported active() function must return Promise<Info | undefined>
    // so all callers that `await` it work.
    expect(src).toMatch(/export async function active\(\)\s*:\s*Promise<Info\s*\|\s*undefined>/)
  })
})

// ===========================================================================
// 11. OAuth callback HTML escaping (security)
// ===========================================================================
// v1.17.9 merge extracted the inline escapeHtml helper out of oauth-callback.ts
// into a shared util (src/util/html.ts). The XSS protection is unchanged:
// oauth-callback.ts imports escapeHtml and still wraps every interpolated error
// with it. We verify the full chain — the util defines the escaping, and the
// callback imports + uses it.
describe("altimate features: OAuth callback HTML escapes user-controllable error", () => {
  test("escapeHtml is defined (shared util) and imported by oauth-callback.ts", async () => {
    const callback = await readSrc("mcp", "oauth-callback.ts")
    // Must pull escapeHtml in from the shared html util.
    expect(callback).toMatch(/import\s*\{\s*escapeHtml\s*\}\s*from\s*["']@\/util\/html["']/)
    const util = await readSrc("util", "html.ts")
    expect(util).toMatch(/export function escapeHtml/)
  })

  test("escapeHtml replaces &, <, >, \", ' with HTML entities", async () => {
    const src = await readSrc("util", "html.ts")
    // All five entity replacements must be present in the body.
    expect(src).toContain("&amp;")
    expect(src).toContain("&lt;")
    expect(src).toContain("&gt;")
    expect(src).toContain("&quot;")
    expect(src).toContain("&#39;")
  })

  test("HTML_ERROR template wraps the error string with escapeHtml(error)", async () => {
    const src = await readSrc("mcp", "oauth-callback.ts")
    expect(src).toMatch(/escapeHtml\(error\)/)
  })

  test("HTML_SUCCESS title uses 'Altimate Code', not 'OpenCode'", async () => {
    const src = await readSrc("mcp", "oauth-callback.ts")
    expect(src).toContain("Altimate Code - Authorization Successful")
    expect(src).not.toMatch(/OpenCode\s*-\s*Authorization Successful/)
  })
})

// ===========================================================================
// 12. UserMessage.variant top-level field (mirrors Assistant.variant)
// ===========================================================================
describe("altimate features: UserMessage.variant top-level field", () => {
  test("message-v2.ts defines top-level variant on the User schema", async () => {
    const src = await readSrc("session", "message-v2.ts")
    // The User block has the top-level variant we added — different from the
    // model.variant field that exists on both User and Assistant.
    // Search by the comment marker to scope to the right block.
    expect(src).toContain("// altimate_change start — top-level variant mirrors Assistant.variant")
    // Right after the comment, an optional string variant field.
    const block = src.slice(src.indexOf("// altimate_change start — top-level variant mirrors Assistant.variant"))
    expect(block).toMatch(/variant:\s*z\.string\(\)\.optional\(\)/)
  })
})

// ===========================================================================
// 13. Plugin BUILTIN list and INTERNAL_PLUGINS still wires altimate plugins
// ===========================================================================
describe("altimate features: plugin/index.ts wiring", () => {
  test("plugin/index.ts INTERNAL_PLUGINS includes Snowflake, Databricks, AltimateAuth", async () => {
    const src = await readSrc("plugin", "index.ts")
    expect(src).toContain("SnowflakeCortexAuthPlugin")
    expect(src).toContain("DatabricksAuthPlugin")
    expect(src).toContain("AltimateAuthPlugin")
    // All three must show up in the INTERNAL_PLUGINS array.
    const arrIdx = src.indexOf("INTERNAL_PLUGINS")
    expect(arrIdx).toBeGreaterThan(-1)
    const arrBlock = src.slice(arrIdx, arrIdx + 500)
    expect(arrBlock).toContain("SnowflakeCortexAuthPlugin")
    expect(arrBlock).toContain("DatabricksAuthPlugin")
    expect(arrBlock).toContain("AltimateAuthPlugin")
  })
})
