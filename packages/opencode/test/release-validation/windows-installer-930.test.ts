/**
 * Regression tests for PR #930 — Windows PowerShell installer (install.ps1) +
 * the native-Windows upgrade wiring in src/installation/index.ts.
 *
 * The existing test (test/install/windows-install.test.ts) pins the parity
 * contract via substring/regex matching on source text. This file goes a layer
 * deeper for the TypeScript wiring: it drives the real `Installation.upgrade`
 * dispatch with `Process.run`/`Process.spawn`, `globalThis.fetch`, the lazy
 * `Telemetry` import, and `process.platform` stubbed, asserting the actual
 * branch behavior rather than a regex on the source.
 *
 * Mocking strategy: the repo deliberately avoids `mock.module` (it is
 * process-global in bun and clobbers modules for the whole run — see
 * test/cli/serve-upgrade-check.test.ts). Instead we reassign the writable
 * members of the shared `Process` / `Telemetry` namespace objects (both the
 * test and src import the same module instance, so the override is observed by
 * `Installation.upgrade`), swap `globalThis.fetch`, and redefine
 * `process.platform` — always restoring originals in `finally` + a defensive
 * `afterEach` so no other test in the suite is affected.
 *
 * `upgradePowershell` / `upgradeCurl` are module-internal (not exported), so the
 * win32 dispatch, the HEAD-probe error surface, and the result-shape contract
 * are exercised through the public `Installation.upgrade("curl", target)`.
 *
 * install.ps1 itself is exercised by static analysis of the script text:
 * `pwsh` is unavailable in this environment, so the PowerShell behaviors
 * (gaps 4–8: baseline selection, already-installed skip, PATH idempotency,
 * GITHUB_PATH emission, missing-exe failure + cleanup) are asserted against the
 * script source. The executable Pester equivalents live in
 * test/windows/install.Tests.ps1, run on windows-latest in CI.
 */
import { describe, test, expect, afterEach } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Readable } from "node:stream"
import { Process } from "../../src/util/process"
import { Installation } from "../../src/installation"
import { Telemetry } from "../../src/telemetry"

const REPO_ROOT = join(import.meta.dir, "../../../..")
const PS1 = readFileSync(join(REPO_ROOT, "install.ps1"), "utf-8")

// ---------------------------------------------------------------------------
// Stub bookkeeping — every test restores these; afterEach is the safety net.
// ---------------------------------------------------------------------------
const ORIG = {
  run: Process.run,
  spawn: Process.spawn,
  text: Process.text,
  track: Telemetry.track,
  fetch: globalThis.fetch,
  platform: Object.getOwnPropertyDescriptor(process, "platform")!,
}

function restoreAll() {
  Process.run = ORIG.run
  Process.spawn = ORIG.spawn
  Process.text = ORIG.text
  Telemetry.track = ORIG.track
  globalThis.fetch = ORIG.fetch
  Object.defineProperty(process, "platform", ORIG.platform)
}

afterEach(restoreAll)

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true })
}

// `process.execPath --version` is awaited at the tail of a successful upgrade();
// stub it to a no-op so we never actually spawn the host binary.
function stubExecVersionProbe() {
  Process.text = async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), text: "" })
}

// A fake bash child for the upgradeCurl (non-win32) path: Process.spawn returns
// a ChildProcess-like object with piped streams and an `exited` promise.
function fakeBashChild(opts: { stdout?: string; stderr?: string; code?: number } = {}) {
  let piped = ""
  return {
    stdin: { end: (s: string) => { piped = s } },
    stdout: Readable.from([Buffer.from(opts.stdout ?? "ok")]),
    stderr: Readable.from([Buffer.from(opts.stderr ?? "")]),
    exited: Promise.resolve(opts.code ?? 0),
    get _piped() {
      return piped
    },
  } as any
}

// ===========================================================================
// GAP 1 — upgrade() dispatches win32 curl-installs to PowerShell, others to bash
// ===========================================================================
describe("upgrade('curl', target) — platform dispatch", () => {
  test("win32 routes to upgradePowershell: powershell + irm install.ps1 | iex, VERSION=target", async () => {
    const runCalls: Array<{ cmd: string[]; opts: any }> = []
    const fetchCalls: Array<{ url: string; method?: string }> = []
    Process.run = async (cmd: string[], opts: any) => {
      runCalls.push({ cmd, opts })
      return { code: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) }
    }
    Telemetry.track = () => {}
    stubExecVersionProbe()
    // HEAD probe must succeed (200) for the PS installer to run.
    // @ts-expect-error stub
    globalThis.fetch = async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), method: init?.method })
      return { ok: true, status: 200, statusText: "OK" } as any
    }
    setPlatform("win32")

    await Installation.upgrade("curl", "1.2.3")

    // Exactly one Process.run, and it is the PowerShell installer.
    expect(runCalls).toHaveLength(1)
    const { cmd, opts } = runCalls[0]
    expect(cmd[0]).toBe("powershell")
    const command = cmd.join(" ")
    expect(command).toContain("irm")
    expect(command).toContain("install.ps1 | iex")
    // The target version is piped to the installer via $env:VERSION.
    expect(opts.env.VERSION).toBe("1.2.3")
    // nothrow so upgrade() can inspect result.code itself.
    expect(opts.nothrow).toBe(true)

    // The HEAD probe hit the .ps1 endpoint, not the bash install endpoint.
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe("https://www.altimate.sh/install.ps1")
    expect(fetchCalls[0].method).toBe("HEAD")
  })

  test("non-win32 routes to upgradeCurl: Process.spawn(['bash']) + fetch to /install (no .ps1)", async () => {
    const spawnCalls: Array<{ cmd: string[] }> = []
    const fetchUrls: string[] = []
    let runCalled = false
    Process.run = async () => {
      runCalled = true
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    Process.spawn = (cmd: string[]) => {
      spawnCalls.push({ cmd })
      return fakeBashChild({ stdout: "done", code: 0 })
    }
    Telemetry.track = () => {}
    stubExecVersionProbe()
    // @ts-expect-error stub
    globalThis.fetch = async (url: any) => {
      fetchUrls.push(String(url))
      return { ok: true, status: 200, statusText: "OK", text: async () => "echo install" } as any
    }
    setPlatform("linux")

    await Installation.upgrade("curl", "1.2.3")

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].cmd[0]).toBe("bash")
    // The bash installer is fetched from UPGRADE_INSTALL_URL (the .ps1 host is never touched).
    expect(fetchUrls).toContain("https://www.altimate.sh/install")
    expect(fetchUrls.some((u) => u.endsWith(".ps1"))).toBe(false)
    expect(runCalled).toBe(false)
  })

  test("darwin (any non-win32) also uses bash, never powershell", async () => {
    const spawnCalls: string[][] = []
    Process.run = async () => {
      throw new Error("Process.run must not be used on the bash path")
    }
    Process.spawn = (cmd: string[]) => {
      spawnCalls.push(cmd)
      return fakeBashChild({ code: 0 })
    }
    Telemetry.track = () => {}
    stubExecVersionProbe()
    // @ts-expect-error stub
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "echo install" }) as any
    setPlatform("darwin")

    await Installation.upgrade("curl", "2.0.0")
    expect(spawnCalls[0][0]).toBe("bash")
  })
})

// ===========================================================================
// GAP 2 — upgradePowershell surfaces a friendly error when the HEAD probe fails
//          (driven through upgrade('curl', ...) on win32)
// ===========================================================================
describe("upgradePowershell — HEAD probe failure surfaces a friendly error, never spawns powershell", () => {
  test("HTTP !ok (503) → Error names URL + 'HTTP 503' + 'irm' recovery; Process.run NOT called", async () => {
    let runCalled = false
    let tracked = 0
    Process.run = async () => {
      runCalled = true
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    Telemetry.track = () => {
      tracked++
    }
    stubExecVersionProbe()
    // @ts-expect-error stub
    globalThis.fetch = async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }) as any
    setPlatform("win32")

    let err: unknown
    try {
      await Installation.upgrade("curl", "1.2.3")
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain("https://www.altimate.sh/install.ps1")
    expect(msg).toContain("HTTP 503")
    expect(msg).toContain("Service Unavailable")
    expect(msg).toContain("irm")
    // It failed at the probe, before any spawn AND before the telemetry block.
    expect(runCalled).toBe(false)
    expect(tracked).toBe(0)
  })

  test("AbortSignal.timeout / network reject → Error names the cause; Process.run NOT called", async () => {
    let runCalled = false
    Process.run = async () => {
      runCalled = true
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    Telemetry.track = () => {}
    stubExecVersionProbe()
    // Mirror what AbortSignal.timeout produces on the real fetch: a TimeoutError.
    // @ts-expect-error stub
    globalThis.fetch = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError")
    }
    setPlatform("win32")

    let err: unknown
    try {
      await Installation.upgrade("curl", "1.2.3")
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain("https://www.altimate.sh/install.ps1")
    expect(msg).toContain("The operation timed out.")
    expect(msg).toContain("irm")
    expect(runCalled).toBe(false)
  })
})

// ===========================================================================
// GAP 3 — upgradePowershell returns the {code, stdout:Buffer, stderr:Buffer}
//          shape that upgrade() consumes (nothrow). Verified through upgrade().
// ===========================================================================
describe("upgradePowershell result shape is consumed by upgrade()", () => {
  test("success: a {code:0, stdout:Buffer, stderr:Buffer} result completes upgrade() cleanly", async () => {
    // The result object upgradePowershell returns IS what Process.run returns.
    // upgrade() reads result.code (=== 0) and logs result.stderr.toString().
    let observedResult: any
    Process.run = async () => {
      observedResult = { code: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) }
      return observedResult
    }
    let trackedStatus = ""
    Telemetry.track = (e: any) => {
      trackedStatus = e.status
    }
    stubExecVersionProbe()
    // @ts-expect-error stub
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK" }) as any
    setPlatform("win32")

    // Resolves (no throw) → upgrade() accepted the shape.
    await expect(Installation.upgrade("curl", "3.0.0")).resolves.toBeUndefined()

    // Shape contract the caller depends on: numeric code, Buffer stderr.
    expect(typeof observedResult.code).toBe("number")
    expect(Buffer.isBuffer(observedResult.stderr)).toBe(true)
    // The exact call the caller makes against stderr must work.
    expect(observedResult.stderr.toString("utf8")).toBe("")
    expect(trackedStatus).toBe("success")
  })

  test("failure: code:1 with stderr Buffer → UpgradeFailedError(stderr) + telemetry status 'error'", async () => {
    Process.run = async () => ({
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("powershell not found"),
    })
    const tracked: any[] = []
    Telemetry.track = (e: any) => tracked.push(e)
    stubExecVersionProbe()
    // @ts-expect-error stub
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK" }) as any
    setPlatform("win32")

    let err: unknown
    try {
      await Installation.upgrade("curl", "1.2.3")
    } catch (e) {
      err = e
    }

    // The caller did result.stderr.toString('utf8') and wrapped it.
    expect(Installation.UpgradeFailedError.isInstance(err)).toBe(true)
    expect((err as any).data.stderr).toBe("powershell not found")

    // An error telemetry event was emitted carrying that stderr.
    expect(tracked).toHaveLength(1)
    expect(tracked[0].type).toBe("upgrade_attempted")
    expect(tracked[0].status).toBe("error")
    expect(tracked[0].to_version).toBe("1.2.3")
    expect(tracked[0].error).toContain("powershell not found")
  })
})

// ===========================================================================
// install.ps1 static-analysis contracts (gaps 4–8).
// pwsh is unavailable here; the executable Pester tests are in
// test/windows/install.Tests.ps1 (CI windows-latest). These assert that the
// script *encodes* the required behavior.
// ===========================================================================

// GAP 4 — baseline archive selection (AVX2 absent / -ForceBaseline)
describe("install.ps1 — baseline vs AVX2 archive selection (static)", () => {
  test("Install-Target appends -baseline to the target only when $Baseline", () => {
    // $target = "windows-$arch"; if ($Baseline) { $target = "$target-baseline" }
    expect(PS1).toMatch(/\$target\s*=\s*"windows-\$arch"/)
    expect(PS1).toMatch(/if\s*\(\$Baseline\)\s*\{\s*\$target\s*=\s*"\$target-baseline"\s*\}/)
    // The downloaded filename is <App>-<target>.zip → windows-x64.zip / windows-x64-baseline.zip.
    expect(PS1).toContain('$filename = "$App-$target.zip"')
  })

  test("needsBaseline is driven by -ForceBaseline OR absence of AVX2", () => {
    // $needsBaseline = $ForceBaseline -or (-not (Test-Avx2))
    expect(PS1).toMatch(/\$needsBaseline\s*=\s*\$ForceBaseline\s*-or\s*\(-not\s*\(Test-Avx2\)\)/)
    expect(PS1).toContain("Install-Target -Baseline:$needsBaseline")
    // Test-Avx2 uses the documented Win32 feature id 40 (PF_AVX2_INSTRUCTIONS_AVAILABLE).
    expect(PS1).toContain("IsProcessorFeaturePresent(40)")
  })

  test("AVX2 detection failure falls back to baseline (returns $false on error)", () => {
    // The catch in Test-Avx2 returns $false → needsBaseline becomes true.
    expect(PS1).toMatch(/function Test-Avx2[\s\S]*?catch\s*\{[\s\S]*?return\s+\$false[\s\S]*?\}/)
  })
})

// GAP 5 — already-installed skip exits 0 without downloading
describe("install.ps1 — already-installed skip (static)", () => {
  test("matching installed version prints 'already installed' and exits 0 before Install-Target", () => {
    expect(PS1).toMatch(/if\s*\(\$installedVersion\s*-eq\s*\$specificVersion\)\s*\{/)
    expect(PS1).toContain("already installed")
    // The skip block exits 0.
    const skipBlock = PS1.slice(PS1.indexOf("$installedVersion -eq $specificVersion"))
    expect(skipBlock).toMatch(/already installed[\s\S]*?exit 0/)
  })

  test("the skip check precedes the download (Install-Target call comes later in the file)", () => {
    const skipIdx = PS1.indexOf("already installed")
    const installCallIdx = PS1.indexOf("Install-Target -Baseline:$needsBaseline")
    expect(skipIdx).toBeGreaterThan(-1)
    expect(installCallIdx).toBeGreaterThan(-1)
    // Early-exit skip is positioned before the download is ever invoked.
    expect(skipIdx).toBeLessThan(installCallIdx)
  })
})

// GAP 6 — PATH update is idempotent, prepends InstallDir, -NoPathUpdate skips
describe("install.ps1 — PATH update idempotency + prepend + opt-out (static)", () => {
  test("InstallDir is prepended to the front of the user Path", () => {
    // $newPath = (@($InstallDir) + $entries) -join ';' → InstallDir is first.
    expect(PS1).toMatch(/\$newPath\s*=\s*\(@\(\$InstallDir\)\s*\+\s*\$entries\)\s*-join\s*';'/)
    expect(PS1).toMatch(/SetValue\("Path",\s*\$newPath/)
  })

  test("the registry write is guarded by a not-contains check (idempotent: no duplicate, no rewrite)", () => {
    // if ($entries -notcontains $InstallDir) { ...SetValue... } → second run is a no-op.
    expect(PS1).toMatch(/if\s*\(\$entries\s*-notcontains\s*\$InstallDir\)\s*\{/)
    const guardIdx = PS1.indexOf("$entries -notcontains $InstallDir")
    const setIdx = PS1.indexOf('SetValue("Path"')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeGreaterThan(guardIdx)
  })

  test("-NoPathUpdate skips the registry write entirely and prints the skip notice", () => {
    expect(PS1).toMatch(/if\s*\(-not\s*\$NoPathUpdate\)\s*\{/)
    expect(PS1).toContain("Skipped PATH modification")
  })
})

// GAP 7 — GITHUB_PATH emission only under GitHub Actions
describe("install.ps1 — GITHUB_PATH emission gated on GitHub Actions (static)", () => {
  test("Add-Content to $env:GITHUB_PATH only when GITHUB_ACTIONS == 'true' AND GITHUB_PATH is set", () => {
    expect(PS1).toMatch(/if\s*\(\$env:GITHUB_ACTIONS\s*-eq\s*"true"\s*-and\s*\$env:GITHUB_PATH\)\s*\{/)
    expect(PS1).toMatch(/Add-Content\s+-Path\s+\$env:GITHUB_PATH\s+-Value\s+\$InstallDir/)
  })

  test("the Add-Content is inside the guard (not emitted unconditionally)", () => {
    const guardIdx = PS1.indexOf('$env:GITHUB_ACTIONS -eq "true"')
    const addIdx = PS1.indexOf("Add-Content -Path $env:GITHUB_PATH")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(addIdx).toBeGreaterThan(guardIdx)
  })
})

// GAP 8 — fails clearly when archive lacks altimate.exe; temp dir cleaned up
describe("install.ps1 — missing altimate.exe in archive fails + cleans up (static)", () => {
  test("throws 'Archive did not contain' when the extracted binary is absent", () => {
    // if (-not (Test-Path $extracted)) { throw "Archive did not contain $BinaryName" }
    expect(PS1).toMatch(/if\s*\(-not\s*\(Test-Path\s+\$extracted\)\)\s*\{\s*throw\s+"Archive did not contain \$BinaryName"/)
  })

  test("the temp dir (altimate_install_$PID) is removed in a finally block", () => {
    expect(PS1).toContain('"altimate_install_$PID"')
    // finally { Remove-Item -Recurse -Force -Path $tmpDir ... } → cleanup runs even on throw.
    expect(PS1).toMatch(/\}\s*finally\s*\{[\s\S]*?Remove-Item\s+-Recurse\s+-Force\s+-Path\s+\$tmpDir/)
  })

  test("the missing-exe throw is positioned inside the try whose finally cleans up", () => {
    const throwIdx = PS1.indexOf("Archive did not contain")
    const finallyIdx = PS1.indexOf("} finally {")
    const cleanupIdx = PS1.indexOf("Remove-Item -Recurse -Force -Path $tmpDir")
    expect(throwIdx).toBeGreaterThan(-1)
    expect(finallyIdx).toBeGreaterThan(throwIdx)
    expect(cleanupIdx).toBeGreaterThan(finallyIdx)
  })
})
