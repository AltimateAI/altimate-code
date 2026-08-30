// Harness reliability (c) unit gates — idle-done detection, the run-mode-only
// FALLBACK termination path. Every hard precondition is exercised:
//   (i)   green verify temporally AFTER the last file mutation (event-stream order)
//   (ii)  generic verify classification (configured command or positive build/test/check evidence;
//         classifier contains no vertical tokens — leak-lens hard requirement)
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

describe("IdleDone.isReadOnlyCommand (generic classifier, .ii)", () => {
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

  test("git global options are skipped before classifying the subcommand", () => {
    expect(IdleDone.isReadOnlyCommand("git -C /repo status")).toBe(true)
    expect(IdleDone.isReadOnlyCommand("git --git-dir /repo/.git log -1")).toBe(true)
    expect(IdleDone.isReadOnlyCommand("git -C /repo commit -m x")).toBe(false)
  })

  test("leading env assignments are skipped when classifying the head", () => {
    expect(IdleDone.isReadOnlyCommand("FOO=1 cat x")).toBe(true)
    expect(IdleDone.isReadOnlyCommand("FOO=1 make check")).toBe(false)
  })

  // Classifying by command head alone misses in-place and redirection forms.
  // Snapshot patch parts normally catch bash writes, but `snapshot: false`
  // emits none, and an unrecorded write leaves the mutation watermark stale.
  test("in-place editor flags are mutating even though the head is read-only", () => {
    for (const cmd of ["sed -i '' 's/a/b/' src/app.ts", "sed -i.bak s/a/b/ f.txt"]) {
      // `sed` is on the read-only allowlist, so the head alone says "no write".
      expect(IdleDone.isReadOnlyCommand(cmd)).toBe(true)
      expect(IdleDone.isMutatingCommand(cmd)).toBe(true)
    }
    expect(IdleDone.isMutatingCommand("perl -i -pe 's/a/b/' f.txt")).toBe(true)
  })

  test("output redirection is mutating; fd duplication is not", () => {
    expect(IdleDone.isMutatingCommand("cat a.txt > b.txt")).toBe(true)
    expect(IdleDone.isMutatingCommand("echo hi >> log.txt")).toBe(true)
    expect(IdleDone.isMutatingCommand("ls | tee out.txt")).toBe(true)
    expect(IdleDone.isMutatingCommand("make check 2>&1")).toBe(false)
  })

  // altimate_change start — PR #1171 review (cubic P1 + cursor Medium, two
  // threads): the old lookbehind rejected any `>` preceded by a digit or `&`,
  // so real file writes through a numbered descriptor were classified
  // non-mutating and a stale green verification kept satisfying the idle-done
  // gate.
  test("numbered-descriptor redirection to a file is mutating", () => {
    expect(IdleDone.isMutatingCommand("cat input 2>error.log")).toBe(true)
    expect(IdleDone.isMutatingCommand("make test 2> errors.log")).toBe(true)
    expect(IdleDone.isMutatingCommand("build 1> out.txt")).toBe(true)
    expect(IdleDone.isMutatingCommand("build &> out.txt")).toBe(true)
  })

  test("fd duplication is still excluded", () => {
    expect(IdleDone.isMutatingCommand("make check 2>&1")).toBe(false)
    expect(IdleDone.isMutatingCommand("echo hi >&2")).toBe(false)
    expect(IdleDone.isMutatingCommand("run 2>&1 | grep x")).toBe(false)
  })
  // altimate_change end

  test("always-writing heads are mutating anywhere in the pipeline", () => {
    expect(IdleDone.isMutatingCommand("ls && rm -rf build")).toBe(true)
    expect(IdleDone.isMutatingCommand("mkdir -p out")).toBe(true)
    expect(IdleDone.isMutatingCommand("FOO=1 mv a b")).toBe(true)
  })

  test("plain read-only commands are not mutating", () => {
    for (const cmd of ["ls -la", "cat file.txt", "grep -r pattern .", "git status", "sed s/a/b/ f.txt"]) {
      expect(IdleDone.isMutatingCommand(cmd)).toBe(false)
    }
  })

  test("fallback verification requires positive generic evidence", () => {
    for (const command of ["make check", "npm test", "bun run typecheck", "cargo build", "./scripts/verify.sh --all"]) {
      expect(IdleDone.isVerificationCommand(command)).toBe(true)
    }
    for (const command of [
      "deploy production",
      "install package",
      "./scripts/release.sh",
      "custom-wrapper --all",
      "test -f package.json",
      "npm test || true",
      "npm test | cat",
      "npm test &",
    ]) {
      expect(IdleDone.isVerificationCommand(command)).toBe(false)
    }
  })

  test("classifier and module contain no vertical/product tokens (leak-lens hard requirement)", async () => {
    const source = await Bun.file(new URL("../../src/cli/cmd/idle-done.ts", import.meta.url).pathname).text()
    // No dbt/vertical string matching inside the generic mechanism, and no bench
    // task command strings in product code.
    expect(/\bdbt\b/i.test(source)).toBe(false)
    expect(source).not.toContain("--profiles-dir")
  })
})

describe("IdleDone hard preconditions", () => {
  test("fully-satisfied signature arms the challenge", () => {
    expect(satisfied().shouldChallenge()).toBe(true)
  })

  // altimate_change start — upstream_fix regression: lastMutationSeq starts at
  // -1, so a session that never mutated a file (read-only/explore, or one that
  // only ever ran verify commands) satisfied "verify after last write"
  // vacuously — there was no completed work for the green verify to confirm.
  test("(i) NEVER fires when no mutation was ever observed, even with a green verify", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(bashPart("m_verify", "./scripts/verify.sh --all", 0))
    d.observePart(stepFinish("m_verify"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    d.observePart(stepFinish("m_idle1"))
    d.observePart(stepFinish("m_idle2"))
    d.observePart(stepFinish("m_idle3"))
    expect(d.shouldChallenge()).toBe(false)
  })
  // altimate_change end

  // altimate_change start — PR #1171 review: with snapshots off, an
  // `apply_patch` write left the mutation watermark untouched because only the
  // snapshot `patch` PART was classified as a mutation, never the tool itself.
  test("(i) an apply_patch after the verify blocks the challenge with no patch part", () => {
    const applyPatchPart = (messageID: string): IdleDone.PartSlice => ({
      id: pid(),
      messageID,
      type: "tool",
      tool: "apply_patch",
      state: { status: "completed", input: {} },
    })
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m_work"))
    d.observePart(patchPart("m_work"))
    d.observePart(stepFinish("m_work"))
    d.observePart(bashPart("m_verify", "./scripts/verify.sh --all", 0))
    d.observePart(stepFinish("m_verify"))
    d.observePart(applyPatchPart("m_apply"))
    d.observePart(stepFinish("m_apply"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m_idle1", "m_idle2", "m_idle3"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
  })

  // altimate_change — PR #1171 review: with no verify command configured, EVERY
  // non-read-only command was a verification candidate, so a zero-exit `rm`
  // stood in as green verification evidence (and the MUTATING_HEADS branch was
  // unreachable). A mutator is now a mutation, never a verification.
  test("(ii) a zero-exit destructive command is a mutation, not a verification", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m_work"))
    d.observePart(patchPart("m_work"))
    d.observePart(stepFinish("m_work"))
    d.observePart(bashPart("m_verify", "./scripts/verify.sh --all", 0))
    d.observePart(stepFinish("m_verify"))
    // Succeeds, but proves nothing about the deliverable — and it wrote.
    d.observePart(bashPart("m_rm", "rm -rf build", 0))
    d.observePart(stepFinish("m_rm"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m_idle1", "m_idle2", "m_idle3"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
  })

  test("(ii) an unknown zero-exit command is not verification evidence", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m_work"))
    d.observePart(stepFinish("m_work"))
    d.observePart(bashPart("m_unknown", "deploy production", 0))
    d.observePart(stepFinish("m_unknown"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m_idle1", "m_idle2", "m_idle3"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
    expect(d.snapshot().last_verify_green).toBe(false)
  })

  test("(ii) a green POSIX test expression is not project verification evidence", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m_work"))
    d.observePart(stepFinish("m_work"))
    d.observePart(bashPart("m_expression", "test -f package.json", 0))
    d.observePart(stepFinish("m_expression"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m_idle1", "m_idle2", "m_idle3"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
    expect(d.snapshot().last_verify_green).toBe(false)
  })
  // altimate_change end

  // Snapshots off (`snapshot: false`) means no patch part reports a
  // bash-mediated write, so the in-place edit below is the only evidence that
  // the session changed a file after its last green verification.
  test("(i) an in-place bash edit after the verify blocks the challenge with no patch part", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m_work"))
    d.observePart(patchPart("m_work"))
    d.observePart(stepFinish("m_work"))
    d.observePart(bashPart("m_verify", "./scripts/verify.sh --all", 0))
    d.observePart(stepFinish("m_verify"))
    // A write that produces no patch part and whose head is on the read-only list.
    d.observePart(bashPart("m_sed", "sed -i '' 's/a/b/' src/app.ts", 0))
    d.observePart(stepFinish("m_sed"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m_idle1", "m_idle2", "m_idle3"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
    // The write was recorded, and it postdates the verification.
    const snap = d.snapshot()
    expect(snap.last_mutation_seq).toBeGreaterThan(snap.last_verify_seq)
  })

  test("(ii) a configured verify command that redirects its output is still the verification", () => {
    const opts: IdleDone.Options = { ...OPTS, verifyCommand: "make check" }
    const d = IdleDone.create(opts, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m_work"))
    d.observePart(patchPart("m_work"))
    d.observePart(stepFinish("m_work"))
    d.observePart(bashPart("m_verify", "make check > build.log", 0))
    d.observePart(stepFinish("m_verify"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m_idle1", "m_idle2", "m_idle3"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(true)
  })

  test("(ii) a configured verifier cannot mask its failure with shell control flow", () => {
    const opts: IdleDone.Options = { ...OPTS, verifyCommand: "make check" }
    const d = IdleDone.create(opts, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m_work"))
    d.observePart(stepFinish("m_work"))
    d.observePart(bashPart("m_masked", "make check || true", 0))
    d.observePart(stepFinish("m_masked"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m_idle1", "m_idle2", "m_idle3"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(false)
    expect(d.snapshot().last_verify_green).toBe(false)
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

  // Production emits the step-finish part FIRST and the snapshot `patch` part
  // immediately after it (session/processor.ts writes step-finish, then diffs the
  // snapshot), so the two tests below drive the detector in that real order — the
  // helpers above emit the patch before step-finish, which would mask an ordering
  // regression in the mutation/verify comparison.
  test("(i) production ordering: patch AFTER its own step-finish still precedes a later verify", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m_work"))
    d.observePart(stepFinish("m_work"))
    d.observePart(patchPart("m_work")) // step-end snapshot diff, as production emits it
    d.observePart(bashPart("m_verify", "./scripts/verify.sh --all", 0))
    d.observePart(stepFinish("m_verify"))
    d.observePart(stepFinish("cmp_1"))
    d.observePart(stepFinish("cmp_2"))
    for (const m of ["m_idle1", "m_idle2", "m_idle3"]) d.observePart(stepFinish(m))
    expect(d.shouldChallenge()).toBe(true)
  })

  test("(i) production ordering: a same-step patch emitted after step-finish still suppresses", () => {
    const d = IdleDone.create(OPTS, deps(["cmp_1", "cmp_2"]))
    d.observePart(editPart("m1"))
    d.observePart(bashPart("m1", "make check", 0)) // verify inside the mutating step
    d.observePart(stepFinish("m1"))
    d.observePart(patchPart("m1")) // snapshot diff lands after step-finish
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
    // A mutation must exist before a green verify can satisfy the
    // build-after-last-write precondition (i) — this test isolates the
    // idle-streak-reset behavior, not the mutation precondition itself.
    d.observePart(editPart("m_work"))
    d.observePart(stepFinish("m_work"))
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
