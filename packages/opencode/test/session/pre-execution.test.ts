import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SessionPreExecution } from "../../src/session/pre-execution"

async function tmpdir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "pre-exec-scope-"))
}

describe("workspace classification", () => {
  test("a dbt_project.yml at the root classifies as dbt", async () => {
    const dir = await tmpdir()
    await fs.writeFile(path.join(dir, "dbt_project.yml"), "name: demo\n")
    expect(await SessionPreExecution.classifyWorkspace([dir])).toBe("dbt")
  })

  // Benchmark and monorepo layouts nest the project one level down; the shared
  // findDbtProjectRoot rule already covers that and this gate must inherit it,
  // otherwise a real dbt task would be misread as question-answering.
  test("a dbt_project.yml one level down still classifies as dbt", async () => {
    const dir = await tmpdir()
    await fs.mkdir(path.join(dir, "warehouse"))
    await fs.writeFile(path.join(dir, "warehouse", "dbt_project.yml"), "name: demo\n")
    expect(await SessionPreExecution.classifyWorkspace([dir])).toBe("dbt")
  })

  test("a readable directory with no dbt project classifies as non-dbt", async () => {
    const dir = await tmpdir()
    await fs.writeFile(path.join(dir, "questions.duckdb"), "")
    expect(await SessionPreExecution.classifyWorkspace([dir])).toBe("non-dbt")
  })

  // The two-directory case: the cwd may be a plain subfolder of a dbt project.
  test("any readable candidate carrying a project wins", async () => {
    const root = await tmpdir()
    await fs.writeFile(path.join(root, "dbt_project.yml"), "name: demo\n")
    const cwd = path.join(root, "analyses")
    await fs.mkdir(cwd)
    expect(await SessionPreExecution.classifyWorkspace([cwd, root])).toBe("dbt")
  })

  // The load-bearing case. `findDbtProjectRoot` returns null both for "no
  // project here" and for "could not read this directory"; collapsing those
  // would silently drop the protocol whenever the filesystem misbehaved.
  test("a directory that does not exist is unknown, never non-dbt", async () => {
    const dir = await tmpdir()
    const missing = path.join(dir, "gone")
    expect(await SessionPreExecution.classifyWorkspace([missing])).toBe("unknown")
  })

  test("no candidates at all is unknown", async () => {
    expect(await SessionPreExecution.classifyWorkspace([])).toBe("unknown")
    expect(await SessionPreExecution.classifyWorkspace([undefined, ""])).toBe("unknown")
  })

  // A non-git project sets worktree to the filesystem root. Scanning it is
  // meaningless, and it must not count as the readable directory that licenses
  // a non-dbt verdict on its own.
  test("the filesystem root is not a candidate", async () => {
    const root = path.parse(process.cwd()).root
    expect(await SessionPreExecution.classifyWorkspace([root])).toBe("unknown")
  })

  test("an unreadable candidate does not license a non-dbt verdict from its partner", async () => {
    const dir = await tmpdir()
    await fs.writeFile(path.join(dir, "dbt_project.yml"), "name: demo\n")
    expect(await SessionPreExecution.classifyWorkspace([path.join(dir, "nope"), dir])).toBe("dbt")
  })

  // A directory named dbt_project.yml is not a dbt project.
  test("a dbt_project.yml directory is not a project", async () => {
    const dir = await tmpdir()
    await fs.mkdir(path.join(dir, "dbt_project.yml"))
    expect(await SessionPreExecution.classifyWorkspace([dir])).toBe("non-dbt")
  })
})

describe("pre-execution protocol gate", () => {
  // The ONLY combination that drops the protocol is the one the ablation
  // measured: headless, builder, no dbt project in the workspace.
  test("headless builder in a non-dbt workspace drops the protocol", async () => {
    const dir = await tmpdir()
    expect(
      await SessionPreExecution.preExecutionInstruction({ runMode: true, agent: "builder", directories: [dir] }),
    ).toBeUndefined()
  })

  test("headless builder in a dbt workspace keeps it", async () => {
    const dir = await tmpdir()
    await fs.writeFile(path.join(dir, "dbt_project.yml"), "name: demo\n")
    const instruction = await SessionPreExecution.preExecutionInstruction({
      runMode: true,
      agent: "builder",
      directories: [dir],
    })
    expect(instruction).toBe(SessionPreExecution.PRE_EXECUTION_PROTOCOL)
  })

  // Interactive chat is a builder surface the ablation never covered, so it is
  // unchanged from before this PR regardless of what the workspace looks like.
  test("interactive builder always keeps it, dbt project or not", async () => {
    const dir = await tmpdir()
    expect(
      await SessionPreExecution.preExecutionInstruction({ runMode: false, agent: "builder", directories: [dir] }),
    ).toBe(SessionPreExecution.PRE_EXECUTION_PROTOCOL)
  })

  // Ambiguity keeps the protocol. Wrongly dropping it has an unmeasured cost;
  // wrongly keeping it costs latency on one workload.
  test("an unclassifiable workspace keeps it", async () => {
    const dir = await tmpdir()
    expect(
      await SessionPreExecution.preExecutionInstruction({
        runMode: true,
        agent: "builder",
        directories: [path.join(dir, "does-not-exist")],
      }),
    ).toBe(SessionPreExecution.PRE_EXECUTION_PROTOCOL)
    expect(
      await SessionPreExecution.preExecutionInstruction({ runMode: true, agent: "builder", directories: [] }),
    ).toBe(SessionPreExecution.PRE_EXECUTION_PROTOCOL)
  })

  // Only builder.txt ever carried this section, so injecting it for analyst or
  // reviewer would be a new instruction, not a preserved one.
  test("no other agent receives the protocol", async () => {
    const dir = await tmpdir()
    for (const agent of ["analyst", "reviewer", "plan", "general"]) {
      expect(
        await SessionPreExecution.preExecutionInstruction({ runMode: false, agent, directories: [dir] }),
      ).toBeUndefined()
      expect(
        await SessionPreExecution.preExecutionInstruction({ runMode: true, agent, directories: [dir] }),
      ).toBeUndefined()
    }
  })
})

describe("prompt text fidelity", () => {
  // The injected text must be byte-identical to what builder.txt shipped, so
  // that every kept case produces the same resolved prompt as before.
  test("the injected protocol is verbatim the section that was removed", async () => {
    const expected = [
      "## Pre-Execution Protocol",
      "",
      "Before executing ANY SQL via sql_execute, follow this mandatory sequence:",
    ].join("\n")
    expect(SessionPreExecution.PRE_EXECUTION_PROTOCOL.startsWith(expected)).toBe(true)
    expect(SessionPreExecution.PRE_EXECUTION_PROTOCOL).toContain("This sequence is NOT optional.")
    expect(SessionPreExecution.PRE_EXECUTION_PROTOCOL).toContain("altimate_core_validate")
    expect(SessionPreExecution.PRE_EXECUTION_PROTOCOL).toContain("sql_analyze")
    expect(SessionPreExecution.PRE_EXECUTION_PROTOCOL.endsWith("still validate syntax.")).toBe(true)
  })

  // If the section came back into the static prompt file the gate would be a
  // no-op and every surface would carry it again.
  test("the builder prompt file no longer carries the section", async () => {
    const prompt = await Bun.file(new URL("../../src/altimate/prompts/builder.txt", import.meta.url).pathname).text()
    expect(prompt).not.toContain("## Pre-Execution Protocol")
    expect(prompt).not.toContain("This sequence is NOT optional.")
    // The neighbouring sections must survive — only the one section moved.
    expect(prompt).toContain("## dbt Verification Workflow")
    expect(prompt).toContain("## Finish Protocol (mandatory before ending any build/fix task)")
  })

  // The Finish Protocol is a SECOND mandatory ritual in the same family, added
  // after the binary the ablation measured was built. It is deliberately left
  // alone: no measurement covers it, and this PR does not speak to it.
  test("the Finish Protocol is untouched by this change", async () => {
    const prompt = await Bun.file(new URL("../../src/altimate/prompts/builder.txt", import.meta.url).pathname).text()
    expect(prompt).toContain("Re-read the task's literal requirements")
    expect(prompt).toContain("Run the final build and tests")
  })

  test("prompt assembly wires the gate to the run-mode flag and both directories", async () => {
    const prompt = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url).pathname).text()
    expect(prompt).toMatch(
      /SessionPreExecution\.preExecutionInstruction\(\{\s*runMode: Flag\.ALTIMATE_RUN_MODE,\s*agent: agent\.name,\s*directories: \[Instance\.directory, Instance\.worktree\],\s*\}\)/,
    )
    expect(prompt).toMatch(/if \(preExecutionInstruction\) system\.push\(preExecutionInstruction\)/)
  })
})
