import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"

// PRESENCE guards for fork features that hook into upstream-owned files. Every upstream merge
// re-extracts those files (worker.ts, server.ts, serve.ts, the TUI logo, …) and can silently drop a
// fork hook — no compile error, no failing test, because the dropped code needs no markers and the
// existing "absence" tests still pass. These assert each hook is PRESENT so a drop turns into a red
// test on the next merge. The inverse of test/cli/tui/worker-trace-clearing.test.ts (which asserts
// OLD logic is absent).
//
// These are intentionally string-level source checks: cheap, no creds, CI-friendly, and aimed at one
// failure mode only — a merge silently deleting the hook. If a hook is legitimately renamed/moved,
// update the matching guard (that edit is itself the signal that the hook changed).
const REPO = path.resolve(__dirname, "../../") // packages/opencode
const MONO = path.resolve(__dirname, "../../../") // repo packages root

async function read(rel: string, base = REPO): Promise<string> {
  return fs.readFile(path.join(base, rel), "utf-8")
}

describe("fork feature presence guards (merge drop detection)", () => {
  test("log shim is quiet-by-default and honors --print-logs (TUI flood guard)", async () => {
    const src = await read("src/altimate/util/log.ts")
    // The flood regression was a hard-coded always-on writer.
    expect(src).not.toMatch(/printEnabled\s*=\s*true/)
    // It must gate on the --print-logs env the CLI sets.
    expect(src).toContain("OPENCODE_PRINT_LOGS")
  })

  test("serve wires the trace consumer (serve-mode tracing)", async () => {
    const src = await read("src/cli/cmd/serve.ts")
    expect(src).toContain("subscribeTraceConsumer")
  })

  test("server preserves the v1.17.9 /api HttpApi bridge", async () => {
    // Without this bridge the legacy Hono catch-all proxies /api/* to app.altimate.ai and floods the
    // TUI with connection errors (the bridge is the altimate_change that keeps /api/provider etc local).
    const src = await read("src/server/server.ts")
    expect(src).toContain("httpApiBridge")
  })

  test("server auth default username is opencode (TUI/worker auth)", async () => {
    // The TUI worker authenticates with `opencode:<password>`; a branded default broke authenticated
    // server/TUI calls. Guard the aligned default.
    const src = await read("src/server/auth.ts")
    expect(src).toContain('"opencode"')
  })

  test("TUI wordmark is the Altimate brand wordmark (not opencode)", async () => {
    const src = await read("src/logo.ts", MONO + "/tui")
    // The rebrand marker + Altimate letterforms must survive a merge that ships upstream's wordmark.
    expect(src).toContain("rebrand")
    expect(src).not.toMatch(/\bopen\b.*\bcode\b/i) // not the literal opencode wordmark comment
    // The wordmark is the clean 2-row uppercase ALTIMATE CODE block font (a lowercase variant rendered
    // cramped through the subpixel renderer). The "ALT" start glyphs uniquely identify it — a merge
    // that dropped the rebrand back to opencode's wordmark would not contain them.
    expect(src).toContain("▄▀█ █   ▀█▀") // A L T  — start of "ALTIMATE"
  })

  // The interactive TUI worker must feed bus events to the TraceConsumer AND finalize synchronously on
  // shutdown, or TUI sessions write no traces (the v1.17.9 regression — async fs writes don't flush on
  // the quiet Bun Worker thread).
  test("TUI worker wires the trace consumer + sync shutdown finalize", async () => {
    const src = await read("src/cli/tui/worker.ts")
    expect(src).toContain("TraceConsumer")
    expect(src).toContain("handleEvent")
    expect(src).toContain("flushSync") // synchronous finalize on shutdown is the load-bearing part
  })

  // The fff file picker must stay scoped to the active project. Upstream enables filesystem-root +
  // home-dir scanning, which leaks high-frecency files from OTHER repos (e.g. an altimate-backend
  // checkout) into the @-attach suggestions of a project that doesn't contain them. A merge that
  // re-extracts search.ts would silently restore the upstream defaults. See the Altimate Code Issues
  // report (RCA 2).
  // #209 sensitive-write guard: writes/edits/moves into credential/VCS/security locations (.git/,
  // .ssh/, .env*, private keys, ...) must require a SEPARATE "sensitive_write" permission, even inside
  // the project. The v1.17.9 merge dropped the wrapper + its 4 call sites (the function survived as
  // dead code; a private test copy hid it). Guard the DEFINITION and every CALL SITE so a merge that
  // drops the wiring goes red — a behavioral test alone missed it because the wiring, not the function,
  // was lost.
  test("sensitive-write guard is wired into write/edit/apply_patch (#209)", async () => {
    const extDir = await read("src/tool/external-directory.ts")
    expect(extDir).toContain("assertSensitiveWriteEffect")
    expect(extDir).toContain("assertSensitiveWrite") // promise wrapper too
    expect(extDir).toContain('"sensitive_write"') // separate permission key (not "edit")
    for (const tool of ["write", "edit", "apply_patch"]) {
      const src = await read(`src/tool/${tool}.ts`)
      expect(src, `${tool}.ts must call the sensitive-write guard`).toContain("assertSensitiveWriteEffect(ctx,")
    }
  })

  test("fff file search is scoped to the project (no home/root scanning leak)", async () => {
    const src = await read("core/src/filesystem/search.ts", MONO)
    expect(src).toContain("enableFsRootScanning: false")
    expect(src).toContain("enableHomeDirScanning: false")
    expect(src).not.toMatch(/enable(FsRoot|HomeDir)Scanning:\s*true/)
  })

  // SYSTEMIC fix for the recurring "library logs corrupt the TUI after a merge" class: the worker
  // redirects its stdout/stderr to the log file. A merge that re-extracts worker.ts could drop the
  // first-import guard, which would silently re-flood the TUI. Assert both the wiring and the redirect.
  test("TUI worker redirects stdout/stderr away from the terminal (console guard)", async () => {
    const worker = await read("src/cli/tui/worker.ts")
    // The guard must be imported FIRST (before any module that could log).
    const firstImport = worker.split("\n").find((l) => l.trim().startsWith("import "))
    expect(firstImport).toContain("worker-console-guard")

    const guard = await read("src/cli/tui/worker-console-guard.ts")
    expect(guard).toContain("process.stdout.write")
    expect(guard).toContain("process.stderr.write")
    // In Bun, console.* bypasses process.stdout/stderr.write, so the guard MUST also override the
    // console methods or raw console.* still corrupts the TUI. Guard against a regression that drops it.
    expect(guard).toContain("console.log")
    expect(guard).toContain("console.error")
    expect(guard).toContain("console.warn")
  })

  // MCP.remove: the v1.17.9 merge DELETED MCP.remove from mcp/index.ts (no marker) and rewired the
  // datamate tool to MCP.disconnect — which leaves a stale "disabled" status entry and never publishes
  // ToolsChanged, so a removed/deleted datamate MCP server keeps offering its tools until restart.
  // Guard the restored function (impl + namespace wrapper + the ToolsChanged publish) AND its datamate
  // call sites, so a future merge that drops it again goes red. See the differential audit.
  test("MCP.remove is present (full teardown + ToolsChanged) and wired into datamate", async () => {
    const mcp = await read("src/mcp/index.ts")
    expect(mcp).toContain('Effect.fn("MCP.remove")') // the impl
    expect(mcp).toContain("export async function remove") // the namespace wrapper
    // remove must DELETE the status entry (not just mark "disabled") and publish ToolsChanged so the
    // agent's live tool list / /mcps view refreshes — the behavior disconnect lacks.
    expect(mcp).toMatch(/delete s\.status\[name\][\s\S]*events\.publish\(ToolsChanged/)
    const datamate = await read("src/altimate/tools/datamate.ts")
    expect(datamate, "datamate must use MCP.remove (not just disconnect) so removed servers stop offering tools").toContain(
      "MCP.remove(",
    )
  })

  test("core Global uses the altimate-code data dir (unified with the fork global, not split to opencode)", async () => {
    // The overlay reverted packages/core/src/global.ts to upstream's app="opencode", splitting auth/
    // sessions/db across ~/.local/share/{opencode,altimate-code}. Both globals must agree on altimate-code.
    const core = await read("core/src/global.ts", MONO)
    expect(core).toContain('const app = "altimate-code"')
    expect(core).not.toMatch(/const app = "opencode"/)
    const fork = await read("src/global/index.ts")
    expect(fork).toContain('const app = "altimate-code"')
  })

  test("branded altimate-code theme is registered and is the TUI default (not upstream opencode)", async () => {
    const index = await read("src/theme/index.ts", MONO + "/tui")
    expect(index).toContain("altimate-code.json") // asset imported
    expect(index).toMatch(/\["altimate-code"\]\s*:\s*altimateCode/) // registered in DEFAULT_THEMES
    const ctx = await read("src/context/theme.tsx", MONO + "/tui")
    expect(ctx).toContain('const DEFAULT_THEME = "altimate-code"')
    expect(ctx).not.toMatch(/active:\s*"opencode"/) // default must not revert to upstream
  })

  test("ACP permission handler honors ALTIMATE_CLI_YOLO (yolo over the acp entrypoint)", async () => {
    const src = await read("src/acp/permission.ts")
    expect(src).toContain("ALTIMATE_CLI_YOLO")
    // must auto-reply "once" on yolo (short-circuit before requestPermission)
    expect(src).toMatch(/ALTIMATE_CLI_YOLO[\s\S]*reply\([^)]*"once"/)
  })

  test("fork keybind defaults are present (prompt enhance + skill list, collision-free)", async () => {
    const kb = await read("src/config/keybind.ts", MONO + "/tui")
    // the re-homed prompt-enhance plugin gathers this name; without the definition the default key is dropped
    expect(kb).toMatch(/\["altimate\.prompt\.enhance"\]\s*:\s*keybind\("<leader>i"/)
    const skill = await read("src/plugin/tui/altimate/skill-ops.tsx")
    // a default key must open the skills list — <leader>k (NOT ctrl+i, which collides with tab/agent-cycle)
    expect(skill).toMatch(/key:\s*"<leader>k",\s*cmd:\s*"altimate\.skill\.list"/)
  })

  test("re-homed TUI fork features keep their submit/provider/cache handoffs", async () => {
    const prompt = await read("src/component/prompt/index.tsx", MONO + "/tui")
    expect(prompt).toContain("/altimate/prompt/enhance")
    expect(prompt).toMatch(/auto_enhance_prompt[\s\S]*requestAutoEnhancedPrompt/)

    const server = await read("src/server/server.ts")
    expect(server).toContain("/altimate/prompt/enhance")
    expect(server).toContain("isAutoEnhanceEnabled")

    const dialogProvider = await read("src/component/dialog-provider.tsx", MONO + "/tui")
    expect(dialogProvider).toMatch(/providerID === "altimate-backend"[\s\S]*dispatchCommand\("altimate\.provider\.connect"\)/)

    const providerPlugin = await read("src/plugin/tui/altimate/provider-credentials.tsx")
    expect(providerPlugin).toContain("AltimateApi.validateCredentials")
    expect(providerPlugin).toContain("api.ui.dialog.openModel(PROVIDER_ID)")

    const skill = await read("src/plugin/tui/altimate/skill-ops.tsx")
    expect(skill).toMatch(/url:\s*"\/skill"[\s\S]*query:\s*\{\s*reload:\s*"true"\s*\}/)
  })

  test("re-homed TUI upstream fixes keep prompt/update/child-session behavior", async () => {
    const promptEnhance = await read("src/plugin/tui/altimate/prompt-enhance.tsx")
    expect(promptEnhance).toMatch(
      /const original = ref\.current\.input[\s\S]*const enhanced = await enhance\(api, original\)[\s\S]*if \(ref\.current\.input !== original\) return/,
    )

    const app = await read("src/app.tsx", MONO + "/tui")
    expect(app).toContain("UPGRADE_KV_KEY")
    expect(app).toMatch(/installation\.update-available[\s\S]*kv\.set\(UPGRADE_KV_KEY, version\)/)

    const session = await read("src/routes/session/index.tsx", MONO + "/tui")
    expect(session).toMatch(/findIndex\(\(x\) => x\.id === session\(\)\?\.id\) \+ direction/)
    expect(session).not.toMatch(/findIndex\(\(x\) => x\.id === session\(\)\?\.id\) - direction/)
  })
})
