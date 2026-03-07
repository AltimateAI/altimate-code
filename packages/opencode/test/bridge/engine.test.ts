/**
 * E2E tests verifying that execFileSync with { stdio: "pipe" } prevents
 * subprocess output from leaking to the parent's stdout/stderr.
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
