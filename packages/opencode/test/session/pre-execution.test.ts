import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SessionPreExecution } from "../../src/session/pre-execution"
import { PromptProfiles } from "../../src/altimate/prompts/profiles"

async function tmpdir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "pre-exec-scope-"))
}

describe("workspace classification", () => {
  test("a dbt_project.yml at the root classifies as dbt", async () => {
    const dir = await tmpdir()
    await fs.writeFile(path.join(dir, "dbt_project.yml"), "name: demo\n")
    expect(await SessionPreExecution.classifyWorkspace([dir])).toBe("dbt")
  })

  // Benchmark and monorepo layouts nest the project one level down; this gate
  // inherits `findDbtProjectRoot`'s rule and skip list, otherwise a real dbt
  // task would be misread as question-answering.
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

  // The load-bearing case. A scan that collapses "no project here" and "could
  // not look here" into one answer silently drops the protocol whenever the
  // filesystem misbehaves.
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

  test("a project on one candidate wins even when its partner is unreadable", async () => {
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

  test("dbt_project.yaml counts as well as .yml", async () => {
    const dir = await tmpdir()
    await fs.writeFile(path.join(dir, "dbt_project.yaml"), "name: demo\n")
    expect(await SessionPreExecution.classifyWorkspace([dir])).toBe("dbt")
  })

  // Sessions are routinely started inside `models/` or deeper. On a non-git
  // project the worktree candidate is the same directory, so the ancestor walk
  // is the only thing that finds the project — without it a real dbt session
  // classifies as non-dbt and loses the protocol.
  test("a project above the candidate is found", async () => {
    const root = await tmpdir()
    await fs.writeFile(path.join(root, "dbt_project.yml"), "name: demo\n")
    const deep = path.join(root, "models", "marts", "finance")
    await fs.mkdir(deep, { recursive: true })
    expect(await SessionPreExecution.classifyWorkspace([deep])).toBe("dbt")
  })

  // The walk runs to the filesystem root rather than stopping at a depth
  // limit. A limit would have to report "I stopped early" as unknown to stay
  // honest, which on any deep tree switches the gate off entirely.
  test("the ancestor walk is not depth-limited", async () => {
    const root = await tmpdir()
    await fs.writeFile(path.join(root, "dbt_project.yml"), "name: demo\n")
    const deep = path.join(root, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j")
    await fs.mkdir(deep, { recursive: true })
    expect(await SessionPreExecution.classifyWorkspace([deep])).toBe("dbt")
  })

  // `path.resolve` is lexical. A symlinked cwd would walk the link's own
  // parents and never see the project the session is actually inside.
  test("a symlinked candidate is resolved before the walk", async () => {
    const project = await tmpdir()
    await fs.writeFile(path.join(project, "dbt_project.yml"), "name: demo\n")
    const inner = path.join(project, "models")
    await fs.mkdir(inner)
    const elsewhere = await tmpdir()
    const link = path.join(elsewhere, "ws")
    await fs.symlink(inner, link, "dir")
    expect(await SessionPreExecution.classifyWorkspace([link])).toBe("dbt")
  })

  // Filtering children on isDirectory() would skip symlinked directories, and
  // a skipped entry is an unexamined one.
  test("a symlinked child project is found", async () => {
    const project = await tmpdir()
    await fs.writeFile(path.join(project, "dbt_project.yml"), "name: demo\n")
    const workspace = await tmpdir()
    await fs.symlink(project, path.join(workspace, "warehouse"), "dir")
    expect(await SessionPreExecution.classifyWorkspace([workspace])).toBe("dbt")
  })

  // One completely examined candidate settles it. Its ancestor walk already
  // covers the worktree above it, so a partner that could not be read has
  // nothing left to contribute — and vetoing on it would return unknown for
  // every non-git project, where the worktree candidate is the filesystem root.
  test("a complete candidate is not vetoed by an unreadable partner", async () => {
    const dir = await tmpdir()
    expect(await SessionPreExecution.classifyWorkspace([dir, path.join(dir, "gone")])).toBe("non-dbt")
    expect(await SessionPreExecution.classifyWorkspace([dir, path.parse(dir).root])).toBe("non-dbt")
  })

  // The failure that matters most: a directory that stats fine but cannot be
  // enumerated. Collapsing that into "no dbt project" would drop the protocol
  // on a workspace nobody ever looked inside.
  test("a directory that cannot be enumerated is unknown, not non-dbt", async () => {
    const dir = await tmpdir()
    const locked = path.join(dir, "locked")
    await fs.mkdir(locked)
    await fs.chmod(locked, 0o000)
    try {
      // Running as root defeats the permission bit; the assertion is only
      // meaningful when the mode actually blocks the read.
      let enumerable = true
      try {
        await fs.readdir(locked)
      } catch {
        enumerable = false
      }
      if (enumerable) return
      expect(await SessionPreExecution.classifyWorkspace([locked])).toBe("unknown")
    } finally {
      await fs.chmod(locked, 0o755)
    }
  })
})

// The reworked mechanism (onto PR #1217's pack architecture): the protocol is
// the `sql-guard` pack, and it ships INSIDE the default builder profile
// unconditionally (see test/altimate/prompt-profiles.test.ts for the
// byte-identity pin). `scopedBuilderPrompt` no longer injects text — it
// returns a full prompt OVERRIDE (the profile with sql-guard excluded) for the
// one cell the ablation measured, or `undefined` everywhere else, meaning
// "use the agent's default `.prompt`, unchanged".
describe("pre-execution protocol gate", () => {
  // The ONLY combination that drops the protocol is the one the ablation
  // measured: headless, builder, no dbt project in the workspace.
  test("headless builder in a non-dbt workspace returns the sql-guard-excluded override", async () => {
    const dir = await tmpdir()
    const override = await SessionPreExecution.scopedBuilderPrompt({
      runMode: true,
      agent: "builder",
      directories: [dir],
    })
    // Would fail if the gate silently no-ops and returns the default profile.
    expect(override).toBe(PromptProfiles.PROMPT_BUILDER_SCOPED)
    expect(override).not.toContain("## Pre-Execution Protocol")
    expect(override).not.toBe(PromptProfiles.PROMPT_BUILDER)
  })

  test("headless builder in a dbt workspace keeps the default (no override)", async () => {
    const dir = await tmpdir()
    await fs.writeFile(path.join(dir, "dbt_project.yml"), "name: demo\n")
    expect(
      await SessionPreExecution.scopedBuilderPrompt({ runMode: true, agent: "builder", directories: [dir] }),
    ).toBeUndefined()
  })

  // Interactive chat is a builder surface the ablation never covered, so it is
  // unchanged from before this PR regardless of what the workspace looks like.
  test("interactive builder always keeps the default (no override), dbt project or not", async () => {
    const dir = await tmpdir()
    expect(
      await SessionPreExecution.scopedBuilderPrompt({ runMode: false, agent: "builder", directories: [dir] }),
    ).toBeUndefined()
  })

  // Ambiguity keeps the protocol. Wrongly dropping it has an unmeasured cost;
  // wrongly keeping it costs latency on one workload.
  test("an unclassifiable workspace keeps the default (no override)", async () => {
    const dir = await tmpdir()
    expect(
      await SessionPreExecution.scopedBuilderPrompt({
        runMode: true,
        agent: "builder",
        directories: [path.join(dir, "does-not-exist")],
      }),
    ).toBeUndefined()
    expect(
      await SessionPreExecution.scopedBuilderPrompt({ runMode: true, agent: "builder", directories: [] }),
    ).toBeUndefined()
  })

  // Only the builder profile ever carried this pack, so overriding it for
  // analyst or reviewer would be a behavior change, not a preserved one.
  test("no other agent receives an override", async () => {
    const dir = await tmpdir()
    for (const agent of ["analyst", "reviewer", "plan", "general"]) {
      expect(
        await SessionPreExecution.scopedBuilderPrompt({ runMode: false, agent, directories: [dir] }),
      ).toBeUndefined()
      expect(
        await SessionPreExecution.scopedBuilderPrompt({ runMode: true, agent, directories: [dir] }),
      ).toBeUndefined()
    }
  })
})

describe("prompt override composition", () => {
  // The override must drop ONLY the sql-guard pack — every neighbouring pack
  // (and the invariant core) must survive untouched, otherwise the gate is
  // silently scoping more than the protocol.
  test("PROMPT_BUILDER_SCOPED omits sql-guard and nothing else", () => {
    expect(PromptProfiles.PROMPT_BUILDER_SCOPED).not.toContain("## Pre-Execution Protocol")
    expect(PromptProfiles.PROMPT_BUILDER_SCOPED).not.toContain("This sequence is NOT optional.")
    expect(PromptProfiles.PROMPT_BUILDER_SCOPED).toContain("## dbt Verification Workflow")
    expect(PromptProfiles.PROMPT_BUILDER_SCOPED).toContain("## Finish Protocol")
    expect(PromptProfiles.BUILDER_PROFILE_SCOPED).toEqual(
      PromptProfiles.BUILDER_PROFILE.filter((name) => name !== "sql-guard"),
    )
  })

  // Selecting the override must never perturb the default byte-pinned
  // profile — the two constants are independent, computed once at module load.
  test("computing the override cannot change the default profile bytes", () => {
    void PromptProfiles.PROMPT_BUILDER_SCOPED
    expect(PromptProfiles.PROMPT_BUILDER).toContain("## Pre-Execution Protocol")
  })

  test("prompt assembly wires the gate to the run-mode flag and both directories", async () => {
    const prompt = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url).pathname).text()
    expect(prompt).toMatch(
      /SessionPreExecution\.scopedBuilderPrompt\(\{\s*runMode: Flag\.ALTIMATE_RUN_MODE,\s*agent: agent\.name,\s*directories: \[Instance\.directory, Instance\.worktree\],\s*\}\)/,
    )
    // The override must actually reach the model call (via a cloned agent
    // passed to processor.process), not just be computed and discarded.
    expect(prompt).toMatch(/effectiveAgent = scopedBuilderPrompt \? \{ \.\.\.agent, prompt: scopedBuilderPrompt \} : agent/)
    expect(prompt).toMatch(/agent: effectiveAgent,/)
  })
})
