import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import * as realChildProcess from "child_process"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"

const mockExecFile = mock((cmd: string, args: string[], opts: any, cb: Function) => {
  cb(null, "", "")
})

mock.module("child_process", () => ({
  ...realChildProcess,
  execFile: mockExecFile,
}))

const { configure, execDbtShow, execDbtCompile, execDbtCompileInline } = await import("../src/dbt-cli")

const tmpRoot = join(import.meta.dir, ".tmp-release-validation")

describe("dbt-cli release validation: error bubbling", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
    rmSync(tmpRoot, { recursive: true, force: true })
    configure({})
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    configure({})
  })

  test("execDbtShow ignores malformed JSON log fragments and still bubbles the valid structured error", async () => {
    const stdout = [
      "{not complete json",
      JSON.stringify({ info: { level: "info", msg: "Running with dbt=1.9.0" } }),
      JSON.stringify({ info: { level: "error", msg: "Database Error: syntax error at or near \"from\"" } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, stdout, "")
    })

    await expect(execDbtShow("select * from")).rejects.toThrow('Database Error: syntax error at or near "from"')
  })

  test("execDbtShow redacts Command-failed fallback when exit code is a string", async () => {
    const sensitiveSql = "select 'release_validation_secret' as token"

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error(`Command failed: dbt show --inline ${sensitiveSql} --output json`)
      err.code = "EX_CONFIG"
      cb(err, "", "")
    })

    const caught = (await execDbtShow(sensitiveSql).catch((e) => e)) as Error
    expect(caught.message).toBe("dbt show failed: dbt failed: EX_CONFIG")
    expect(caught.message).not.toContain("release_validation_secret")
    expect(caught.message).not.toContain("--inline")
  })

  test("execDbtShow has a safe fallback for non-zero exits with no stderr, code, or signal", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(new Error("Command failed: dbt show --inline select 1"), "", "")
    })

    await expect(execDbtShow("select 1")).rejects.toThrow("dbt show failed: dbt failed (no exit code reported)")
  })

  test("execDbtCompileInline strips ANSI SGR codes from stderr, not just structured stdout", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, "", "\u001b[31mCompilation Error\u001b[0m: undefined macro")
    })

    const caught = (await execDbtCompileInline("select {{ missing_macro() }}").catch((e) => e)) as Error
    expect(caught.message).toBe("Compilation Error: undefined macro")
    expect(caught.message).not.toContain("\u001b[")
  })

  test.todo("BUG: execDbtCompile should not return stale manifest SQL after the current dbt compile fails", async () => {
    const projectRoot = tmpRoot
    mkdirSync(join(projectRoot, "target"), { recursive: true })
    writeFileSync(
      join(projectRoot, "target", "manifest.json"),
      JSON.stringify({
        nodes: {
          "model.project.orders": {
            name: "orders",
            compiled_code: "select * from stale_previous_compile",
          },
        },
      }),
    )
    configure({ projectRoot })

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, "", "Compilation Error: model orders depends on a missing source")
    })

    await expect(execDbtCompile("orders")).rejects.toThrow("Compilation Error: model orders depends on a missing source")
  })
})
