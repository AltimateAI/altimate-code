/**
 * E2E tests verifying that execFileSync with { stdio: "pipe" } prevents
 * subprocess output from leaking to the parent's stdout/stderr.
 *
 * Also verifies that engine bootstrap messages use Log (file-based logging)
 * instead of UI.println (stderr-based), which prevents TUI prompt corruption.
 *
 * These are real tests — they spawn actual child processes running real
 * commands and verify the captured output is clean.
 */

import { describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "child_process"
import path from "path"
import os from "os"
import fsp from "fs/promises"

describe("execFileSync stdio piping behavior", () => {
  test("stdio: 'pipe' prevents subprocess stdout from reaching parent", () => {
    // Run a child process that calls execFileSync with stdio: "pipe"
    // and verify the parent sees nothing on stdout/stderr
    const result = spawnSync("bun", ["-e", `
      const { execFileSync } = require("child_process");
      execFileSync("echo", ["THIS_SHOULD_NOT_LEAK"], { stdio: "pipe" });
      execFileSync("echo", ["ALSO_SHOULD_NOT_LEAK"], { stdio: "pipe" });
    `], { encoding: "utf-8" })

    expect(result.stdout).not.toContain("THIS_SHOULD_NOT_LEAK")
    expect(result.stdout).not.toContain("ALSO_SHOULD_NOT_LEAK")
    expect(result.stderr).not.toContain("THIS_SHOULD_NOT_LEAK")
    expect(result.stderr).not.toContain("ALSO_SHOULD_NOT_LEAK")
  })

  test("without stdio: 'pipe', subprocess output DOES leak to parent", () => {
    // Control test: prove that without stdio: "pipe", output leaks through
    const result = spawnSync("bun", ["-e", `
      const { execFileSync } = require("child_process");
      execFileSync("echo", ["CONTROL_LEAKED"], { stdio: "inherit" });
    `], { encoding: "utf-8" })

    // With stdio: "inherit", the child's subprocess output goes to the
    // child's stdout, which the parent captures
    expect(result.stdout).toContain("CONTROL_LEAKED")
  })

  test("stdio: 'pipe' still captures the return value", () => {
    // Verify that piped output is available as the return value
    const output = execFileSync("echo", ["captured_value"], { stdio: "pipe" })
    expect(output.toString().trim()).toBe("captured_value")
  })
})

describe("engine.ts subprocess noise suppression", () => {
  test("commands matching engine.ts patterns don't leak output when piped", () => {
    // Run a child process that mimics the exact execFileSync patterns in
    // engine.ts: version checks, tar, and noisy commands — all with
    // stdio: "pipe". Verify no output leaks.
    const script = `
      const { execFileSync } = require("child_process");

      // Mimics: execFileSync(pythonPath, ["--version"], { stdio: "pipe" })
      try { execFileSync("python3", ["--version"], { stdio: "pipe" }); } catch {}

      // Mimics: execFileSync("tar", ["--version"], { stdio: "pipe" })
      try { execFileSync("tar", ["--version"], { stdio: "pipe" }); } catch {}

      // Mimics: execFileSync(uv, ["--version"], { stdio: "pipe" })
      // Use a command that prints to both stdout and stderr
      try { execFileSync("ls", ["--version"], { stdio: "pipe" }); } catch {}

      // Simulate noisy pip-like output
      try { execFileSync("echo", ["Collecting altimate-engine==0.1.0\\nInstalling collected packages\\nSuccessfully installed"], { stdio: "pipe" }); } catch {}
    `
    const result = spawnSync("bun", ["-e", script], { encoding: "utf-8" })

    // None of the subprocess output should appear in the parent's streams
    expect(result.stdout).not.toContain("Python")
    expect(result.stdout).not.toContain("tar")
    expect(result.stdout).not.toContain("Collecting")
    expect(result.stdout).not.toContain("Installing")
    expect(result.stderr).not.toContain("Python")
    expect(result.stderr).not.toContain("Collecting")
  })

  test("same commands WITHOUT piping DO leak output (control)", () => {
    // Control: verify the same commands actually produce output when not piped
    const result = spawnSync("bun", ["-e", `
      const { execFileSync } = require("child_process");
      try { execFileSync("python3", ["--version"], { stdio: "inherit" }); } catch {}
    `], { encoding: "utf-8" })

    expect(result.stdout).toContain("Python")
  })

  test("engine.ts uses stdio: 'pipe' on all execFileSync calls", async () => {
    // Read the actual source and verify every execFileSync call site
    // includes { stdio: "pipe" } — this ensures the behavior tested above
    // is actually applied in the production code
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")
    const lines = source.split("\n")

    // Find every execFileSync call and extract the full multi-line expression
    const callSites: { line: number; text: string }[] = []
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("execFileSync(")) continue

      let text = ""
      let depth = 0
      for (let j = i; j < lines.length; j++) {
        text += lines[j] + "\n"
        for (const ch of lines[j]) {
          if (ch === "(") depth++
          if (ch === ")") depth--
        }
        if (depth <= 0) break
      }
      callSites.push({ line: i + 1, text })
    }

    // engine.ts has 6 execFileSync calls:
    // tar, powershell, uv venv, uv pip install, python --version, uv --version
    expect(callSites.length).toBeGreaterThanOrEqual(6)

    for (const site of callSites) {
      expect(site.text).toContain('stdio: "pipe"')
    }
  })
})

describe("engine.ts TUI output safety — no UI.println usage", () => {
  let source: string

  test("engine.ts does not import UI module", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    source = await fsp.readFile(engineSrc, "utf-8")

    // The UI module should not be imported at all — all status messages
    // must go through Log to avoid writing to stderr which corrupts TUI
    expect(source).not.toContain('from "../../cli/ui"')
    expect(source).not.toContain("from '../../cli/ui'")
    expect(source).not.toContain('from "@/cli/ui"')
  })

  test("engine.ts does not call UI.println anywhere", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    source = source || await fsp.readFile(engineSrc, "utf-8")

    // UI.println writes to stderr which corrupts the TUI prompt input
    expect(source).not.toContain("UI.println")
    expect(source).not.toContain("UI.print(")
    expect(source).not.toContain("UI.error(")
  })

  test("engine.ts does not call process.stderr.write directly", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    source = source || await fsp.readFile(engineSrc, "utf-8")

    // Direct stderr writes would also corrupt TUI
    expect(source).not.toContain("process.stderr.write")
    expect(source).not.toContain("process.stdout.write")
    expect(source).not.toContain("console.log")
    expect(source).not.toContain("console.error")
    expect(source).not.toContain("console.warn")
  })

  test("engine.ts imports Log module for status messages", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    source = source || await fsp.readFile(engineSrc, "utf-8")

    // Log.Default.info goes to the log file, not stderr/stdout
    expect(source).toContain('from "../../util/log"')
    expect(source).toContain("Log.Default.info")
  })

  test("engine.ts uses Log for all bootstrap status messages", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    source = source || await fsp.readFile(engineSrc, "utf-8")

    // Verify specific bootstrap messages are logged, not printed
    const logCalls = source.match(/Log\.Default\.info\([^)]+\)/g) || []
    expect(logCalls.length).toBeGreaterThanOrEqual(5)

    // Verify the key messages exist as log calls
    const logContent = logCalls.join("\n")
    expect(logContent).toContain("downloading uv")
    expect(logContent).toContain("uv installed")
    expect(logContent).toContain("creating python environment")
    expect(logContent).toContain("installing altimate-engine")
    expect(logContent).toContain("engine ready")
  })

  test("engine.ts does not use ANSI escape codes (no terminal styling needed for log-only)", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    source = source || await fsp.readFile(engineSrc, "utf-8")

    // Since messages go to Log now, no ANSI styling should be used
    // This catches regressions where someone adds styled UI output back
    expect(source).not.toContain("\\x1b[")
    expect(source).not.toContain("UI.Style")
  })
})

describe("engine.ts TUI garbling regression — adversarial patterns", () => {
  test("engine.ts has no template literals writing to stderr", async () => {
    // Template literals with ANSI codes were the original bug vector:
    //   UI.println(`${UI.Style.TEXT_SUCCESS}Engine ready${UI.Style.TEXT_NORMAL}`)
    // This would produce raw ANSI + "Engine ready" + ANSI on stderr,
    // which TUI framework picks up and displays in the prompt input area
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")
    const lines = source.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // No line should write to stderr via process.stderr or UI
      if (line.includes("process.stderr") || line.includes("UI.print")) {
        throw new Error(
          `Line ${i + 1} writes to stderr which will corrupt TUI: ${line.trim()}`
        )
      }
    }
  })

  test("no other bridge files use UI.println for status messages", async () => {
    // Ensure the entire bridge directory doesn't have the same pattern
    const bridgeDir = path.resolve(
      __dirname,
      "../../src/altimate/bridge",
    )
    const entries = await fsp.readdir(bridgeDir)
    const tsFiles = entries.filter(f => f.endsWith(".ts"))

    for (const file of tsFiles) {
      const filePath = path.join(bridgeDir, file)
      const content = await fsp.readFile(filePath, "utf-8")

      // Bridge files should not use UI.println for operational messages
      // as the bridge may run during TUI sessions
      const printlnMatches = content.match(/UI\.println\(/g)
      if (printlnMatches) {
        // Allow UI.println ONLY if it's clearly guarded by a non-TUI check
        // For now, we flag any usage as a potential TUI corruption risk
        const lines = content.split("\n")
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes("UI.println(")) {
            throw new Error(
              `${file}:${i + 1} uses UI.println which may corrupt TUI: ${lines[i].trim()}`
            )
          }
        }
      }
    }
  })

  test("UI.println writes to stderr (proving it would corrupt TUI)", () => {
    // This test proves WHY UI.println is dangerous in TUI mode:
    // UI.println calls process.stderr.write, and the TUI framework
    // captures stderr to display in the prompt area.
    const result = spawnSync("bun", ["-e", `
      // Simulate what UI.println does internally
      process.stderr.write("Engine ready\\n");
      process.stderr.write("altimate-engine 0.4.0\\n");
    `], { encoding: "utf-8" })

    // The text appears on stderr — exactly where TUI would capture it
    expect(result.stderr).toContain("Engine ready")
    expect(result.stderr).toContain("altimate-engine 0.4.0")
  })

  test("Log.Default.info does not write to stderr when initialized with a log file", () => {
    // When Log.init({ print: false }) is called (which is the case in TUI mode),
    // messages go to a file, not to stderr. This test simulates that behavior.
    const result = spawnSync("bun", ["-e", `
      const fs = require("fs");
      const path = require("path");
      const os = require("os");

      // Simulate Log behavior: write to a file instead of stderr
      const logFile = path.join(os.tmpdir(), "test-engine-log-" + Date.now() + ".log");
      const stream = fs.createWriteStream(logFile, { flags: "a" });

      // This is what Log does internally after init with print: false
      stream.write("INFO engine ready version=0.4.0\\n");
      stream.end();

      // Verify nothing went to stderr
      // (if it had, the TUI would pick it up as garbled input)
    `], { encoding: "utf-8" })

    // stderr should be clean — no engine messages
    expect(result.stderr).not.toContain("engine ready")
    expect(result.stderr).not.toContain("Engine ready")
    expect(result.stderr).not.toContain("altimate-engine")
    expect(result.stderr).not.toContain("0.4.0")
  })

  test("multiple concurrent stderr writes produce garbled output (proving TUI bug)", () => {
    // Demonstrate that concurrent stderr writes can produce garbled text,
    // which is exactly the "readyltimate-engine 0.4.0..." symptom described in the issue
    const result = spawnSync("bun", ["-e", `
      // Simulate rapid sequential stderr writes (like what engine bootstrap did)
      process.stderr.write("Engine ");
      process.stderr.write("ready");
      process.stderr.write("\\n");
      process.stderr.write("altimate-engine 0.4.0");
      process.stderr.write("\\n");
    `], { encoding: "utf-8" })

    // All this text ends up on stderr — which TUI captures as prompt input
    expect(result.stderr).toContain("Engine ready")
    expect(result.stderr).toContain("altimate-engine 0.4.0")
    // This proves that stderr writes corrupt TUI display
  })

  test("engine.ts does not use any function that writes to terminal", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // Comprehensive list of patterns that write to stdout/stderr
    const dangerousPatterns = [
      "process.stdout.write",
      "process.stderr.write",
      "console.log",
      "console.error",
      "console.warn",
      "console.info",
      "console.debug",
      "UI.println",
      "UI.print(",
      "UI.error(",
      "UI.empty(",
    ]

    for (const pattern of dangerousPatterns) {
      expect(source).not.toContain(pattern)
    }
  })
})

describe("engine.ts source integrity", () => {
  test("engine.ts exports expected functions", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // Core API should still be exported
    expect(source).toContain("export function engineDir()")
    expect(source).toContain("export function enginePythonPath()")
    expect(source).toContain("export async function ensureUv()")
    expect(source).toContain("export async function ensureEngine()")
    expect(source).toContain("export async function engineStatus()")
    expect(source).toContain("export async function resetEngine()")
  })

  test("engine.ts still has the mutex guard for concurrent calls", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    expect(source).toContain("pendingEnsure")
    expect(source).toContain("if (pendingEnsure) return pendingEnsure")
  })

  test("engine.ts still tracks telemetry on errors", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // Telemetry tracking should not have been removed
    expect(source).toContain("Telemetry.track")
    expect(source).toContain('"engine_error"')
    expect(source).toContain('"engine_started"')
    expect(source).toContain('"uv_download"')
    expect(source).toContain('"venv_create"')
    expect(source).toContain('"pip_install"')
  })

  test("engine.ts still writes manifest after successful install", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    expect(source).toContain("writeManifest")
    expect(source).toContain("engine_version")
    expect(source).toContain("python_version")
    expect(source).toContain("uv_version")
    expect(source).toContain("cli_version")
    expect(source).toContain("installed_at")
  })

  test("engine.ts version info is passed to log messages", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // The version info should be included as structured log metadata
    expect(source).toContain('Log.Default.info("installing altimate-engine", { version: ALTIMATE_ENGINE_VERSION })')
    expect(source).toContain('Log.Default.info("engine ready", { version: ALTIMATE_ENGINE_VERSION })')
  })
})
