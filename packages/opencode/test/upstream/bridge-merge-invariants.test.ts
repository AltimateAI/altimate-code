/**
 * Future-proof invariant tests for the upstream bridge merge.
 *
 * These differ from the cycle 1-5 regression tests in `bridge-merge-v3.test.ts`:
 * those tests assert "the cycle N bug is not back". The tests in THIS file
 * assert TRUTHS that should always hold across any future upstream merge —
 * cross-module consistency, async signature uniformity, schema agreement, and
 * build-infrastructure pinning.
 *
 * If any test fails after a future merge, it means the merge has silently
 * broken a structural invariant, even if all explicit cycle-N regressions
 * still pass.
 *
 * Constraints: static-only or in-process; no network, no real DB, no services.
 */
import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs/promises"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")
const srcDir = path.join(repoRoot, "packages", "opencode", "src")

async function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf-8")
}

async function walkSource(dir: string, exts = [".ts", ".tsx"]): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
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

/** Strip line and block comments so assertions only see active code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

// ---------------------------------------------------------------------------
// Cross-module consistency: ServiceMap.Service identifier uniqueness
// ---------------------------------------------------------------------------

describe("invariant: ServiceMap.Service identifier strings are globally unique", () => {
  // Cycle 5 surfaced a duplicate "@opencode/Account" identifier that allowed two
  // unrelated Service classes to silently share one Effect Layer slot. Any future
  // upstream merge that re-introduces this collision (by importing a duplicate
  // Service or moving identifiers around) must fail this test.
  test("no two ServiceMap.Service classes share the same identifier string", async () => {
    const files = await walkSource(srcDir)
    const occurrences = new Map<string, string[]>()
    const re = /ServiceMap\.Service<[^>]+>\(\)\(\s*"([^"]+)"\s*\)/g
    for (const file of files) {
      const content = stripComments(await readText(file))
      let m: RegExpExecArray | null
      while ((m = re.exec(content)) !== null) {
        const id = m[1]
        const arr = occurrences.get(id) ?? []
        arr.push(path.relative(repoRoot, file))
        occurrences.set(id, arr)
      }
    }
    const duplicates: string[] = []
    for (const [id, locs] of occurrences) {
      if (locs.length > 1) {
        duplicates.push(`"${id}" registered ${locs.length}x: ${locs.join(", ")}`)
      }
    }
    expect(duplicates).toEqual([])
  })

  test("at least one Service is registered (sanity — regex didn't silently break)", async () => {
    const files = await walkSource(srcDir)
    let count = 0
    const re = /ServiceMap\.Service<[^>]+>\(\)\(\s*"([^"]+)"\s*\)/g
    for (const file of files) {
      const content = stripComments(await readText(file))
      while (re.exec(content) !== null) count++
    }
    expect(count).toBeGreaterThanOrEqual(15)
  })
})

// ---------------------------------------------------------------------------
// Cross-module consistency: SyncEvent ⊆ BusEvent (cycle 3 bridge)
// ---------------------------------------------------------------------------

describe("invariant: every SyncEvent.define-d event also appears in BusEvent.registry", () => {
  // The cycle 3 bridge inserts BusEvent.define(def.type, ...) inside SyncEvent.define
  // and inside SyncEvent.init. If a future upstream merge removes either, SDK
  // consumers (TUI sync.tsx, CLI run.ts, ACP agent.ts) will silently break: the
  // BusEvent.payloads() Event union no longer includes message.updated / etc.
  test("SyncEvent.define body calls BusEvent.define with the unversioned type", async () => {
    const content = await readText(path.join(srcDir, "sync", "index.ts"))
    // Locate `export function define` body and the `BusEvent.define` call inside it.
    const defineStart = content.indexOf("export function define")
    expect(defineStart).toBeGreaterThan(-1)
    const next = content.indexOf("export function ", defineStart + 30)
    const body = content.slice(defineStart, next === -1 ? undefined : next)
    expect(body).toMatch(/BusEvent\.define\(\s*def\.type/)
  })

  test("SyncEvent.init body also registers events in BusEvent (defense in depth)", async () => {
    const content = await readText(path.join(srcDir, "sync", "index.ts"))
    const initStart = content.indexOf("export function init")
    expect(initStart).toBeGreaterThan(-1)
    const next = content.indexOf("export function ", initStart + 30)
    const body = content.slice(initStart, next === -1 ? undefined : next)
    expect(body).toMatch(/BusEvent\.define\(\s*def\.type/)
  })

  test("runtime: every MessageV2.Event SyncEvent type is in BusEvent.registry", async () => {
    const { BusEvent } = await import("@/bus/bus-event")
    // Side-effect import to register events.
    const { MessageV2 } = await import("@/session/message-v2")
    expect(MessageV2.Event.Updated).toBeDefined()

    const expected = ["message.updated", "message.removed", "message.part.updated", "message.part.removed"]
    const union = BusEvent.payloads()
    const types = new Set<string>()
    const opts = (union as any)._zod?.def?.options ?? (union as any).options ?? []
    for (const opt of opts) {
      const def = opt._zod?.def ?? opt.def ?? opt
      const shape = def.shape ?? (typeof def.shape === "function" ? def.shape() : undefined)
      const t = shape?.type
      const lit = t?._zod?.def?.values?.[0] ?? t?._def?.value ?? t?.value
      if (typeof lit === "string") types.add(lit)
    }
    for (const e of expected) {
      if (!types.has(e)) throw new Error(`BusEvent payloads missing "${e}"; got: ${[...types].sort().join(",")}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Cross-module consistency: known event type names match across consumers
// ---------------------------------------------------------------------------

describe("invariant: event-type literals match between producer and consumers", () => {
  // If upstream renames an event (e.g. "message.updated" -> "message.update"),
  // producer and consumer drift silently — typecheck only catches it if the
  // producer and consumer share a discriminated union, which they don't always
  // do across acp/agent.ts, cli/cmd/run.ts, cli/cmd/tui/worker.ts, sync.tsx.
  const consumers: Array<{ file: string; types: string[] }> = [
    {
      file: "cli/cmd/tui/context/sync.tsx",
      types: ["message.updated", "message.removed", "message.part.updated", "message.part.removed"],
    },
    // worker.ts's inline event handling moved into the shared trace consumer
    // (also used by `serve`) — the literals live there now.
    {
      file: "altimate/observability/trace-consumer.ts",
      types: ["message.updated", "message.part.updated", "session.updated", "session.deleted"],
    },
    { file: "cli/cmd/run.ts", types: ["message.updated", "message.part.updated"] },
    { file: "acp/agent.ts", types: ["message.part.updated"] },
  ]
  for (const c of consumers) {
    test(`${c.file} consumes the canonical event-type literals`, async () => {
      const content = await readText(path.join(srcDir, c.file))
      for (const t of c.types) {
        // Match the literal as a quoted string. Tolerate either single or double quotes.
        const re = new RegExp(`["']${t.replace(/\./g, "\\.")}["']`)
        if (!re.test(content)) {
          throw new Error(`${c.file} no longer references "${t}" — event rename or consumer drift`)
        }
      }
    })
  }

  test("producer (message-v2.ts) registers exactly the canonical event-type literals", async () => {
    const content = await readText(path.join(srcDir, "session", "message-v2.ts"))
    for (const t of ["message.updated", "message.removed", "message.part.updated", "message.part.removed"]) {
      expect(content).toContain(`type: "${t}"`)
    }
  })
})

// ---------------------------------------------------------------------------
// Async signature invariants
// ---------------------------------------------------------------------------

interface AsyncCheck {
  file: string
  fn: string
  /** Optional caller files to scan for non-await usage. */
  callers?: string[]
}

const ASYNC_FUNCTIONS: AsyncCheck[] = [
  { file: "account/index.ts", fn: "active" },
  { file: "session/message-v2.ts", fn: "toModelMessages" },
  { file: "session/status.ts", fn: "set" },
  { file: "session/prompt.ts", fn: "cancel" },
  { file: "session/todo.ts", fn: "update" },
  { file: "session/todo.ts", fn: "get" },
]

describe("invariant: known-async functions stay async (Promise return)", () => {
  for (const check of ASYNC_FUNCTIONS) {
    test(`${check.file} :: ${check.fn} is declared async or returns Promise`, async () => {
      const content = await readText(path.join(srcDir, check.file))
      const asyncRe = new RegExp(`export\\s+async\\s+function\\s+${check.fn}\\b`)
      // Allow multi-line signatures up to the body open-brace.
      const promiseRe = new RegExp(`export\\s+function\\s+${check.fn}\\b[\\s\\S]*?\\)\\s*:\\s*Promise<`)
      const ok = asyncRe.test(content) || promiseRe.test(content)
      if (!ok) {
        throw new Error(`${check.file} :: ${check.fn} is no longer async/Promise-returning`)
      }
    })
  }

  // Build a generic call-site scanner: any free reference to one of these
  // identifiers (e.g. `Todo.update(`, `SessionStatus.set(`) outside the
  // definition file must be awaited.
  const NAMESPACED = [
    { ns: "Account", method: "active", defFile: path.join("account", "index.ts") },
    { ns: "MessageV2", method: "toModelMessages", defFile: path.join("session", "message-v2.ts") },
    { ns: "SessionStatus", method: "set", defFile: path.join("session", "status.ts") },
    { ns: "SessionPrompt", method: "cancel", defFile: path.join("session", "prompt.ts") },
    { ns: "Todo", method: "update", defFile: path.join("session", "todo.ts") },
    { ns: "Todo", method: "get", defFile: path.join("session", "todo.ts") },
  ]

  for (const n of NAMESPACED) {
    test(`every ${n.ns}.${n.method}() call site uses await / .then / void / assignment`, async () => {
      const files = await walkSource(srcDir)
      const pattern = new RegExp(`\\b${n.ns}\\.${n.method}\\s*\\(`)
      const offenders: string[] = []
      for (const file of files) {
        if (file.endsWith(n.defFile)) continue
        const content = await readText(file)
        const lines = content.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue
          if (!pattern.test(line)) continue
          // Permitted shapes:
          //   await Todo.update(  /  .then  /  void Todo.update(
          //   = Todo.update / const x = Todo.update (assignment to await later)
          //   yield* Todo.update(  (Effect generator)
          //   originalFn = Todo.update (test mock)
          //   import / export references
          const stmt = line.trim()
          const before = line.slice(0, line.search(pattern)).trim()
          const okPrefix =
            /\bawait\b\s*$/.test(before) ||
            /\bvoid\b\s*$/.test(before) ||
            /\byield\*?\b\s*$/.test(before) ||
            /=\s*$/.test(before) ||
            /\.then\s*\(\s*$/.test(before) ||
            /\(\s*$/.test(before) || // inside another call's argument list
            /,\s*$/.test(before) ||
            /\[\s*$/.test(before) ||
            /\?\s*$/.test(before) ||
            /:\s*$/.test(before)
          // Continuation from previous line (multi-line await ...).
          const prev = (lines[i - 1] ?? "").trimEnd()
          const continuation = /\b(await|return|=>|=|,|\(|\.then\(|yield\*?)\s*$/.test(prev)
          // Permit `.then(` / `.catch(` chained on the same line after the call.
          const sameLineThen = /\)\s*\.(then|catch|finally)\s*\(/.test(line)
          if (okPrefix || continuation || sameLineThen) continue
          // Permit `import { X } from "..."` lines (we already excluded def file)
          if (/^import\b/.test(stmt) || /^export\b/.test(stmt)) continue
          offenders.push(`${path.relative(repoRoot, file)}:${i + 1}: ${stmt}`)
        }
      }
      if (offenders.length) {
        throw new Error(`Non-awaited ${n.ns}.${n.method}() call sites:\n  ${offenders.join("\n  ")}`)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Database / storage invariants
// ---------------------------------------------------------------------------

describe("invariant: SyncEvent.run always uses behavior:'immediate' transaction", () => {
  // Cycle 5 bug: the comment claimed an immediate transaction but the wrapper
  // dropped the option, leaving deferred mode. Concurrent SyncEvent.run() calls
  // could interleave and corrupt the event log. The fix: pass {behavior:"immediate"}.
  test("sync/index.ts SyncEvent.run() body contains behavior:'immediate'", async () => {
    const raw = await readText(path.join(srcDir, "sync", "index.ts"))
    const content = stripComments(raw)
    const runStart = content.indexOf("export function run")
    expect(runStart).toBeGreaterThan(-1)
    const next = content.indexOf("export function ", runStart + 30)
    const body = content.slice(runStart, next === -1 ? undefined : next)
    expect(body).toMatch(/Database\.transaction\([\s\S]*?behavior:\s*["']immediate["']/)
  })

  test("storage/db.ts Database.transaction signature accepts TransactionConfig", async () => {
    const content = await readText(path.join(srcDir, "storage", "db.ts"))
    expect(content).toMatch(/TransactionConfig/)
    // Match across the multi-line signature: `transaction<T>(callback: ..., config?: TransactionConfig`.
    expect(content).toMatch(/transaction<[^>]+>\([\s\S]*?config\?:\s*TransactionConfig/)
    // The config must be threaded through to the inner transaction call (not just declared).
    const fnIdx = content.indexOf("export function transaction")
    expect(fnIdx).toBeGreaterThan(-1)
    const fnBody = content.slice(fnIdx, fnIdx + 1500)
    expect(fnBody).toMatch(/transaction\b[\s\S]*config\b/)
  })
})

describe("invariant: security-critical code uses Filesystem.containsReal (not contains)", () => {
  // Symlink escape: Filesystem.contains is lexical; .containsReal does realpath
  // resolution first. Project-containment and plugin-path checks are the two
  // historically-vulnerable sites. Any future merge must keep them on containsReal.
  const SECURITY_FILES = ["project/instance.ts", "plugin/shared.ts"]
  for (const rel of SECURITY_FILES) {
    test(`${rel} uses Filesystem.containsReal exclusively`, async () => {
      const content = stripComments(await readText(path.join(srcDir, rel)))
      // Must reference containsReal at least once.
      expect(content).toMatch(/Filesystem\.containsReal\b/)
      // Must NOT reference plain Filesystem.contains (without Real).
      const lines = content.split("\n")
      for (const line of lines) {
        if (/\bFilesystem\.contains\b(?!Real)/.test(line)) {
          throw new Error(`${rel} re-introduced unsafe Filesystem.contains: ${line.trim()}`)
        }
      }
    })
  }
})

describe("invariant: HTML error templates escape user-controlled strings", () => {
  // Both error pages — mcp/oauth-callback.ts and plugin/codex.ts — interpolate
  // an `error` string into HTML. Any future merge must keep that interpolation
  // wrapped in escapeHtml() to prevent stored XSS. We assert by walking every
  // ${error} / ${errorMsg} usage in HTML template literals.
  const HTML_ERROR_FILES = ["plugin/codex.ts", "mcp/oauth-callback.ts"]
  for (const rel of HTML_ERROR_FILES) {
    test(`${rel} only interpolates user-controlled error via escapeHtml(...)`, async () => {
      const content = await readText(path.join(srcDir, rel))
      // Find every backtick template literal, then every ${...} inside it that
      // mentions `error` (the user-controlled identifier name in this codebase).
      const literals = content.match(/`[\s\S]*?`/g) ?? []
      const offenders: string[] = []
      for (const lit of literals) {
        const interps = lit.match(/\$\{([^}]+)\}/g) ?? []
        for (const i of interps) {
          // Bare "${error}" or "${errorMsg}" without escapeHtml is the bug.
          if (/^\$\{\s*(error|errorMsg|err|errorMessage)\s*\}$/.test(i)) {
            offenders.push(i)
          }
        }
      }
      if (offenders.length) {
        throw new Error(`${rel} has unescaped error interpolations: ${offenders.join(", ")}`)
      }
      // Positive: there must be at least one escapeHtml(error) usage.
      expect(content).toMatch(/escapeHtml\(\s*error\s*\)/)
    })
  }
})

// ---------------------------------------------------------------------------
// Schema shape invariants
// ---------------------------------------------------------------------------

describe("invariant: SDK Event union exposes the canonical message events", () => {
  // The cycle 3 bridge causes the OpenAPI generator to emit:
  //   EventMessageUpdated, EventMessageRemoved, EventMessagePartUpdated, EventMessagePartRemoved
  // Without these, SDK consumers cannot type-narrow on event.type. Re-running
  // `bun dev generate` after a future merge must continue to produce all four.
  test("packages/sdk/js/src/v2/gen/types.gen.ts exports all four message Event types", async () => {
    const content = await readText(path.join(repoRoot, "packages", "sdk", "js", "src", "v2", "gen", "types.gen.ts"))
    for (const t of [
      "EventMessageUpdated",
      "EventMessageRemoved",
      "EventMessagePartUpdated",
      "EventMessagePartRemoved",
    ]) {
      expect(content).toMatch(new RegExp(`export type ${t}\\s*=`))
    }
    // The Event discriminated union must list them. The union body is a series
    // of `| EventX` lines terminated by a blank line and the next `export type`.
    const union = content.match(/export type Event\s*=([\s\S]*?)\n\s*export\s+type\s+/)
    expect(union).not.toBeNull()
    for (const t of [
      "EventMessageUpdated",
      "EventMessageRemoved",
      "EventMessagePartUpdated",
      "EventMessagePartRemoved",
    ]) {
      if (!union![1].includes(t)) {
        throw new Error(`SDK Event union missing ${t}`)
      }
    }
  })
})

describe("invariant: MessageV2.User.model includes optional variant", () => {
  // Upstream PR #21332 added `model.variant` so the assistant can inherit a
  // user-selected variant. Our SDK still surfaces `variant` at the top level
  // of UserMessage too, but the nested model.variant must remain — both for
  // wire-compat with newer providers and for Provider.Model typing.
  test("UserMessage schema has model.variant: z.string().optional()", async () => {
    const content = await readText(path.join(srcDir, "session", "message-v2.ts"))
    // The User schema is built via `Base.extend({...})` (cycle 1+ shape).
    const userStart = content.search(/export\s+const\s+User\s*=\s*[A-Za-z_]\w*\.extend\(\{/)
    expect(userStart).toBeGreaterThan(-1)
    // Slice to next exported const to bound the search.
    const after = content.slice(userStart)
    const nextExport = after.search(/\n\s*export\s+(const|type)\s+\w+\s*=/)
    // First match is the User declaration itself; need the SECOND.
    let block = after
    {
      const re = /\n\s*export\s+(const|type)\s+\w+\s*=/g
      let m: RegExpExecArray | null
      let count = 0
      while ((m = re.exec(after)) !== null) {
        count++
        if (count === 2) {
          block = after.slice(0, m.index)
          break
        }
      }
      void nextExport
    }
    // Find `model: z.object({ ... })` inside this block; it must contain `variant`.
    const modelMatch = block.match(/model:\s*z\.object\(\{([\s\S]*?)\}\)/)
    expect(modelMatch).not.toBeNull()
    expect(modelMatch![1]).toMatch(/variant:\s*z\.string\(\)\.optional\(\)/)
  })
})

describe("invariant: SyncEvent and BusEvent agree on type-name shape (no versioned leakage)", () => {
  // After cycle 3, BusEvent.payloads() must contain UNVERSIONED type literals
  // ("message.updated"). The versioned form ("message.updated.1") only lives in
  // SyncEvent.versionedType output for storage replay. If a future merge accidentally
  // registers the versioned name on the bus, SDK consumers break.
  test("BusEvent.registry contains no versioned (.1, .2) message-event names", async () => {
    const { BusEvent } = await import("@/bus/bus-event")
    await import("@/session/message-v2") // side-effect register
    const types = new Set<string>()
    const union = BusEvent.payloads()
    const opts = (union as any)._zod?.def?.options ?? (union as any).options ?? []
    for (const opt of opts) {
      const def = opt._zod?.def ?? opt.def ?? opt
      const shape = def.shape ?? (typeof def.shape === "function" ? def.shape() : undefined)
      const t = shape?.type
      const lit = t?._zod?.def?.values?.[0] ?? t?._def?.value ?? t?.value
      if (typeof lit === "string") types.add(lit)
    }
    for (const t of types) {
      // Allow real dotted names like "message.part.updated"; reject `.<digits>` suffix
      // which is what versionedType("x", 1) produces.
      if (/\.\d+$/.test(t)) {
        throw new Error(`BusEvent registry has versioned name "${t}" — bridge schema drift`)
      }
    }
    // At minimum the four cycle-3 events must be there.
    for (const t of ["message.updated", "message.removed", "message.part.updated", "message.part.removed"]) {
      if (!types.has(t)) throw new Error(`BusEvent missing canonical "${t}"`)
    }
  })
})

// ---------------------------------------------------------------------------
// Build infrastructure invariants
// ---------------------------------------------------------------------------

describe("invariant: build infrastructure pinning (cycle 2)", () => {
  test("root package.json overrides pin effect@4.0.0-beta.43", async () => {
    const pkg = JSON.parse(await readText(path.join(repoRoot, "package.json")))
    // Cycle 2 bug: beta.58 removed ServiceMap; we depend on it. Future bumps
    // require coordinated migration to Context — until then, this pin must hold.
    expect(pkg.overrides?.["effect"]).toBe("4.0.0-beta.43")
    expect(pkg.overrides?.["@effect/platform-node"]).toBe("4.0.0-beta.43")
    expect(pkg.overrides?.["@effect/platform-node-shared"]).toBe("4.0.0-beta.43")
  })

  test("root catalog declares cross-spawn and @types/cross-spawn", async () => {
    // Bun 1.3.10's catalog resolution: deps that downstream packages reference
    // via `catalog:` MUST appear in the root catalog or workspace install fails.
    const pkg = JSON.parse(await readText(path.join(repoRoot, "package.json")))
    const cat = pkg.workspaces?.catalog ?? pkg.catalog ?? {}
    expect(cat["cross-spawn"]).toBeDefined()
    expect(cat["@types/cross-spawn"]).toBeDefined()
  })

  test("packages/opencode declares npm-package-arg + @types/npm-package-arg", async () => {
    const pkg = JSON.parse(await readText(path.join(repoRoot, "packages", "opencode", "package.json")))
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(allDeps["npm-package-arg"]).toBeDefined()
    expect(allDeps["@types/npm-package-arg"]).toBeDefined()
  })

  test("packages/opencode declares cross-spawn + @types/cross-spawn (catalog-resolved)", async () => {
    const pkg = JSON.parse(await readText(path.join(repoRoot, "packages", "opencode", "package.json")))
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(allDeps["cross-spawn"]).toBeDefined()
    expect(allDeps["@types/cross-spawn"]).toBeDefined()
  })

  test("packages/opencode declares @effect/platform-node + @npmcli/arborist", async () => {
    const pkg = JSON.parse(await readText(path.join(repoRoot, "packages", "opencode", "package.json")))
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(allDeps["@effect/platform-node"]).toBeDefined()
    expect(allDeps["@npmcli/arborist"]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Behavioral safety invariants
// ---------------------------------------------------------------------------

describe("invariant: PlanExitTool rejects on anything except explicit Yes (cycle 4)", () => {
  // Cycle 4 reverted v1.4.0's `answer === "No"` (which silently confirms on
  // dialog cancel/dismiss/network drop) back to `answer !== "Yes"` (explicit
  // affirmative required). This invariant tracks the intent — not just one
  // file string match — by checking active code only.
  test("tool/plan.ts active code uses '!== \"Yes\"' for the rejection branch", async () => {
    const content = await readText(path.join(srcDir, "tool", "plan.ts"))
    const active = stripComments(content)
    // Must contain the safe form …
    expect(active).toMatch(/answer\s*!==\s*"Yes"\s*\)\s*throw\s+new\s+Question\.RejectedError/)
    // … and must NOT contain the unsafe form.
    expect(active).not.toMatch(/answer\s*===\s*"No"\s*\)\s*throw\s+new\s+Question\.RejectedError/)
  })
})

describe("invariant: BusEvent.define is idempotent on duplicate type names", () => {
  // Cycle 4 made BusEvent.define return the existing definition on a duplicate
  // call instead of overwriting. Without this, SyncEvent.define + SyncEvent.init
  // both calling BusEvent.define for the same type would race and the schema
  // visible to the SDK would depend on import order. We re-prove the property
  // here in case a refactor removes the early-return.
  test("calling BusEvent.define twice with the same type returns the first definition", async () => {
    const { BusEvent } = await import("@/bus/bus-event")
    const z = (await import("zod")).default
    const type = "__invariant_idem_" + Math.random().toString(36).slice(2)
    const first: any = BusEvent.define(type, z.object({ a: z.string() }))
    const second: any = BusEvent.define(type, z.object({ b: z.number() }))
    expect(second).toBe(first)
    // Schema must be the FIRST one (preserve registration semantics).
    expect((second.properties as any)?.shape?.a ?? (second.properties as any)?._def?.shape?.()?.a).toBeDefined()
  })

  test("BusEvent.define returns a value with stable {type, properties} shape", async () => {
    const { BusEvent } = await import("@/bus/bus-event")
    const z = (await import("zod")).default
    const type = "__invariant_shape_" + Math.random().toString(36).slice(2)
    const def: any = BusEvent.define(type, z.object({ x: z.string() }))
    expect(def.type).toBe(type)
    expect(def.properties).toBeDefined()
  })
})
