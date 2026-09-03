import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { SessionPreExecution } from "../../src/session/pre-execution"
import { PromptProfiles } from "../../src/altimate/prompts/profiles"

/**
 * `fs.symlink`'s `"dir"` type link requires elevated privileges (or Developer
 * Mode) on Windows; `"junction"` does not and works for the absolute
 * directory targets these tests use. Everywhere else `"dir"` is correct.
 */
const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir"

describe("workspace classification", () => {
  test("a dbt_project.yml at the root classifies as dbt", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "dbt_project.yml"), "name: demo\n")
    expect(await SessionPreExecution.classifyWorkspace([dir.path])).toBe("dbt")
  })

  // Benchmark and monorepo layouts nest the project one level down; this gate
  // inherits `findDbtProjectRoot`'s rule and skip list, otherwise a real dbt
  // task would be misread as question-answering.
  test("a dbt_project.yml one level down still classifies as dbt", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, "warehouse"))
    await fs.writeFile(path.join(dir.path, "warehouse", "dbt_project.yml"), "name: demo\n")
    expect(await SessionPreExecution.classifyWorkspace([dir.path])).toBe("dbt")
  })

  // The load-bearing safety fix: `findDbtProjectRoot` (and the pre-rework
  // version of this scan) only checked ONE level below the candidate. A real
  // monorepo dbt project nested deeper — e.g. `repo/platform/analytics/
  // dbt_project.yml` when the candidate is `repo` — was silently classified
  // `non-dbt`, dropping the mandatory protocol on actual dbt work. This test
  // fails against the single-level scan and must keep passing against any
  // future change to the downward walk.
  test("a dbt_project.yml nested three levels down still classifies as dbt", async () => {
    await using dir = await tmpdir()
    const nested = path.join(dir.path, "platform", "analytics", "warehouse")
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(nested, "dbt_project.yml"), "name: demo\n")
    expect(await SessionPreExecution.classifyWorkspace([dir.path])).toBe("dbt")
  })

  // A project past the downward scan bound is not found — but that must
  // report `unknown` (keep the protocol), never a confident `non-dbt`, since
  // the scan genuinely did not look that far.
  test("a project past the downward scan bound is unknown, not non-dbt", async () => {
    await using dir = await tmpdir()
    const tooDeep = path.join(dir.path, "a", "b", "c", "d", "e", "f")
    await fs.mkdir(tooDeep, { recursive: true })
    await fs.writeFile(path.join(tooDeep, "dbt_project.yml"), "name: demo\n")
    expect(await SessionPreExecution.classifyWorkspace([dir.path])).toBe("unknown")
  })

  test("a readable directory with no dbt project classifies as non-dbt", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "questions.duckdb"), "")
    expect(await SessionPreExecution.classifyWorkspace([dir.path])).toBe("non-dbt")
  })

  // The two-directory case: the cwd may be a plain subfolder of a dbt project.
  test("any readable candidate carrying a project wins", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "dbt_project.yml"), "name: demo\n")
    const cwd = path.join(root.path, "analyses")
    await fs.mkdir(cwd)
    expect(await SessionPreExecution.classifyWorkspace([cwd, root.path])).toBe("dbt")
  })

  // The load-bearing case. A scan that collapses "no project here" and "could
  // not look here" into one answer silently drops the protocol whenever the
  // filesystem misbehaves.
  test("a directory that does not exist is unknown, never non-dbt", async () => {
    await using dir = await tmpdir()
    const missing = path.join(dir.path, "gone")
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

  // A directory named dbt_project.yml is not a dbt project.
  test("a dbt_project.yml directory is not a project", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, "dbt_project.yml"))
    expect(await SessionPreExecution.classifyWorkspace([dir.path])).toBe("non-dbt")
  })

  test("dbt_project.yaml counts as well as .yml", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "dbt_project.yaml"), "name: demo\n")
    expect(await SessionPreExecution.classifyWorkspace([dir.path])).toBe("dbt")
  })

  // Sessions are routinely started inside `models/` or deeper. On a non-git
  // project the worktree candidate is the same directory, so the ancestor walk
  // is the only thing that finds the project — without it a real dbt session
  // classifies as non-dbt and loses the protocol.
  test("a project above the candidate is found", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "dbt_project.yml"), "name: demo\n")
    const deep = path.join(root.path, "models", "marts", "finance")
    await fs.mkdir(deep, { recursive: true })
    expect(await SessionPreExecution.classifyWorkspace([deep])).toBe("dbt")
  })

  // The walk runs to the filesystem root rather than stopping at a depth
  // limit. A limit would have to report "I stopped early" as unknown to stay
  // honest, which on any deep tree switches the gate off entirely.
  test("the ancestor walk is not depth-limited", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "dbt_project.yml"), "name: demo\n")
    const deep = path.join(root.path, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j")
    await fs.mkdir(deep, { recursive: true })
    expect(await SessionPreExecution.classifyWorkspace([deep])).toBe("dbt")
  })

  // `path.resolve` is lexical. A symlinked cwd would walk the link's own
  // parents and never see the project the session is actually inside.
  test("a symlinked candidate is resolved before the walk", async () => {
    await using project = await tmpdir()
    await fs.writeFile(path.join(project.path, "dbt_project.yml"), "name: demo\n")
    const inner = path.join(project.path, "models")
    await fs.mkdir(inner)
    await using elsewhere = await tmpdir()
    const link = path.join(elsewhere.path, "ws")
    await fs.symlink(inner, link, DIR_LINK_TYPE)
    expect(await SessionPreExecution.classifyWorkspace([link])).toBe("dbt")
  })

  // Filtering children on isDirectory() would skip symlinked directories, and
  // a skipped entry is an unexamined one.
  test("a symlinked child project is found", async () => {
    await using project = await tmpdir()
    await fs.writeFile(path.join(project.path, "dbt_project.yml"), "name: demo\n")
    await using workspace = await tmpdir()
    await fs.symlink(project.path, path.join(workspace.path, "warehouse"), DIR_LINK_TYPE)
    expect(await SessionPreExecution.classifyWorkspace([workspace.path])).toBe("dbt")
  })

  // One completely examined candidate settles it. Its ancestor walk already
  // covers the worktree above it, so a partner that could not be read has
  // nothing left to contribute — and vetoing on it would return unknown for
  // every non-git project, where the worktree candidate is the filesystem root.
  test("a complete candidate is not vetoed by a missing or root-only partner", async () => {
    await using dir = await tmpdir()
    expect(await SessionPreExecution.classifyWorkspace([dir.path, path.join(dir.path, "gone")])).toBe("non-dbt")
    expect(await SessionPreExecution.classifyWorkspace([dir.path, path.parse(dir.path).root])).toBe("non-dbt")
  })

  // The genuinely PERMISSION-unreadable case — the previous test's "missing"
  // and "root" partners are both readable-but-absent, which is a different
  // failure mode from a directory that exists and cannot be opened. Both must
  // fail the same way: the complete partner still wins.
  test("a complete candidate is not vetoed by a genuinely unreadable partner", async () => {
    await using dir = await tmpdir()
    await using other = await tmpdir()
    const locked = path.join(other.path, "locked")
    await fs.mkdir(locked)
    await fs.chmod(locked, 0o000)
    try {
      let enumerable = true
      try {
        await fs.readdir(locked)
      } catch {
        enumerable = false
      }
      // Running as root defeats the permission bit; the assertion is only
      // meaningful when the mode actually blocks the read.
      if (!enumerable) {
        expect(await SessionPreExecution.classifyWorkspace([dir.path, locked])).toBe("non-dbt")
      }
    } finally {
      await fs.chmod(locked, 0o755)
    }
  })

  // The failure that matters most: a directory that stats fine but cannot be
  // enumerated. Collapsing that into "no dbt project" would drop the protocol
  // on a workspace nobody ever looked inside.
  test("a directory that cannot be enumerated is unknown, not non-dbt", async () => {
    await using dir = await tmpdir()
    const locked = path.join(dir.path, "locked")
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
  // measured: headless, builder, stock default prompt, no dbt project.
  test("headless builder in a non-dbt workspace returns the sql-guard-excluded override", async () => {
    await using dir = await tmpdir()
    const override = await SessionPreExecution.scopedBuilderPrompt({
      runMode: true,
      agent: "builder",
      prompt: PromptProfiles.PROMPT_BUILDER,
      directories: [dir.path],
    })
    // Would fail if the gate silently no-ops and returns the default profile.
    expect(override).toBe(PromptProfiles.PROMPT_BUILDER_SCOPED)
    expect(override).not.toContain("## Pre-Execution Protocol")
    expect(override).not.toBe(PromptProfiles.PROMPT_BUILDER)
  })

  test("headless builder in a dbt workspace keeps the default (no override)", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(path.join(dir.path, "dbt_project.yml"), "name: demo\n")
    expect(
      await SessionPreExecution.scopedBuilderPrompt({
        runMode: true,
        agent: "builder",
        prompt: PromptProfiles.PROMPT_BUILDER,
        directories: [dir.path],
      }),
    ).toBeUndefined()
  })

  // Interactive chat is a builder surface the ablation never covered, so it is
  // unchanged from before this PR regardless of what the workspace looks like.
  test("interactive builder always keeps the default (no override), dbt project or not", async () => {
    await using dir = await tmpdir()
    expect(
      await SessionPreExecution.scopedBuilderPrompt({
        runMode: false,
        agent: "builder",
        prompt: PromptProfiles.PROMPT_BUILDER,
        directories: [dir.path],
      }),
    ).toBeUndefined()
  })

  // Ambiguity keeps the protocol. Wrongly dropping it has an unmeasured cost;
  // wrongly keeping it costs latency on one workload.
  test("an unclassifiable workspace keeps the default (no override)", async () => {
    await using dir = await tmpdir()
    expect(
      await SessionPreExecution.scopedBuilderPrompt({
        runMode: true,
        agent: "builder",
        prompt: PromptProfiles.PROMPT_BUILDER,
        directories: [path.join(dir.path, "does-not-exist")],
      }),
    ).toBeUndefined()
    expect(
      await SessionPreExecution.scopedBuilderPrompt({
        runMode: true,
        agent: "builder",
        prompt: PromptProfiles.PROMPT_BUILDER,
        directories: [],
      }),
    ).toBeUndefined()
  })

  // Only the builder profile ever carried this pack, so overriding it for
  // analyst or reviewer would be a behavior change, not a preserved one.
  test("no other agent receives an override", async () => {
    await using dir = await tmpdir()
    for (const agent of ["analyst", "reviewer", "plan", "general"]) {
      expect(
        await SessionPreExecution.scopedBuilderPrompt({
          runMode: false,
          agent,
          prompt: PromptProfiles.PROMPT_BUILDER,
          directories: [dir.path],
        }),
      ).toBeUndefined()
      expect(
        await SessionPreExecution.scopedBuilderPrompt({
          runMode: true,
          agent,
          prompt: PromptProfiles.PROMPT_BUILDER,
          directories: [dir.path],
        }),
      ).toBeUndefined()
    }
  })

  // `agent` here must be the registry KEY, not `Info.name` — config can rename
  // the builder agent's display name (`agent.builder.name`) while it stays
  // registered under the `builder` key. Passing the STRING "renamed-builder"
  // simulates the caller mistakenly keying on a display name.
  test("a builder agent renamed via config is still recognized by its registry key", async () => {
    await using dir = await tmpdir()
    // Simulates prompt.ts passing `lastUser.agent` ("builder", the registry
    // key) even though `agent.name` ("renamed-builder") differs.
    const override = await SessionPreExecution.scopedBuilderPrompt({
      runMode: true,
      agent: "builder",
      prompt: PromptProfiles.PROMPT_BUILDER,
      directories: [dir.path],
    })
    expect(override).toBe(PromptProfiles.PROMPT_BUILDER_SCOPED)
    // The converse: a custom agent merely DISPLAYED as "builder" (its
    // registry key is something else) must never receive the override.
    expect(
      await SessionPreExecution.scopedBuilderPrompt({
        runMode: true,
        agent: "my-custom-agent",
        prompt: PromptProfiles.PROMPT_BUILDER,
        directories: [dir.path],
      }),
    ).toBeUndefined()
  })

  // A customized builder prompt (config override or a markdown agent file)
  // must never be silently discarded in favour of the stock scoped variant —
  // the gate only ever touches the prompt when it is STILL exactly the
  // default, unmodified `PROMPT_BUILDER`.
  test("a customized builder prompt is never overridden, even when every other condition fires", async () => {
    await using dir = await tmpdir()
    const customPrompt = "You are a custom builder agent. Do custom things.\n"
    expect(
      await SessionPreExecution.scopedBuilderPrompt({
        runMode: true,
        agent: "builder",
        prompt: customPrompt,
        directories: [dir.path],
      }),
    ).toBeUndefined()
    // Sanity: the identical scenario WITH the stock prompt does fire, so the
    // above isn't passing because some other condition failed to hold.
    expect(
      await SessionPreExecution.scopedBuilderPrompt({
        runMode: true,
        agent: "builder",
        prompt: PromptProfiles.PROMPT_BUILDER,
        directories: [dir.path],
      }),
    ).toBe(PromptProfiles.PROMPT_BUILDER_SCOPED)
  })

  // Even the ALREADY-scoped prompt (e.g. a second pass, or a caller reusing a
  // previous result as input) must not be treated as "the default" — only
  // byte-identical `PROMPT_BUILDER` qualifies.
  test("the scoped prompt itself does not count as the default", async () => {
    await using dir = await tmpdir()
    expect(
      await SessionPreExecution.scopedBuilderPrompt({
        runMode: true,
        agent: "builder",
        prompt: PromptProfiles.PROMPT_BUILDER_SCOPED,
        directories: [dir.path],
      }),
    ).toBeUndefined()
  })
})

describe("scoped-prompt cache (hot-path fix)", () => {
  // `classifyWorkspace`'s filesystem walk must not re-run on every call once
  // cached — proven here by giving the SECOND call a directory that would
  // classify differently, and asserting it still returns the FIRST call's
  // answer. If the cache silently no-ops (recomputes every call), this fails:
  // the second call would legitimately see the dbt project and return
  // `undefined` instead of the first call's override.
  test("memoizes across calls — a differing second call is never actually consulted", async () => {
    await using nonDbtDir = await tmpdir()
    await using dbtDir = await tmpdir()
    await fs.writeFile(path.join(dbtDir.path, "dbt_project.yml"), "name: demo\n")

    const getScopedBuilderPrompt = SessionPreExecution.createScopedBuilderPromptCache()
    const first = await getScopedBuilderPrompt({
      runMode: true,
      agent: "builder",
      prompt: PromptProfiles.PROMPT_BUILDER,
      directories: [nonDbtDir.path],
    })
    const second = await getScopedBuilderPrompt({
      runMode: true,
      agent: "builder",
      prompt: PromptProfiles.PROMPT_BUILDER,
      directories: [dbtDir.path],
    })
    expect(first).toBe(PromptProfiles.PROMPT_BUILDER_SCOPED)
    expect(second).toBe(first)
  })

  // A fresh cache instance (a new loop() invocation, i.e. a new turn) must
  // recompute independently — proving the memoization is per-instance, not a
  // module-level cache that would go stale across turns.
  test("a fresh cache instance recomputes independently of any prior instance", async () => {
    await using dbtDir = await tmpdir()
    await fs.writeFile(path.join(dbtDir.path, "dbt_project.yml"), "name: demo\n")

    const first = SessionPreExecution.createScopedBuilderPromptCache()
    await first({
      runMode: true,
      agent: "builder",
      prompt: PromptProfiles.PROMPT_BUILDER,
      directories: [dbtDir.path],
    })

    await using nonDbtDir = await tmpdir()
    const second = SessionPreExecution.createScopedBuilderPromptCache()
    const result = await second({
      runMode: true,
      agent: "builder",
      prompt: PromptProfiles.PROMPT_BUILDER,
      directories: [nonDbtDir.path],
    })
    expect(result).toBe(PromptProfiles.PROMPT_BUILDER_SCOPED)
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

  test("prompt assembly wires the gate to the run-mode flag, the registry key, the current prompt, and both directories", async () => {
    const prompt = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url).pathname).text()
    expect(prompt).toMatch(
      /getScopedBuilderPrompt\(\{\s*runMode: Flag\.ALTIMATE_RUN_MODE,\s*agent: lastUser\.agent,\s*prompt: agent\.prompt,\s*directories: \[Instance\.directory, Instance\.worktree\],\s*\}\)/,
    )
    // The cache must be created once per loop() invocation (before the
    // while-loop that re-enters this call every step), not per step.
    const cacheDeclAt = prompt.indexOf("const getScopedBuilderPrompt = SessionPreExecution.createScopedBuilderPromptCache()")
    const whileLoopAt = prompt.indexOf("while (true) {")
    expect(cacheDeclAt).toBeGreaterThan(-1)
    expect(whileLoopAt).toBeGreaterThan(-1)
    expect(cacheDeclAt).toBeLessThan(whileLoopAt)
    // The override must actually reach the model call (via a cloned agent
    // passed to processor.process), not just be computed and discarded.
    expect(prompt).toMatch(/effectiveAgent = scopedBuilderPrompt \? \{ \.\.\.agent, prompt: scopedBuilderPrompt \} : agent/)
    expect(prompt).toMatch(/agent: effectiveAgent,/)
  })
})
