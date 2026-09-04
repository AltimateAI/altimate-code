/**
 * The CI codegen-reproducibility step whitelists exactly ONE known tsc
 * failure (#1148). "tsc exited nonzero" alone would silently whitelist any
 * new TypeScript regression in the regenerated SDK — so the gate compares
 * the exact diagnostic set, and these tests drive the gate script with
 * synthetic logs to lock that exclusivity.
 */
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = join(import.meta.dir, "../../sdk/js/script/check-known-tsc-failure.sh")
const KNOWN = `src/v2/client.ts(2,15): error TS2305: Module '"./gen/types.gen.js"' has no exported member 'FileSystemEntry'.`
const TSC_TAIL = `error: "tsc" exited with code 2`

function run(log: string): number {
  const dir = mkdtempSync(join(tmpdir(), "tsc-wl-"))
  try {
    const p = join(dir, "build.log")
    writeFileSync(p, log)
    return spawnSync("bash", [script, p]).status ?? -1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("check-known-tsc-failure.sh", () => {
  it("accepts a log whose only diagnostic is the known #1148 error", () => {
    expect(run(`${KNOWN}\n${TSC_TAIL}\n`)).toBe(0)
  })

  it("accepts the REAL log shape: raw diagnostic plus build.ts's JSON-stringified echo of it", () => {
    // build.ts dumps the failing command's stdout/stderr as escaped JSON —
    // the same diagnostic appears twice in different quoting. Only the
    // column-0 tsc-emitted line may count, or the exact-set check double-fails.
    const echo = `   stdout: "src/v2/client.ts(2,15): error TS2305: Module '\\"./gen/types.gen.js\\"' has no exported member 'FileSystemEntry'.\\n",`
    const echo2 = `   stderr: "error: \\"tsc\\" exited with code 2\\n",`
    expect(run(`${KNOWN}\n${TSC_TAIL}\n${echo}\n${echo2}\n`)).toBe(0)
  })

  it("accepts line-number drift on the known diagnostic", () => {
    const drifted = KNOWN.replace("(2,15)", "(7,3)")
    expect(run(`${drifted}\n${TSC_TAIL}\n`)).toBe(0)
  })

  it("rejects the known diagnostic accompanied by a NEW one", () => {
    const extra = `src/v2/other.ts(1,1): error TS2551: Property 'x' does not exist on type 'Y'.`
    expect(run(`${KNOWN}\n${extra}\n${TSC_TAIL}\n`)).toBe(3)
  })

  it("rejects a different single diagnostic", () => {
    const other = `src/v2/client.ts(2,15): error TS2724: '"./gen/types.gen.js"' has no exported member named 'FileSystemEntryX'.`
    expect(run(`${other}\n${TSC_TAIL}\n`)).toBe(3)
  })

  it("rejects a tsc-stage failure carrying no diagnostics at all", () => {
    expect(run(`${TSC_TAIL}\n`)).toBe(3)
  })

  it("rejects a non-tsc failure (e.g. prettier)", () => {
    expect(run(`error: "prettier" exited with code 1\n`)).toBe(2)
  })
})
