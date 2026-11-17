/**
 * Every TypeScript CI job decides pass/fail with script/github/check-bun-test-summary.sh, which
 * parses bun's summary lines instead of its exit code (bun can segfault on exit after passing).
 * These tests drive the script with synthetic `bun test` output so a parsing change cannot
 * silently turn a failing run green.
 */
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = join(import.meta.dir, "../../../script/github/check-bun-test-summary.sh")

function run(...outputs: string[]): number {
  const dir = mkdtempSync(join(tmpdir(), "bun-summary-"))
  try {
    const files = outputs.map((output, i) => {
      const file = join(dir, `run-${i}.txt`)
      writeFileSync(file, output)
      return file
    })
    return spawnSync("bash", [script, ...files]).status ?? -1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const summary = (pass: number, fail: number, extra = "") =>
  `(pass) a > b [1.00ms]\n\n ${pass} pass\n 3 skip\n ${fail} fail\n${extra}Ran ${pass + fail + 3} tests across 2 files. [1.00s]\n`

describe("check-bun-test-summary.sh", () => {
  it("passes a run with passing tests and no failures", () => {
    expect(run(summary(12, 0))).toBe(0)
  })

  it("passes several clean runs together", () => {
    expect(run(summary(12, 0), summary(3, 0))).toBe(0)
  })

  it("passes a run that crashed on exit after its summary (bun's cleanup segfault)", () => {
    expect(run(summary(12, 0) + "Segmentation fault (core dumped)\n")).toBe(0)
  })

  it("fails a run with a failed test", () => {
    expect(run(summary(11, 1))).toBe(1)
  })

  it("fails when any one of several runs failed", () => {
    expect(run(summary(12, 0), summary(2, 1))).toBe(1)
  })

  it("fails a run with an error outside a test", () => {
    expect(run(summary(12, 0, " 1 error\n"))).toBe(1)
    expect(run(summary(12, 0, " 2 errors\n"))).toBe(1)
  })

  it("fails a run that printed no summary (bun crashed before finishing)", () => {
    expect(run(summary(12, 0), "(pass) a > b [1.00ms]\nSegmentation fault\n")).toBe(1)
  })

  it("fails when nothing passed", () => {
    expect(run(summary(0, 0))).toBe(1)
  })

  it("does not count test names that end in pass or fail", () => {
    expect(run(`(pass) handles 3 fail\n${summary(4, 0)}`)).toBe(0)
  })

  it("rejects a call with no output files", () => {
    expect(run()).toBe(2)
  })
})
