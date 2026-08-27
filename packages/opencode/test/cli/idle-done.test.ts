// Harness plan W2.1(c) unit gates — idle-done detection, the run-mode-only
// FALLBACK termination path. Every hard precondition is exercised:
//   (i)   green verify temporally AFTER the last file mutation (event-stream order)
//   (ii)  generic verify classification (configured command or side-effecting bash;
//         classifier contains no vertical tokens — Global rule 4)
//   (iii) suppression while tools/subagents/permissions are outstanding
//   (iv)  compaction-gated + N consecutive post-compaction text-only turns
//   (v)   one-shot recursion guard
import { describe, expect, test } from "bun:test"
import { IdleDone } from "../../src/cli/cmd/idle-done"

const OPTS: IdleDone.Options = { enabled: true, minCompactions: 2, idleTurns: 3 }
const deps = (compactionIDs: string[] = []) => ({
  isCompactionStep: (id: string) => compactionIDs.includes(id),
})

let partCounter = 0
function pid() {
  return `prt_${++partCounter}`
}

function bashPart(messageID: string, command: string, exit: number): IdleDone.PartSlice {
  return {
    id: pid(),
    messageID,
    type: "tool",
    tool: "bash",
    state: { status: "completed", input: { command }, metadata: { exit } },
  }
}
function editPart(messageID: string): IdleDone.PartSlice {
  return { id: pid(), messageID, type: "tool", tool: "edit", state: { status: "completed", input: {} } }
}
function patchPart(messageID: string): IdleDone.PartSlice {
  return { id: pid(), messageID, type: "patch" }
}
function stepFinish(messageID: string, reason = "stop"): IdleDone.PartSlice {
  return { id: pid(), messageID, type: "step-finish", reason }
}

/** Drive a detector into the fully-satisfied state, returning it. */
function satisfied(options: IdleDone.Options = OPTS) {
  const d = IdleDone.create(options, deps(["cmp_1", "cmp_2"]))
  // Work turn: edit, then (in a LATER step) a green side-effecting verify.
  d.observePart(editPart("m_work"))
  d.observePart(patchPart("m_work"))
  d.observePart(stepFinish("m_work"))
  d.observePart(bashPart("m_verify", "./scripts/verify.sh --all", 0))
  d.observePart(stepFinish("m_verify"))
  // Two completed compaction cycles.
  d.observePart(stepFinish("cmp_1"))
  d.observePart(stepFinish("cmp_2"))
  // Three post-compaction text-only turns (the churn signature).
  d.observePart(stepFinish("m_idle1"))
  d.observePart(stepFinish("m_idle2"))
  d.observePart(stepFinish("m_idle3"))
  return d
}

describe("IdleDone.optionsFromEnv (config-exposed thresholds)", () => {
  test("defaults: enabled, minCompactions=2, idleTurns=3, no verify command", () => {
    expect(IdleDone.optionsFromEnv({})).toEqual({
      enabled: true,
      minCompactions: 2,
      idleTurns: 3,
      verifyCommand: undefined,
    })
  })

  test("env overrides win; ALTIMATE_RUN_IDLE_DONE=0 disables", () => {
    const opts = IdleDone.optionsFromEnv({
      ALTIMATE_RUN_IDLE_DONE: "0",
      ALTIMATE_IDLE_DONE_MIN_COMPACTIONS: "5",
      ALTIMATE_IDLE_DONE_IDLE_TURNS: "7",
      ALTIMATE_RUN_VERIFY_COMMAND: "make check",
    })
    expect(opts).toEqual({ enabled: false, minCompactions: 5, idleTurns: 7, verifyCommand: "make check" })
  })

  test("garbage threshold values fall back to defaults", () => {
    const opts = IdleDone.optionsFromEnv({
      ALTIMATE_IDLE_DONE_MIN_COMPACTIONS: "zero",
      ALTIMATE_IDLE_DONE_IDLE_TURNS: "-3",
    })
    expect(opts.minCompactions).toBe(2)
    expect(opts.idleTurns).toBe(3)
  })
})

describe("IdleDone.armedOptions (run-mode/attach arming gate)", () => {
  const base: IdleDone.Options = { enabled: true, minCompactions: 2, idleTurns: 3 }

  test("armed only for a local run with run mode active", () => {
    expect(IdleDone.armedOptions(base, { attach: false, runMode: true }).enabled).toBe(true)
  })

  test("regression: explicit ALTIMATE_RUN_MODE=0 opt-out disarms idle-done", () => {
    // The run handler preserves an explicit "0" (applyRunModeDefault) so the
    // flag reads false — idle-done must never arm in that session.
    expect(IdleDone.armedOptions(base, { attach: false, runMode: false }).enabled).toBe(false)
  })

  test("regression: --attach disarms idle-done regardless of run mode", () => {
    // The remote (possibly shared/interactive) session must never be aborted
    // by the local idle-done challenge.
    expect(IdleDone.armedOptions(base, { attach: true, runMode: true }).enabled).toBe(false)
    expect(IdleDone.armedOptions(base, { attach: true, runMode: false }).enabled).toBe(false)
  })

  test("an env-disabled fallback can never be re-enabled by the gate", () => {
    const disabled: IdleDone.Options = { ...base, enabled: false }
    expect(IdleDone.armedOptions(disabled, { attach: false, runMode: true }).enabled).toBe(false)
  })

  test("a disarmed detector never challenges even when every precondition holds", () => {
    // Same event sequence that arms the fully-satisfied detector above.
    expect(satisfied().shouldChallenge()).toBe(true)
    expect(satisfied(IdleDone.armedOptions(base, { attach: false, runMode: false })).shouldChallenge()).toBe(false)
    expect(satisfied(IdleDone.armedOptions(base, { attach: true, runMode: true })).shouldChallenge()).toBe(false)
  })
})

describe("IdleDone.isReadOnlyCommand (generic classifier, W2.1c.ii)", () => {
  test("plain read-only commands are read-only", () => {
    for (const cmd of ["ls -la", "cat file.txt", "grep -r pattern .", "pwd", "git status", "git log --oneline -5"]) {
      expect(IdleDone.isReadOnlyCommand(cmd)).toBe(true)
    }
  })

  test("pipelines of read-only heads stay read-only", () => {
    expect(IdleDone.isReadOnlyCommand("cat log.txt | grep ERROR | wc -l")).toBe(true)
    expect(IdleDone.isReadOnlyCommand("ls && pwd; git status")).toBe(true)
  })

  test("build/test/run-shaped commands are side-effecting", () => {
    for (const cmd of ["make check", "npm test", "python3 run_tests.py", "./verify.sh", "cargo build"]) {
      expect(IdleDone.isReadOnlyCommand(cmd)).toBe(false)
    }
  })

  test("a read-only head with a mutating tail statement is side-effecting", () => {
    expect(IdleDone.isReadOnlyCommand("ls && rm -rf build")).toBe(false)
  })

  test("mutating git subcommands are side-effecting", () => {
    expect(IdleDone.isReadOnlyCommand("git commit -m x")).toBe(false)
    expect(IdleDone.isReadOnlyCommand("git push")).toBe(false)
  })

  test("leading env assignments are skipped when classifying the head", () => {
    expect(IdleDone.isReadOnlyCommand("FOO=1 cat x")).toBe(true)
    expect(IdleDone.isReadOnlyCommand("FOO=1 make check")).toBe(false)
  })

  test("classifier and module contain no vertical/product tokens (Global rule 4)", async () => {
    const source = await Bun.file(new URL("../../src/cli/cmd/idle-done.ts", import.meta.url).pathname).text()
    // No dbt/vertical string matching inside the generic mechanism, and no bench
    // task command strings in product code.
    expect(/\bdbt\b/i.test(source)).toBe(false)
    expect(source).not.toContain("--profiles-dir")
  })
})

describe("IdleDone hard preconditions (W2.1c)", () => {
  test("fully-satisfied signature arms the challenge", () => {
    expect(satisfied().shouldChallenge()).toBe(true)
  })

  test("(iv) NEVER fires in a never-compacted session", () => {
    const d = IdleDone.create(OPTS, deps([]))
    d.observePart(editPart("m1"))
    d.observePart(bashPart("m2", "make check", 0))
    d.observePart(stepFinish("m2"))
    for (const m of ["m3", "m4", "m5", "m6"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
  })

  test("(iv) one compaction is not enough at minCompactions=2", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1"]))
    d.observePart(bashPart("m_verify", "make check", 0))
    d.observePart(stepFinish("m_verify"))
    d.observePart(stepFinish("cmp_1"))
    for (const m of ["m3", "m4", "m5"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
  })

  test("(iv) fewer than idleTurns consecutive text-only turns is not enough", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(bashPart("m_verify", "make check", 0))
    d.observePart(stepFinish("m_verify"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    d.observePart(stepFinish("m_idle1"))
    d.observePart(stepFinish("m_idle2"))
    expect(d.shouldChallenge()).toBe(false)
  })

  test("a tool-using turn resets the consecutive idle-turn counter", () => {
    const d = satisfied()
    expect(d.shouldChallenge()).toBe(true)
    // A turn with tool activity breaks the streak…
    d.observePart(bashPart("m_active", "grep -r foo .", 0))
    d.observePart(stepFinish("m_active"))
    expect(d.shouldChallenge()).toBe(false)
    // …and three more idle turns re-arm it.
    for (const m of ["m_i4", "m_i5", "m_i6"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(true)
  })

  test("(i) verify BEFORE the last mutation does not certify: build-after-last-write", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(bashPart("m1", "make check", 0)) // green verify…
    d.observePart(stepFinish("m1"))
    d.observePart(editPart("m2")) // …then a mutation AFTER it
    d.observePart(patchPart("m2"))
    d.observePart(stepFinish("m2"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m3", "m4", "m5"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
  })

  test("(i) a patch part (bash-mediated mutation ground truth) after the verify suppresses", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    // Verify and mutation land in the SAME step: the step's patch part postdates
    // the verify in stream order, so ordering within the step cannot be proven
    // and the detector conservatively suppresses.
    d.observePart(editPart("m1"))
    d.observePart(bashPart("m1", "make check", 0))
    d.observePart(patchPart("m1"))
    d.observePart(stepFinish("m1"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m2", "m3", "m4"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
  })

  test("(i)/(ii) a FAILING most-recent verify blocks the challenge", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m1"))
    d.observePart(stepFinish("m1"))
    d.observePart(bashPart("m2", "make check", 0))
    d.observePart(stepFinish("m2"))
    d.observePart(bashPart("m3", "make check", 2)) // most recent verify is RED
    d.observePart(stepFinish("m3"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m4", "m5", "m6"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
  })

  test("(ii) read-only bash (ls/git status) never counts as a green verify", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m1"))
    d.observePart(stepFinish("m1"))
    d.observePart(bashPart("m2", "ls -la", 0))
    d.observePart(bashPart("m2", "git status", 0))
    d.observePart(stepFinish("m2"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m3", "m4", "m5"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
  })

  test("(ii) configured verify command restricts candidates to that command", () => {
    const opts: IdleDone.Options = { ...OPTS, verifyCommand: "./scripts/verify.sh" }
    const d = IdleDone.create(opts, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m1"))
    d.observePart(stepFinish("m1"))
    // A green side-effecting command that is NOT the configured verify: ignored.
    d.observePart(bashPart("m2", "make check", 0))
    d.observePart(stepFinish("m2"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m3", "m4", "m5"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
    // The configured command going green in a later step satisfies (i)+(ii).
    d.observePart(bashPart("m6", "./scripts/verify.sh --all", 0))
    d.observePart(stepFinish("m6"))
    for (const m of ["m7", "m8", "m9"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(true)
  })

  test("(iii) an outstanding running tool (e.g. a task subagent) suppresses", () => {
    const d = satisfied()
    d.observePart({ id: "prt_task", messageID: "m_bg", type: "tool", tool: "task", state: { status: "running" } })
    expect(d.shouldChallenge()).toBe(false)
    d.observePart({ id: "prt_task", messageID: "m_bg", type: "tool", tool: "task", state: { status: "completed" } })
    // The completing subagent turn resets the idle streak; re-idle to re-arm.
    for (const m of ["m_i7", "m_i8", "m_i9"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(true)
  })

  test("(iii) a pending permission request suppresses until resolved", () => {
    const d = satisfied()
    d.onPermissionAsked("perm_1")
    expect(d.shouldChallenge()).toBe(false)
    d.onPermissionResolved("perm_1")
    expect(d.shouldChallenge()).toBe(true)
  })

  test("(v) one-shot: after the challenge is issued it can never re-arm", () => {
    const d = satisfied()
    expect(d.shouldChallenge()).toBe(true)
    d.markChallengeIssued()
    expect(d.shouldChallenge()).toBe(false)
    for (const m of ["m_x1", "m_x2", "m_x3", "m_x4"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
    expect(d.challengeIssued).toBe(true)
  })

  test("disabled via config: never arms even when fully satisfied", () => {
    const d = satisfied({ ...OPTS, enabled: false })
    expect(d.shouldChallenge()).toBe(false)
  })

  test("compaction step-finishes reset the idle streak (idle turns are per-cycle)", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(bashPart("m_verify", "make check", 0))
    d.observePart(stepFinish("m_verify"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("m_idle1"))
    d.observePart(stepFinish("m_idle2"))
    d.observePart(stepFinish("cmp_2")) // another compaction mid-streak
    d.observePart(stepFinish("m_idle3"))
    expect(d.shouldChallenge()).toBe(false) // streak restarted after cmp_2
    d.observePart(stepFinish("m_idle4"))
    d.observePart(stepFinish("m_idle5"))
    expect(d.shouldChallenge()).toBe(true)
  })

  test("non-stop finish reasons do not count as idle turns", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(bashPart("m_verify", "make check", 0))
    d.observePart(stepFinish("m_verify"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    d.observePart(stepFinish("m1", "length"))
    d.observePart(stepFinish("m2", "length"))
    d.observePart(stepFinish("m3", "length"))
    expect(d.shouldChallenge()).toBe(false)
  })
})
