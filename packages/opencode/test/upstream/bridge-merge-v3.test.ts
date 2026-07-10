/**
 * Regression tests for the upstream bridge merge v1.4.0 (audit cycles 1, 2, 3).
 *
 * Each test corresponds to a bug that was fixed in a specific cycle. Re-introducing
 * the bug (most likely from another upstream merge) will fail the test BEFORE the
 * bad code can ship. See RESUME_BRIDGE_MERGE.md for the full bug catalog.
 *
 * Test categories:
 *   - cycle1/2/3: bug-specific regressions
 *   - sdk-bridge: SyncEvent.define → BusEvent.registry bridge (cycle 3)
 *   - hidden-bugs: bugs that @ts-nocheck was masking until cycle 3 surfaced them
 *   - dependency-pinning: version drift detection (cycle 2)
 *
 * These are static / source-level tests — fast, deterministic, no network. They
 * complement the runtime tests in bridge-merge.test.ts (24 tests) and
 * altimate-features.test.ts (42 tests).
 */
import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")
const srcDir = path.join(repoRoot, "packages", "opencode", "src")

async function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf-8")
}

async function walkSource(dir: string, exts = [".ts", ".tsx"]): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === ".turbo") continue
        await walk(full)
      } else if (exts.some((x) => e.name.endsWith(x))) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

// ---------------------------------------------------------------------------
// Cycle 1 — async drift on Account.active
// ---------------------------------------------------------------------------

describe("bridge merge cycle 1: Account.active() is async — every caller awaits it", () => {
  // Account.active() became async in upstream v1.4.0 (returns Promise<Info | undefined>).
  // Forgetting `await` returns a Promise object, which fails truthiness checks
  // silently and causes downstream `.id` access to be undefined.
  test("Account namespace exports `active` as an async function", async () => {
    const content = await readText(path.join(srcDir, "account", "index.ts"))
    expect(content).toMatch(/export\s+async\s+function\s+active\s*\(\s*\)\s*:\s*Promise<Info\s*\|\s*undefined>/)
  })

  test("share-next.ts awaits Account.active()", async () => {
    const content = await readText(path.join(srcDir, "share", "share-next.ts"))
    expect(content).toMatch(/await\s+Account\.active\s*\(\s*\)/)
    // Negative — bare call without await would re-introduce the bug.
    const lines = content.split("\n")
    for (const line of lines) {
      // skip comments and the type re-export
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue
      if (
        /Account\.active\s*\(/.test(line) &&
        !/await\s+Account\.active\s*\(/.test(line) &&
        !/=\s*Account\.active\b/.test(line)
      ) {
        throw new Error(`share-next.ts has a non-awaited Account.active() call: ${line}`)
      }
    }
  })

  test("config/config.ts reads the active account (via Effect Account.Service)", async () => {
    // v1.17.9 migrated config.ts to the Effect Service pattern: it resolves the
    // account through `Account.Service` and calls `accountSvc.active()` inside an
    // Effect.gen (no longer the legacy top-level `await Account.active()`). The
    // intent — config loads the active account's org config — is preserved.
    const content = await readText(path.join(srcDir, "config", "config.ts"))
    expect(content).toMatch(/yield\*\s+Account\.Service/)
    expect(content).toMatch(/accountSvc\.active\s*\(\s*\)/)
  })

  test("altimate/telemetry/index.ts awaits Account.active()", async () => {
    const content = await readText(path.join(srcDir, "altimate", "telemetry", "index.ts"))
    expect(content).toMatch(/await\s+Account\.active\s*\(\s*\)/)
  })

  test("no source file calls Account.active() without await or assignment", async () => {
    const files = await walkSource(srcDir)
    const violations: string[] = []
    for (const file of files) {
      const content = await readText(file)
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip comments and the type definition itself.
        if (line.trim().startsWith("//") || line.trim().startsWith("*") || line.trim().startsWith("/*")) continue
        if (file.endsWith(path.join("account", "index.ts"))) continue
        if (file.endsWith(path.join("test"))) continue
        const m = /Account\.active\s*\(/.exec(line)
        if (!m) continue
        // Permitted patterns: `await Account.active(`, `= Account.active`, `Account.active = ` (test mock)
        if (/await\s+Account\.active\s*\(/.test(line)) continue
        if (/=\s*Account\.active\b/.test(line)) continue
        if (/originalActive\s*=\s*Account\.active/.test(line)) continue
        violations.push(`${path.relative(repoRoot, file)}:${i + 1}: ${line.trim()}`)
      }
    }
    expect(violations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Cycle 1 — Symlink escape via Filesystem.contains
// ---------------------------------------------------------------------------

describe("bridge merge cycle 1: symlink escape — security-critical paths use containsReal", () => {
  // `Filesystem.contains` is lexical only and can be bypassed by symlinks pointing
  // outside the worktree. `Filesystem.containsReal` resolves real paths first.
  test("project/instance.ts uses Filesystem.containsReal (not contains)", async () => {
    const content = await readText(path.join(srcDir, "project", "instance.ts"))
    expect(content).toContain("Filesystem.containsReal")
    // Negative — must not have plain Filesystem.contains usage in this file.
    const lines = content.split("\n")
    for (const line of lines) {
      if (/Filesystem\.contains\b(?!Real)/.test(line) && !line.trim().startsWith("//")) {
        throw new Error(`project/instance.ts uses unsafe Filesystem.contains: ${line.trim()}`)
      }
    }
  })

  test("plugin/shared.ts uses Filesystem.containsReal (not contains)", async () => {
    const content = await readText(path.join(srcDir, "plugin", "shared.ts"))
    expect(content).toContain("Filesystem.containsReal")
    const lines = content.split("\n")
    for (const line of lines) {
      if (/Filesystem\.contains\b(?!Real)/.test(line) && !line.trim().startsWith("//")) {
        throw new Error(`plugin/shared.ts uses unsafe Filesystem.contains: ${line.trim()}`)
      }
    }
  })

  test("Filesystem.containsReal is exported and is symlink-aware", async () => {
    const content = await readText(path.join(srcDir, "util", "filesystem.ts"))
    expect(content).toMatch(/export\s+function\s+containsReal\s*\(/)
    expect(content).toContain("realpathSync")
    // The `..` segment guard from the cycle 1 hardening must remain.
    expect(content).toContain('segments.includes("..")')
  })
})

// ---------------------------------------------------------------------------
// Cycle 2 — XSS in HTML error templates
// ---------------------------------------------------------------------------

describe("bridge merge cycle 2: XSS — HTML error pages must escape interpolated text", () => {
  test("plugin/codex.ts HTML_ERROR uses escapeHtml around interpolated error", async () => {
    const content = await readText(path.join(srcDir, "plugin", "codex.ts"))
    expect(content).toMatch(/function\s+escapeHtml\s*\(/)
    // The key invariant: the ${error} interpolation must go through escapeHtml.
    expect(content).toContain("${escapeHtml(error)}")
    // Negative — must not interpolate raw error.
    expect(content).not.toMatch(/\$\{error\}(?![^"]*"\s*,\s*escapeHtml)/)
  })

  test("mcp/oauth-callback.ts HTML_ERROR uses escapeHtml around interpolated error", async () => {
    // v1.17.9 refactored the inline escapeHtml into a shared `@/util/html` helper.
    // The security invariant is unchanged: the ${error} interpolation must still
    // flow through escapeHtml (now imported rather than locally defined).
    const content = await readText(path.join(srcDir, "mcp", "oauth-callback.ts"))
    expect(content).toMatch(/escapeHtml/)
    expect(content).toContain("${escapeHtml(error)}")
    expect(content).not.toMatch(/\$\{error\}(?![^"]*"\s*,\s*escapeHtml)/)
  })

  test("escapeHtml covers <, >, &, \" and ' (codex inline + shared util)", async () => {
    // codex.ts keeps an inline escapeHtml; oauth-callback.ts imports the shared
    // `util/html.ts` helper. Verify the entity coverage at whichever site defines it.
    const escapingFiles = [path.join(srcDir, "plugin", "codex.ts"), path.join(srcDir, "util", "html.ts")]
    for (const file of escapingFiles) {
      const content = await readText(file)
      expect(content).toContain("&amp;")
      expect(content).toContain("&lt;")
      expect(content).toContain("&gt;")
      expect(content).toContain("&quot;")
      expect(content).toContain("&#39;")
    }
    // oauth-callback.ts must import the shared escaper (no raw error interpolation).
    const callback = await readText(path.join(srcDir, "mcp", "oauth-callback.ts"))
    expect(callback).toMatch(/import\s+\{\s*escapeHtml\s*\}\s+from\s+["']@\/util\/html["']/)
  })
})

// ---------------------------------------------------------------------------
// Cycle 2 — `mcp remove` command was deleted upstream; we restored it
// ---------------------------------------------------------------------------

describe("bridge merge cycle 2: `mcp remove` command restored", () => {
  test("McpRemoveCommand is exported from cli/cmd/mcp.ts", async () => {
    const content = await readText(path.join(srcDir, "cli", "cmd", "mcp.ts"))
    expect(content).toContain("export const McpRemoveCommand")
  })

  test("McpRemoveCommand has 'rm' alias and --global option", async () => {
    const content = await readText(path.join(srcDir, "cli", "cmd", "mcp.ts"))
    expect(content).toMatch(/aliases:\s*\[\s*["']rm["']\s*\]/)
    expect(content).toMatch(/option\(\s*["']global["']/)
  })

  test("McpCommand registers McpRemoveCommand as a subcommand", async () => {
    const content = await readText(path.join(srcDir, "cli", "cmd", "mcp.ts"))
    expect(content).toContain(".command(McpRemoveCommand)")
  })

  test("removeMcpFromConfig helper is imported and exported from mcp/config", async () => {
    const cmd = await readText(path.join(srcDir, "cli", "cmd", "mcp.ts"))
    expect(cmd).toMatch(/import\s+\{\s*removeMcpFromConfig\s*\}\s+from\s+["'][^"']*mcp\/config["']/)
    const cfg = await readText(path.join(srcDir, "mcp", "config.ts"))
    expect(cfg).toMatch(/export\s+(async\s+)?function\s+removeMcpFromConfig/)
  })
})

// ---------------------------------------------------------------------------
// Cycle 2 — v3 type drift: we stay on @ai-sdk/provider@2.0.1
// ---------------------------------------------------------------------------

describe("bridge merge cycle 2: ai-sdk v3 (v1.17.9 upgraded from v2)", () => {
  test("packages/opencode/package.json pins @ai-sdk/provider to 3.x", async () => {
    // v1.17.9 upgraded the ai-sdk family to v3 (LanguageModelV3 / specificationVersion v3).
    const pkg = JSON.parse(await readText(path.join(repoRoot, "packages", "opencode", "package.json")))
    const dep = pkg.dependencies?.["@ai-sdk/provider"] ?? pkg.devDependencies?.["@ai-sdk/provider"]
    expect(dep).toBeDefined()
    expect(dep.startsWith("3.") || dep.startsWith("^3.") || dep.startsWith("~3.")).toBe(true)
  })

  test("@ai-sdk/provider-utils resolves to 4.x (transitive in v3 stack)", async () => {
    // v3 of the ai-sdk family pulls provider-utils@4.x transitively (it is no longer
    // a direct opencode dependency). Verify the resolved version in the lockfile.
    const lock = await readText(path.join(repoRoot, "bun.lock"))
    expect(lock).toMatch(/"@ai-sdk\/provider-utils":\s*\[\s*"@ai-sdk\/provider-utils@4\./)
  })

  test("provider stack uses LanguageModelV3 (v1.17.9 moved off the V2 aliases)", async () => {
    // v1.17.9 moved the provider layer to the V3 model interface. provider.ts imports
    // `LanguageModelV3` (aliased locally to keep the rest of the file on the V2 name).
    const content = await readText(path.join(srcDir, "provider", "provider.ts"))
    expect(content).toMatch(/\bLanguageModelV3\b/)
  })

  test("no source file imports createProviderToolFactoryWithOutputSchema (v4 rename)", async () => {
    const files = await walkSource(srcDir)
    const violations: string[] = []
    for (const file of files) {
      const content = await readText(file)
      // The v4 name has no `Defined`. The v3 name we use is `createProviderDefinedToolFactoryWithOutputSchema`.
      if (/\bcreateProviderToolFactoryWithOutputSchema\b/.test(content)) {
        violations.push(path.relative(repoRoot, file))
      }
    }
    expect(violations).toEqual([])
  })

  test("copilot tool factories import from @ai-sdk/provider-utils with v3 names (createProviderDefined* family)", async () => {
    const dir = path.join(srcDir, "provider", "sdk", "copilot", "responses", "tool")
    if (!existsSync(dir)) return // nothing to check if the optional copilot SDK is gone
    const files = await walkSource(dir)
    expect(files.length).toBeGreaterThan(0)
    let factoryUseCount = 0
    for (const f of files) {
      const content = await readText(f)
      // Whatever factory we use, it must be the v3 `createProviderDefined…` family,
      // never v4's `createProviderTool…` rename.
      if (/from\s+["']@ai-sdk\/provider-utils["']/.test(content)) {
        if (/createProviderTool\w*\(/.test(content)) {
          throw new Error(
            `${path.relative(repoRoot, f)} uses v4 createProviderTool* (renamed) — should be createProviderDefined*`,
          )
        }
        if (/createProviderDefined\w*Factory/.test(content)) factoryUseCount++
      }
    }
    expect(factoryUseCount).toBeGreaterThan(0)
  })

  test("session/llm.ts middleware carries specificationVersion: 'v3'", async () => {
    // v1.17.9 moved to the ai-sdk v3 model interface; the wrapLanguageModel
    // middleware must declare specificationVersion: 'v3' to match.
    const content = await readText(path.join(srcDir, "session", "llm.ts"))
    expect(content).toMatch(/specificationVersion\s*:\s*["']v3["']/)
  })
})

// ---------------------------------------------------------------------------
// Cycle 2 — message-v2 toModelOutput / toModelMessages signature drift
// ---------------------------------------------------------------------------

describe("bridge merge cycle 2: MessageV2.toModelOutput / toModelMessages signatures", () => {
  test("toModelOutput takes raw `output: unknown` (not v1.4.0 options object)", async () => {
    const content = await readText(path.join(srcDir, "session", "message-v2.ts"))
    // v1.4.0 signature was: (options: { toolCallId; input; output })
    expect(content).toMatch(/const\s+toModelOutput\s*=\s*\(\s*output\s*:\s*unknown\s*\)\s*=>/)
    // Negative — guard against v1.4.0 signature creeping back.
    expect(content).not.toMatch(/toModelOutput\s*=\s*\(\s*\{\s*toolCallId/)
    expect(content).not.toMatch(/toModelOutput\s*=\s*\(\s*options\s*:\s*\{\s*toolCallId/)
  })

  test("convertToModelMessages is wrapped in Effect.promise (upstream made it async in v1.17.9)", async () => {
    // v1.17.9's `convertToModelMessages` returns Promise<ModelMessage[]>, so the
    // Effect wrapper must be Effect.promise (carrying the `// altimate_change`
    // marker). Effect.sync here would lose the resolved messages.
    const content = await readText(path.join(srcDir, "session", "message-v2.ts"))
    const lines = content.split("\n")
    let wrapperLine = -1
    for (let i = 0; i < lines.length; i++) {
      if (/Effect\.promise\s*\(\s*\(\)\s*=>/.test(lines[i])) {
        const block = lines.slice(i, i + 12).join("\n")
        if (/convertToModelMessages\s*\(/.test(block)) {
          wrapperLine = i
          break
        }
      }
    }
    expect(wrapperLine).toBeGreaterThan(-1)
  })

  test("UserMessage schema has top-level `variant` for cross-message propagation", async () => {
    const content = await readText(path.join(srcDir, "session", "message-v2.ts"))
    // The cycle 1 cleanup added top-level variant on UserMessage so assistants inherit it.
    // Verify both the model.variant and top-level variant.
    expect(content).toMatch(/variant:\s*z\.string\(\)\.optional\(\)/)
    // Should appear at least 3 times (model.variant on user, top-level on user, on assistant).
    const matches = content.match(/variant:\s*z\.string\(\)\.optional\(\)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// Cycle 2 — TUI compatibility (older opentui)
// ---------------------------------------------------------------------------

describe("bridge merge: TUI relocated to packages/tui (v1.17.9, opentui bumped)", () => {
  // v1.17.9 moved the TUI out of packages/opencode/src/cli/cmd/tui into the standalone
  // packages/tui workspace and bumped @opentui. The old cycle-2 workarounds for the
  // *previous* opentui version are now obsolete:
  //   - `msg.variant`/`event.text` reverts → modern opentui uses msg.model.variant / event.bytes
  //   - `(x as any).traits` cast → opentui now types `traits`
  //   - markdown `@ts-expect-error` on `fg` → opentui now types `fg`
  // These tests pin the relocation rather than the removed workarounds.
  const tuiSrc = path.join(repoRoot, "packages", "tui", "src")

  test("TUI moved to packages/tui (old packages/opencode/src/cli/cmd/tui is gone)", () => {
    expect(existsSync(path.join(srcDir, "cli", "cmd", "tui"))).toBe(false)
    expect(existsSync(path.join(tuiSrc, "component", "prompt", "index.tsx"))).toBe(true)
  })

  test("packages/tui prompt/index.tsx uses the modern opentui paste API", async () => {
    const content = await readText(path.join(tuiSrc, "component", "prompt", "index.tsx"))
    expect(content).toContain("PasteEvent")
    // Modern opentui exposes bytes on PasteEvent; the old event.text revert is gone.
    expect(content).toMatch(/event\.bytes/)
  })

  test("packages/tui session route renders markdown with a typed fg prop (no @ts-expect-error)", async () => {
    const content = await readText(path.join(tuiSrc, "routes", "session", "index.tsx"))
    // The <markdown> element accepts `fg` directly now (opentui types it), with no
    // ts-expect-error workaround. Match the element and its fg prop across newlines.
    expect(content).toMatch(/<markdown[\s\S]{0,400}\bfg=\{/)
    expect(content).not.toMatch(/@ts-expect-error[^\n]*fg/)
  })
})

// ---------------------------------------------------------------------------
// Cycle 2 — Effect package version pinning (ServiceMap vs Context)
// ---------------------------------------------------------------------------

describe("bridge merge: effect pinned to 4.0.0-beta.74 (v1.17.9, migrated off ServiceMap)", () => {
  // v1.17.9 bumped effect past the beta.43 pin. beta.58 removed ServiceMap, so the
  // merge migrated every service to `Context.Service`. The version now lives in the
  // workspace `catalog` (consumed via `catalog:`), not a top-level `overrides` pin.
  test("root package.json catalog pins effect + @effect/platform-node to 4.0.0-beta.74", async () => {
    const pkg = JSON.parse(await readText(path.join(repoRoot, "package.json")))
    const catalog = pkg.workspaces?.catalog ?? pkg.catalog ?? {}
    expect(catalog["effect"]).toBe("4.0.0-beta.74")
    expect(catalog["@effect/platform-node"]).toBe("4.0.0-beta.74")
  })

  test("services use Context.Service (ServiceMap was removed from effect in beta.58)", async () => {
    const files = await walkSource(srcDir)
    let contextServiceCount = 0
    for (const file of files) {
      const content = await readText(file)
      if (/\bContext\.Service\b/.test(content)) contextServiceCount++
      // The legacy `import { ServiceMap } from "effect"` must be gone.
      if (/import\s+\{[^}]*\bServiceMap\b[^}]*\}\s+from\s+["']effect["']/.test(content)) {
        throw new Error(`${path.relative(repoRoot, file)} still imports ServiceMap from "effect" (removed in beta.58)`)
      }
    }
    expect(contextServiceCount).toBeGreaterThan(15)
  })
})

// ---------------------------------------------------------------------------
// Cycle 3 — SDK versioned-event schema bridge (SyncEvent.define → BusEvent.registry)
// ---------------------------------------------------------------------------

describe("bridge merge cycle 3: SyncEvent.define also registers in BusEvent.registry", () => {
  test("SyncEvent.define calls BusEvent.define inside its body", async () => {
    const content = await readText(path.join(srcDir, "sync", "index.ts"))
    // The bridge: every SyncEvent.define must also register on BusEvent so that
    // BusEvent.payloads() (used by the SDK Event union) sees them.
    const defineFn = content.split("export function define")[1] ?? ""
    expect(defineFn).toContain("BusEvent.define")
    // The marker must remain so future merges don't strip it.
    expect(content).toContain("// altimate_change start")
    expect(content).toMatch(/altimate_change\s+start[^\n]*BusEvent registry|BusEvent\.payloads/)
  })

  test("SyncEvent.define imports BusEvent (so the bridge can call it)", async () => {
    const content = await readText(path.join(srcDir, "sync", "index.ts"))
    expect(content).toMatch(/import\s+\{[^}]*BusEvent[^}]*\}\s+from/)
  })

  test("generated SDK Event union includes EventMessageUpdated and EventSessionUpdated", async () => {
    // If the cycle 3 bridge is removed, regenerating the SDK drops these types and
    // consumers (TUI sync.tsx) silently break: the discriminator union no longer
    // matches.
    const content = await readText(path.join(repoRoot, "packages", "sdk", "js", "src", "v2", "gen", "types.gen.ts"))
    expect(content).toMatch(/export type EventMessageUpdated\s*=/)
    expect(content).toMatch(/export type EventSessionUpdated\s*=/)
    expect(content).toMatch(/export type EventMessageRemoved\s*=/)
    expect(content).toMatch(/export type EventMessagePartUpdated\s*=/)
    expect(content).toMatch(/export type EventMessagePartRemoved\s*=/)
    // The discriminated union must list them.
    const unionMatch = content.match(/export type Event\s*=([\s\S]*?)export type/)
    expect(unionMatch).not.toBeNull()
    const union = unionMatch![1]
    for (const t of [
      "EventMessageUpdated",
      "EventMessageRemoved",
      "EventMessagePartUpdated",
      "EventMessagePartRemoved",
      "EventSessionUpdated",
    ]) {
      if (!union.includes(t)) {
        throw new Error(`Generated SDK Event union missing ${t}`)
      }
    }
  })

  test("EventMessageUpdated has the unversioned shape ({type, properties})", async () => {
    // v1.4.0's SyncEvent system would produce versioned types like message.updated.1
    // with shape {type, aggregate, data}. Consumers expect the unversioned bus
    // shape: {type, properties: {sessionID, info}}. The cycle 3 bridge ensures
    // this by registering the unversioned name in BusEvent.
    const content = await readText(path.join(repoRoot, "packages", "sdk", "js", "src", "v2", "gen", "types.gen.ts"))
    const match = content.match(/export type EventMessageUpdated\s*=\s*\{([\s\S]*?)\n\}/)
    expect(match).not.toBeNull()
    const block = match![1]
    expect(block).toContain('type: "message.updated"')
    expect(block).toContain("properties")
    expect(block).toContain("sessionID")
    expect(block).toContain("info")
    // Negative — the versioned shape would use `data:` and `aggregate:`
    expect(block).not.toMatch(/aggregate:\s*["']sessionID["']/)
  })
})

// ---------------------------------------------------------------------------
// Cycle 3 — Hidden bugs the @ts-nocheck removal surfaced
// ---------------------------------------------------------------------------

describe("bridge merge cycle 3: hidden bugs surfaced by @ts-nocheck removal", () => {
  test("session/projectors.ts uses data.info.id (not data.sessionID) for Session.Event projectors", async () => {
    // BusEvent.define payloads for Session.Event.* are { info } only — `data.sessionID`
    // was always undefined, causing silent NotFoundError errors in event handling.
    const content = await readText(path.join(srcDir, "session", "projectors.ts"))

    // Slice the file from `Session.Event.Updated` to the start of the next
    // SyncEvent.project (or end of file). Same for Deleted. Robust against
    // the lazy-match-vs-nested-braces problem.
    function blockFor(label: string): string {
      const idx = content.indexOf(`Session.Event.${label}`)
      expect(idx).toBeGreaterThan(-1)
      const rest = content.slice(idx)
      const next = rest.search(/SyncEvent\.project\(Session\.Event\.|SyncEvent\.project\(MessageV2/g)
      // first match is itself (offset 0). Take the second match (real next block).
      const re = /SyncEvent\.project\(Session\.Event\.|SyncEvent\.project\(MessageV2/g
      let m: RegExpExecArray | null
      let secondStart = -1
      let count = 0
      while ((m = re.exec(rest)) !== null) {
        count++
        if (count === 2) {
          secondStart = m.index
          break
        }
      }
      void next
      return secondStart === -1 ? rest : rest.slice(0, secondStart)
    }

    const updatedBlock = blockFor("Updated")
    const deletedBlock = blockFor("Deleted")
    expect(updatedBlock).toContain("data.info.id")
    expect(deletedBlock).toContain("data.info.id")
    // Negative — neither block may reference data.sessionID directly.
    expect(updatedBlock).not.toMatch(/\bdata\.sessionID\b/)
    expect(deletedBlock).not.toMatch(/\bdata\.sessionID\b/)
  })

  test("server/projectors.ts session.updated convertEvent reads data.info.id (not data.sessionID)", async () => {
    const content = await readText(path.join(srcDir, "server", "projectors.ts"))
    const block = content.match(/session\.updated[\s\S]*?return\s+data[\s\S]*?\}/)
    expect(block).not.toBeNull()
    // The fix uses `info?.id`, never `data.sessionID`.
    expect(content).toContain("info?.id")
    expect(content).not.toMatch(/\bdata\.sessionID\b/)
  })

  test("server/routes/session.ts diff route makes messageID optional", async () => {
    const content = await readText(path.join(srcDir, "server", "routes", "session.ts"))
    // Find the diff route's query validator. The cycle 3 fix added .optional()
    // because SessionSummary.diff has it optional and bulk-sync callers don't pass it.
    const diffBlock = content.match(/\/diff[\s\S]*?validator\(\s*"query"[\s\S]*?\)\s*,/)
    expect(diffBlock).not.toBeNull()
    expect(diffBlock![0]).toMatch(/messageID:\s*MessageID\.zod\.optional\(\)/)
  })

  test("sync.tsx bulk diff fetch does not pass messageID (matches optional schema)", async () => {
    // Cycle 3 alignment — TUI bulk sync calls sdk.client.session.diff({ sessionID })
    // with no messageID. If a future merge re-requires messageID, this test fails.
    // v1.17.9 relocated sync.tsx from packages/opencode/src/cli/cmd/tui/context to
    // packages/tui/src/context; the call shape is unchanged.
    const content = await readText(path.join(repoRoot, "packages", "tui", "src", "context", "sync.tsx"))
    expect(content).toMatch(/sdk\.client\.session\.diff\(\s*\{\s*sessionID\s*\}\s*\)/)
  })
})

// ---------------------------------------------------------------------------
// Cycle 3 — provider/transform.ts tool-approval discriminator guards
// ---------------------------------------------------------------------------

describe("bridge merge cycle 3: provider/transform.ts tool-approval guards (v3-only parts)", () => {
  test("transform.ts no longer uses @ts-nocheck (replaced by localized casts)", async () => {
    const content = await readText(path.join(srcDir, "provider", "transform.ts"))
    expect(content.split("\n")[0]).not.toMatch(/@ts-nocheck/)
  })

  test("transform.ts guards both tool-approval-request and tool-approval-response discriminators", async () => {
    const content = await readText(path.join(srcDir, "provider", "transform.ts"))
    expect(content).toContain('"tool-approval-request"')
    expect(content).toContain('"tool-approval-response"')
    // Localized cast pattern — must remain to keep typecheck green without disabling the file.
    expect(content).toMatch(/as\s+\{\s*type\?\:\s*string\s*\}/)
  })
})

// ---------------------------------------------------------------------------
// Cycle 3 — npm/index.ts arborist module declaration
// ---------------------------------------------------------------------------

describe("bridge merge cycle 3: npm/index.ts uses local arborist.d.ts (no @ts-nocheck)", () => {
  test("arborist.d.ts module declaration exists alongside npm/index.ts", async () => {
    expect(existsSync(path.join(srcDir, "npm", "arborist.d.ts"))).toBe(true)
    const content = await readText(path.join(srcDir, "npm", "arborist.d.ts"))
    expect(content).toMatch(/declare\s+module\s+["']@npmcli\/arborist["']/)
  })

  test("npm/index.ts no longer carries @ts-nocheck", async () => {
    const content = await readText(path.join(srcDir, "npm", "index.ts"))
    expect(content.split("\n")[0]).not.toMatch(/@ts-nocheck/)
  })
})

// ---------------------------------------------------------------------------
// Cycle 3 — Dead-code deletions stay deleted
// ---------------------------------------------------------------------------

describe("bridge merge cycle 3: deleted dead-code files stay deleted", () => {
  test("tui/plugin/api.tsx is gone (was dead, referenced missing ./slots)", () => {
    expect(existsSync(path.join(srcDir, "cli", "cmd", "tui", "plugin", "api.tsx"))).toBe(false)
  })

  test("tui/plugin/runtime.ts is gone (was dead, referenced missing ./slots)", () => {
    expect(existsSync(path.join(srcDir, "cli", "cmd", "tui", "plugin", "runtime.ts"))).toBe(false)
  })

  test("storage/db.node.ts is gone (referenced unavailable drizzle-orm/node-sqlite)", () => {
    expect(existsSync(path.join(srcDir, "storage", "db.node.ts"))).toBe(false)
  })

  test("tui/component/dialog-console-org.tsx is gone (referenced SDK types not in our client)", () => {
    expect(existsSync(path.join(srcDir, "cli", "cmd", "tui", "component", "dialog-console-org.tsx"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SDK bridge runtime sanity — BusEvent.payloads() matches union expectations
// ---------------------------------------------------------------------------

describe("bridge merge cycle 3: BusEvent.payloads() runtime — every SyncEvent type appears", () => {
  test("every SyncEvent.define'd MessageV2.Event is registered in BusEvent.registry", async () => {
    // Import lazily so we don't pay startup cost on tests that don't need it.
    const { BusEvent } = await import("@/bus/bus-event")
    // Importing message-v2 triggers the SyncEvent.define side effects.
    const { MessageV2 } = await import("@/session/message-v2")

    // SyncEvent.define-backed events on MessageV2.Event:
    const expectedTypes = ["message.updated", "message.removed", "message.part.updated", "message.part.removed"]
    const union = BusEvent.payloads()
    // The discriminated union options carry the literal `type`. Walk the zod schema's
    // options to gather the registered type names.
    const types = new Set<string>()
    const opts = (union as any)._zod?.def?.options ?? (union as any).options ?? []
    for (const opt of opts) {
      const def = opt._zod?.def ?? opt.def ?? opt
      const shape = def.shape ?? def.shape?.()
      const typeField = shape?.type
      const literal = typeField?._zod?.def?.values?.[0] ?? typeField?._def?.value ?? typeField?.value
      if (typeof literal === "string") types.add(literal)
    }

    // Some zod internal layout differences across versions — fall back to the
    // BusEvent.registry contents directly if introspection didn't yield names.
    if (types.size === 0) {
      const registry = (BusEvent as any).registry as Map<string, unknown> | undefined
      if (registry) for (const k of registry.keys()) types.add(k)
    }

    // We accept that the registry might be empty if no module is loaded yet; force
    // by ensuring MessageV2.Event was imported (it triggers .define on import).
    expect(MessageV2.Event.Updated).toBeDefined()
    expect(MessageV2.Event.PartUpdated).toBeDefined()

    // If the bridge is intact, all expected types are present.
    for (const t of expectedTypes) {
      if (!types.has(t)) {
        throw new Error(
          `BusEvent.registry is missing "${t}" — SyncEvent.define→BusEvent.define bridge is broken (cycle 3 regression). Registered: ${[...types].join(", ")}`,
        )
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Repo-wide invariants from RESUME doc
// ---------------------------------------------------------------------------

describe("bridge merge: repo-wide invariants", () => {
  test("no source file has @ts-nocheck `DRAFT bridge merge` (cycle 3 brought count to 0)", async () => {
    const files = await walkSource(srcDir)
    const offenders: string[] = []
    for (const file of files) {
      const content = await readText(file)
      const head = content.split("\n").slice(0, 3).join("\n")
      if (/@ts-nocheck.*DRAFT bridge merge/.test(head)) {
        offenders.push(path.relative(repoRoot, file))
      }
    }
    expect(offenders).toEqual([])
  })

  test("no source file imports drizzle-orm/node-sqlite (cycle 2 deletion)", async () => {
    const files = await walkSource(srcDir)
    for (const file of files) {
      const content = await readText(file)
      if (/drizzle-orm\/node-sqlite/.test(content)) {
        throw new Error(`${path.relative(repoRoot, file)} imports drizzle-orm/node-sqlite (deleted in cycle 2)`)
      }
    }
  })

  test("provider.ts uses the LanguageModelV3 model interface (v1.17.9 ai-sdk v3)", async () => {
    const content = await readText(path.join(srcDir, "provider", "provider.ts"))
    // v1.17.9 moved to ai-sdk v3. provider.ts imports `LanguageModelV3`, aliasing it
    // locally to `LanguageModelV2` so the rest of the file keeps the shorter name.
    expect(content).toMatch(/\bLanguageModelV3\b/)
    expect(content).toMatch(/\bLanguageModelV2\b/)
  })
})

describe("bridge merge cycle 4: SessionStatus.set async drift", () => {
  test("SessionStatus.set is async (returns Promise)", async () => {
    const content = await readText(path.join(srcDir, "session", "status.ts"))
    expect(content).toMatch(/export\s+async\s+function\s+set\s*\(/)
  })

  test("all SessionStatus.set callers in src use await", async () => {
    const files = await walkSource(srcDir)
    const offenders: string[] = []
    for (const file of files) {
      const rel = path.relative(repoRoot, file)
      // Skip the definition file
      if (rel.endsWith("session/status.ts")) continue
      const content = await readText(file)
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Match SessionStatus.set( usage that isn't preceded by `await`, `void`, `.then`, or `.catch`
        if (/\bSessionStatus\.set\s*\(/.test(line)) {
          if (!/\b(await|void)\s+SessionStatus\.set/.test(line)) {
            // Allow if previous line ends with await on its own (multi-line call)
            const prev = lines[i - 1] ?? ""
            if (!/\bawait\s*$/.test(prev)) {
              offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
            }
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("SessionPrompt.cancel is async (returns Promise)", async () => {
    const content = await readText(path.join(srcDir, "session", "prompt.ts"))
    expect(content).toMatch(/export\s+async\s+function\s+cancel\s*\(/)
  })

  test("SessionPrompt.prompt uses `await using` for cancel disposer (not plain `using`)", async () => {
    const content = await readText(path.join(srcDir, "session", "prompt.ts"))
    // cancel() became async, so the defer disposer must be awaited or the cleanup
    // race-condition returns at function scope before idle state flushes.
    expect(content).toMatch(/await\s+using\s+_\s*=\s*defer\(\s*\(\s*\)\s*=>\s*cancel\s*\(/)
  })
})

describe("bridge merge cycle 4: PlanTool reject-on-cancel safety", () => {
  test("PlanExitTool rejects on anything other than explicit Yes (not just No)", async () => {
    const content = await readText(path.join(srcDir, "tool", "plan.ts"))
    // Strip block comments (the file has a commented-out PlanEnterTool with the old pattern)
    const active = content.replace(/\/\*[\s\S]*?\*\//g, "")
    // v1.4.0 changed `if (answer !== "Yes")` to `if (answer === "No")` — the latter
    // silently confirms on dialog cancel/dismiss/network drop. Cycle 4 reverted to
    // the safer "reject on anything but explicit Yes" semantic.
    expect(active).toMatch(/answer\s*!==\s*"Yes"\s*\)\s*throw\s+new\s+Question\.RejectedError/)
    expect(active).not.toMatch(/answer\s*===\s*"No"\s*\)\s*throw\s+new\s+Question\.RejectedError/)
  })
})

describe("bridge merge cycle 4: BusEvent.define idempotent registration", () => {
  test("BusEvent.define returns existing definition on repeat call (preserves first)", async () => {
    const { BusEvent } = await import("../../src/bus/bus-event")
    const z = (await import("zod")).default
    const type = "__test_idempotent_" + Math.random().toString(36).slice(2)
    const first: any = BusEvent.define(type, z.object({ a: z.string() }))
    const second: any = BusEvent.define(type, z.object({ b: z.number() }))
    // Idempotent: second call returns the first registration unchanged.
    expect(second).toBe(first)
  })
})

describe("bridge merge cycle 4: error path exit codes", () => {
  test("McpRemoveCommand sets process.exitCode = 1 on not-found (no swallowed exit())", async () => {
    const content = await readText(path.join(srcDir, "cli", "cmd", "mcp.ts"))
    // The remove handler uses process.exitCode (which `process.exit()` in the
    // global finally honors) instead of process.exit(1) directly — process.exit
    // inside async Effect runtime gets swallowed.
    expect(content).toMatch(/process\.exitCode\s*=\s*1[\s\S]{0,30}return/)
    // No bare process.exit(1) in the McpRemoveCommand block
    const removeBlockMatch = content.match(/McpRemoveCommand[\s\S]{0,3000}\/\/\s*altimate_change end/)
    expect(removeBlockMatch).not.toBeNull()
    expect(removeBlockMatch![0]).not.toMatch(/process\.exit\(\s*1\s*\)/)
  })
})

describe("bridge merge cycle 5: SyncEvent immediate transaction", () => {
  test("Database.transaction accepts behavior option", async () => {
    const content = await readText(path.join(srcDir, "storage", "db.ts"))
    // Cycle 5 added the TransactionConfig pass-through so SyncEvent.run can request
    // SQLite IMMEDIATE mode. Without this, the comment "this is an immediate transaction
    // which is critical" in sync/index.ts would be a lie — race condition on concurrent
    // event sequence reads/writes.
    expect(content).toMatch(/TransactionConfig\s*=\s*\{\s*behavior\?:/)
    expect(content).toMatch(/transaction<T>\(callback:.*config\?:\s*TransactionConfig/)
  })

  test("SyncEvent.run requests behavior:immediate transaction", async () => {
    const content = await readText(path.join(srcDir, "sync", "index.ts"))
    // Strip block comments to ensure the assertion targets active code
    const active = content.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(active).toMatch(/Database\.transaction\(\s*\([\s\S]{50,800}\{\s*behavior:\s*"immediate"\s*\},?\s*\)/)
  })
})

describe("bridge merge cycle 5: Account/Auth Service identifier deduplication", () => {
  test("account/service.ts is deleted (was duplicate Service registration)", async () => {
    // service.ts duplicated `@opencode/Account` identifier with index.ts's Service.
    // Its only consumer was effect/runtime.ts (also dead code). Both removed in cycle 5.
    const exists = await Bun.file(path.join(srcDir, "account", "service.ts")).exists()
    expect(exists).toBe(false)
  })

  test("account/index.ts uses distinct Service identifier from account/account.ts", async () => {
    // v1.17.9 reintroduced a live account/account.ts service while index.ts still
    // serves the promise facade used by share/telemetry. Keep the identifiers distinct.
    const indexContent = await readText(path.join(srcDir, "account", "index.ts"))
    expect(indexContent).toMatch(/Context\.Service<Service, Interface>\(\)\("@opencode\/Account\.cli"\)/)
    const accountContent = await readText(path.join(srcDir, "account", "account.ts"))
    expect(accountContent).toMatch(/Context\.Service<Service, Interface>\(\)\("@opencode\/Account"\)/)
  })

  test("effect/runtime.ts is deleted (was orphaned)", async () => {
    const exists = await Bun.file(path.join(srcDir, "effect", "runtime.ts")).exists()
    expect(exists).toBe(false)
  })

  test("auth/index.ts uses distinct Service identifier from auth/service.ts", async () => {
    // Both files define a Service; cycle 5 renamed the index.ts one to `@opencode/Auth.cli`
    // so a future Layer.mergeAll cannot silently overwrite. v1.17.9 migrated the API from
    // `ServiceMap.Service` to `Context.Service`; the distinct identifiers are preserved.
    const content = await readText(path.join(srcDir, "auth", "index.ts"))
    expect(content).toMatch(/Context\.Service<Service, Interface>\(\)\("@opencode\/Auth\.cli"\)/)
    // auth/service.ts keeps `@opencode/Auth`
    const serviceContent = await readText(path.join(srcDir, "auth", "service.ts"))
    expect(serviceContent).toMatch(/Context\.Service<AuthService[^)]+\)\("@opencode\/Auth"\)/)
  })
})
