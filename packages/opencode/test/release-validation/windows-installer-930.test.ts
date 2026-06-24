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
import { describe, test, expect, afterEach, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { Installation } from "../../src/installation"
import { Telemetry } from "../../src/telemetry"

const REPO_ROOT = join(import.meta.dir, "../../../..")
const PS1 = readFileSync(join(REPO_ROOT, "install.ps1"), "utf-8")
const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// Stub bookkeeping — every test restores these; afterEach is the safety net.
// ---------------------------------------------------------------------------
const ORIG = {
  platform: Object.getOwnPropertyDescriptor(process, "platform")!,
}

function restoreAll() {
  Object.defineProperty(process, "platform", ORIG.platform)
}

afterEach(restoreAll)

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true })
}

type HttpHandler = (
  request: HttpClientRequest.HttpClientRequest,
) => Response | Effect.Effect<Response, unknown>

type SpawnResult = string | { code: number; stdout?: string; stderr?: string }
type SpawnCall = { cmd: string; args: readonly string[]; env?: Record<string, string>; stdin?: unknown }

function mockHttpClient(handler: HttpHandler) {
  const client = HttpClient.make(((request: HttpClientRequest.HttpClientRequest) => {
    const result = handler(request)
    const response = Effect.isEffect(result) ? result : Effect.succeed(result)
    return response.pipe(Effect.map((res) => HttpClientResponse.fromWeb(request, res)))
  }) as any)
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(handler: (call: SpawnCall) => SpawnResult = () => "") {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const call: SpawnCall = {
      cmd: std?.command ?? "",
      args: std?.args ?? [],
      env: std?.options.env as Record<string, string> | undefined,
      stdin: std?.options.stdin,
    }
    const result = handler(call)
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function upgradeWith(input: {
  platform: string
  target?: string
  http?: HttpHandler
  spawn?: (call: SpawnCall) => SpawnResult
}) {
  setPlatform(input.platform)
  const appProcess = AppProcess.layer.pipe(Layer.provide(mockSpawner(input.spawn)))
  const layer = Installation.layer.pipe(
    Layer.provide(
      mockHttpClient(input.http ?? (() => new Response("", { status: 200, statusText: "OK" }))),
    ),
    Layer.provide(appProcess),
  )
  return Effect.runPromise(Installation.use.upgrade("curl", input.target ?? "1.2.3").pipe(Effect.provide(layer)))
}

// ===========================================================================
// GAP 1 — upgrade() dispatches win32 curl-installs to PowerShell, others to bash
// ===========================================================================
describe("upgrade('curl', target) — platform dispatch", () => {
  test("win32 routes to upgradePowershell: powershell + irm install.ps1 | iex, VERSION=target", async () => {
    const spawnCalls: SpawnCall[] = []
    const fetchCalls: Array<{ url: string; method?: string }> = []

    const trackSpy = spyOn(Telemetry, "track").mockImplementation(() => {})
    try {
      await upgradeWith({
        platform: "win32",
        target: "1.2.3",
        http: (request) => {
          fetchCalls.push({ url: request.url, method: (request as any).method })
          return new Response("", { status: 200, statusText: "OK" })
        },
        spawn: (call) => {
          spawnCalls.push(call)
          return { code: 0, stdout: "ok", stderr: "" }
        },
      })
    } finally {
      trackSpy.mockRestore()
    }

    const powershell = spawnCalls.find((call) => call.cmd === "powershell")
    expect(powershell).toBeTruthy()
    const command = [powershell!.cmd, ...powershell!.args].join(" ")
    expect(command).toContain("irm")
    expect(command).toContain("install.ps1 | iex")
    // The target version is piped to the installer via $env:VERSION.
    expect(powershell!.env?.VERSION).toBe("1.2.3")

    // The HEAD probe hit the .ps1 endpoint, not the bash install endpoint.
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe("https://www.altimate.sh/install.ps1")
    expect(fetchCalls[0].method).toBe("HEAD")
  })

  test("non-win32 routes to upgradeCurl: Process.spawn(['bash']) + fetch to /install (no .ps1)", async () => {
    const spawnCalls: SpawnCall[] = []
    const fetchUrls: string[] = []

    const trackSpy = spyOn(Telemetry, "track").mockImplementation(() => {})
    try {
      await upgradeWith({
        platform: "linux",
        target: "1.2.3",
        http: (request) => {
          fetchUrls.push(request.url)
          return new Response("echo install", { status: 200, statusText: "OK" })
        },
        spawn: (call) => {
          spawnCalls.push(call)
          if (call.cmd === "bash" && call.args[0] === "--version") return "GNU bash"
          return { code: 0, stdout: "done", stderr: "" }
        },
      })
    } finally {
      trackSpy.mockRestore()
    }

    const installer = spawnCalls.find((call) => call.cmd === "bash" && call.args.length === 0)
    expect(installer).toBeTruthy()
    expect(installer!.stdin).toBeTruthy()
    // The bash installer is fetched from UPGRADE_INSTALL_URL (the .ps1 host is never touched).
    expect(fetchUrls).toContain("https://www.altimate.sh/install")
    expect(fetchUrls.some((u) => u.endsWith(".ps1"))).toBe(false)
    expect(spawnCalls.some((call) => call.cmd === "powershell")).toBe(false)
  })

  test("darwin (any non-win32) also uses bash, never powershell", async () => {
    const spawnCalls: SpawnCall[] = []

    const trackSpy = spyOn(Telemetry, "track").mockImplementation(() => {})
    try {
      await upgradeWith({
        platform: "darwin",
        target: "2.0.0",
        http: () => new Response("echo install", { status: 200, statusText: "OK" }),
        spawn: (call) => {
          spawnCalls.push(call)
          if (call.cmd === "bash" && call.args[0] === "--version") return "GNU bash"
          return { code: 0, stdout: "", stderr: "" }
        },
      })
    } finally {
      trackSpy.mockRestore()
    }
    expect(spawnCalls.some((call) => call.cmd === "bash" && call.args.length === 0)).toBe(true)
    expect(spawnCalls.some((call) => call.cmd === "powershell")).toBe(false)
  })
})

// ===========================================================================
// GAP 2 — upgradePowershell surfaces a friendly error when the HEAD probe fails
//          (driven through upgrade('curl', ...) on win32)
// ===========================================================================
describe("upgradePowershell — HEAD probe failure surfaces a friendly error, never spawns powershell", () => {
  test("HTTP !ok (503) → Error names URL + 'HTTP 503' + 'irm' recovery; Process.run NOT called", async () => {
    let tracked = 0
    const spawnCalls: SpawnCall[] = []
    const trackSpy = spyOn(Telemetry, "track").mockImplementation(() => {
      tracked++
    })

    let err: unknown
    try {
      await upgradeWith({
        platform: "win32",
        http: () => new Response("", { status: 503, statusText: "Service Unavailable" }),
        spawn: (call) => {
          spawnCalls.push(call)
          return { code: 0, stdout: "", stderr: "" }
        },
      })
    } catch (e) {
      err = e
    } finally {
      trackSpy.mockRestore()
    }

    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain("https://www.altimate.sh/install.ps1")
    expect(msg).toContain("503")
    expect(msg).toContain("irm")
    // It failed at the probe, before any spawn AND before the telemetry block.
    expect(spawnCalls).toHaveLength(0)
    expect(tracked).toBe(0)
  })

  test("AbortSignal.timeout / network reject → Error names the cause; Process.run NOT called", async () => {
    const spawnCalls: SpawnCall[] = []
    const trackSpy = spyOn(Telemetry, "track").mockImplementation(() => {})

    let err: unknown
    try {
      await upgradeWith({
        platform: "win32",
        http: () => Effect.fail(new DOMException("The operation timed out.", "TimeoutError")),
        spawn: (call) => {
          spawnCalls.push(call)
          return { code: 0, stdout: "", stderr: "" }
        },
      })
    } catch (e) {
      err = e
    } finally {
      trackSpy.mockRestore()
    }

    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain("https://www.altimate.sh/install.ps1")
    expect(msg).toContain("The operation timed out.")
    expect(msg).toContain("irm")
    expect(spawnCalls).toHaveLength(0)
  })
})

// ===========================================================================
// GAP 3 — upgradePowershell returns the {code, stdout:Buffer, stderr:Buffer}
//          shape that upgrade() consumes (nothrow). Verified through upgrade().
// ===========================================================================
describe("upgradePowershell result shape is consumed by upgrade()", () => {
  test("success: a {code:0, stdout:Buffer, stderr:Buffer} result completes upgrade() cleanly", async () => {
    let observedResult: SpawnResult | undefined
    let trackedStatus = ""
    const trackSpy = spyOn(Telemetry, "track").mockImplementation((e: any) => {
      trackedStatus = e.status
    })

    try {
      await expect(
        upgradeWith({
          platform: "win32",
          target: "3.0.0",
          spawn: (call) => {
            observedResult = { code: 0, stdout: call.cmd === "powershell" ? "ok" : "", stderr: "" }
            return observedResult
          },
        }),
      ).resolves.toBeUndefined()
    } finally {
      trackSpy.mockRestore()
    }

    expect(typeof (observedResult as any).code).toBe("number")
    expect(trackedStatus).toBe("success")
  })

  test("failure: code:1 with stderr Buffer → UpgradeFailedError(stderr) + telemetry status 'error'", async () => {
    const tracked: any[] = []
    const trackSpy = spyOn(Telemetry, "track").mockImplementation((e: any) => tracked.push(e))

    let err: unknown
    try {
      await upgradeWith({
        platform: "win32",
        target: "1.2.3",
        spawn: (call) =>
          call.cmd === "powershell"
            ? { code: 1, stdout: "", stderr: "powershell not found" }
            : { code: 0, stdout: "", stderr: "" },
      })
    } catch (e) {
      err = e
    } finally {
      trackSpy.mockRestore()
    }

    // The caller sanitizes installer stderr before wrapping it.
    // altimate_change start — upstream v1.17.9 UpgradeFailedError is an Effect Schema.TaggedErrorClass;
    // detect with instanceof (matches src/cli/cmd/upgrade.ts) rather than the removed .isInstance() static.
    expect(err instanceof Installation.UpgradeFailedError).toBe(true)
    // altimate_change end
    expect((err as any).stderr).toBe("Upgrade failed for curl (exit code 1).")

    // An error telemetry event was emitted carrying the sanitized stderr.
    expect(tracked).toHaveLength(1)
    expect(tracked[0].type).toBe("upgrade_attempted")
    expect(tracked[0].status).toBe("error")
    expect(tracked[0].to_version).toBe("1.2.3")
    expect(tracked[0].error).toBe("Upgrade failed for curl (exit code 1).")
    expect(tracked[0].error).not.toContain("powershell not found")
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
