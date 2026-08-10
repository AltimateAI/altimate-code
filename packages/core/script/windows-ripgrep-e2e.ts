/**
 * Windows end-to-end check for ripgrep binary resolution.
 *
 * Reproduces as much as a GitHub runner allows of the condition behind the outage in
 * https://github.com/AltimateAI/altimate-code/issues/1072: a cold cache on a Windows machine
 * where PowerShell cannot be resolved from PATH. The old implementation extracted ripgrep's zip
 * by shelling out to `powershell.exe -Command Expand-Archive`, so cross-spawn fell back to
 * `cmd.exe /d /s /c` and the extraction died with "is not recognized as an internal or external
 * command" — which `Effect.cached` then replayed for the rest of the session.
 *
 * This performs a real download and a real extraction, then executes the resulting binary. It is
 * deliberately not a unit test: the point is to exercise the actual filesystem, the actual archive
 * and the actual process launch on a real Windows host.
 *
 * Scope note: stripping PATH does NOT make PowerShell unspawnable on Windows (see the control
 * probe at the end), so this does not reproduce the affected machines. The guarantee that
 * extraction spawns nothing at all is established by test/ripgrep-windows.test.ts.
 *
 * Run: bun run script/windows-ripgrep-e2e.ts   (from packages/core — `effect` resolves there)
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, readdirSync, statSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function ok(message: string) {
  console.log(`ok   ${message}`)
}

if (process.platform !== "win32") fail(`this check only means anything on Windows (got ${process.platform})`)

// Cold cache: point the XDG cache root at a throwaway directory *before* importing anything that
// reads it, since Global computes its paths at module load.
const cacheRoot = mkdtempSync(path.join(tmpdir(), "rg-e2e-"))
process.env.XDG_CACHE_HOME = cacheRoot
process.env.LOCALAPPDATA = cacheRoot

// Remove every PATH entry that could provide PowerShell. System32 itself is kept so cmd.exe and
// the rest of Windows still work — this simulates the locked-down/sanitized-PATH machines in the
// telemetry, not a broken OS.
const originalPath = process.env.PATH ?? process.env.Path ?? ""
const stripped = originalPath
  .split(path.delimiter)
  .filter((entry) => entry && !/powershell/i.test(entry))
  .join(path.delimiter)
process.env.PATH = stripped
process.env.Path = stripped

const { which } = await import("../src/util/which")

// Guard against a vacuous run: if PowerShell is still resolvable, this proves nothing.
const ps = which("powershell.exe")
const pwsh = which("pwsh.exe")
if (ps || pwsh) fail(`PowerShell is still resolvable (${ps ?? pwsh}) — the scenario was not reproduced`)
ok("PowerShell is not resolvable on PATH (failure condition reproduced)")

// Also assert the binary really is absent, so we exercise download + extract rather than a cache hit.
const { Global } = await import("../src/global")
const target = path.join(Global.Path.bin, "rg.exe")
if (existsSync(target)) fail(`expected a cold cache but ${target} already exists`)
ok(`cold cache at ${Global.Path.bin}`)

const { Effect } = await import("effect")
const { RipgrepBinary } = await import("../src/ripgrep/binary")

/** Resolve through the real layer: real HTTP, real filesystem, real process launch. */
async function resolveBinary(): Promise<string> {
  const program = Effect.gen(function* () {
    const binary = yield* RipgrepBinary.Service
    return yield* binary.filepath
  }).pipe(Effect.provide(RipgrepBinary.defaultLayer))
  return (await Effect.runPromise(program as never)) as string
}

let resolved: string
try {
  resolved = await resolveBinary()
} catch (err: unknown) {
  fail(`binary.filepath failed: ${err instanceof Error ? err.message : String(err)}`)
}

ok(`resolved ${resolved}`)

if (!existsSync(resolved)) fail(`resolved path does not exist: ${resolved}`)
const size = statSync(resolved).size
if (size < 100_000) fail(`resolved binary is implausibly small (${size} bytes) — likely a partial write`)
ok(`binary present, ${size} bytes`)

// No staging files should survive a successful install.
const leftovers = readdirSync(Global.Path.bin).filter((f) => f.endsWith(".tmp"))
if (leftovers.length > 0) fail(`staging files left behind: ${leftovers.join(", ")}`)
ok("no staging files left behind")

// The real proof: the extracted binary actually executes.
const version = execFileSync(resolved, ["--version"], { encoding: "utf8" })
if (!/ripgrep\s+\d/.test(version)) fail(`unexpected --version output: ${version.trim()}`)
ok(`executes: ${version.split("\n")[0]!.trim()}`)

// And it can actually search.
const hit = execFileSync(resolved, ["--no-config", "NEEDLE_MARKER", "--", import.meta.filename], {
  encoding: "utf8",
})
if (!hit.includes("NEEDLE_MARKER")) fail("ripgrep did not return the expected match")
ok("search returns matches") // NEEDLE_MARKER

// A second resolve must hit the cache and stay valid.
const again = await resolveBinary()
if (again !== resolved) fail(`second resolve returned a different path: ${again}`)
ok("second resolve hits the cache")

// ---------------------------------------------------------------------------
// Control probe — informational, deliberately not a hard failure.
//
// It would be neater to also show that the OLD implementation fails here, making this a true
// counterfactual. It does not, and that is worth recording: emptying PATH is not enough to make
// PowerShell unspawnable on Windows. cross-spawn falls back to `cmd.exe /d /s /c`, and Windows
// process creation searches beyond PATH (the caller's directory, the system directories, and the
// App Paths registry key), so `powershell.exe` still starts on a stock GitHub runner even though
// `which()` cannot see it.
//
// So this job does NOT reproduce the affected machines. What it does prove is the part that
// matters: on real Windows the new path downloads, extracts in-process, installs and produces a
// working rg.exe. That PowerShell's availability is irrelevant to it is established separately and
// structurally by `test/ripgrep-windows.test.ts`, which drives the same code with a spawner that
// fails the test if anything is launched at all.
// ---------------------------------------------------------------------------
const launch = (await import("cross-spawn")).default
const control = launch.sync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
  encoding: "utf8",
})

if (control.status === 0) {
  console.log(
    "note this runner still spawns powershell.exe despite the stripped PATH (Windows resolves\n" +
      "     executables beyond PATH), so the affected environment is not reproduced here — the\n" +
      "     no-spawn guarantee comes from the unit layer test, not from this job",
  )
} else {
  const output = `${control.stderr ?? ""}${control.stdout ?? ""}${control.error?.message ?? ""}`.trim()
  ok(`bonus: the old PowerShell path also fails here (${output.split("\n")[0]?.slice(0, 100) || `status=${control.status}`})`)
}

rmSync(cacheRoot, { recursive: true, force: true })
console.log("\nPASS — on real Windows, ripgrep downloads, extracts in-process, installs atomically")
console.log("       and runs. See the note above for what this job does and does not establish.")
