// Fork-only helper for the `run` command — idle-done detection, the
// RUN-MODE-ONLY FALLBACK termination path.
//
// Explicit model DONE (SessionTermination) is the primary termination path.
// This module detects the completed-but-not-terminating churn signature — a session
// whose work is done (green verify AFTER the last file mutation) but that keeps
// cycling text-only post-compaction turns instead of ending — and arms a ONE-SHOT
// confirm-DONE challenge. It lives under cli/cmd and is wired only by run.ts, so
// TUI/serve behavior is untouched by construction (the
// interactive loop legitimately idles awaiting user input).
//
// HARD preconditions, all required before the challenge may fire:
//   (i)   build-after-last-write ordering FROM THE EVENT STREAM: the most recent
//         verify-candidate bash command completed green (exit 0) at a stream
//         position strictly AFTER the last observed file mutation. Mutations are
//         write/edit tool completions AND snapshot `patch` parts — the patch part
//         is the harness's ground truth for bash-mediated changes (`sed -i`,
//         heredocs) that produce no edit event. "Last build green" alone certifies
//         nothing about the current diff.
//   (ii)  GENERIC verify classification: the project-configured verify command
//         (ALTIMATE_RUN_VERIFY_COMMAND) when set; otherwise the most recent
//         side-effecting bash command (a conservative read-only-head classifier —
//         NO vertical/product tokens). Classifier errs toward
//         "read-only" so a trivial `ls`/`git status` can never count as a verify.
//   (iii) suppressed while ANY tool call (incl. task-tool subagents) is still
//         running or a permission request is pending.
//   (iv)  compaction-gated: at least `minCompactions` completed compaction cycles —
//         idle-done can NEVER fire in a never-compacted session — plus
//         `idleTurns` consecutive post-compaction text-only assistant turns.
//   (v)   one-shot: after the challenge is issued it can never re-arm (recursion
//         guard — the challenge cannot breed further challenges).
//
// Threshold rationale (config-exposed, not fitted to any one workload):
//   minCompactions=2 — one compaction can be a single oversized tool output; two
//     completed cycles with no progress in between is the churn signature.
//   idleTurns=3 — kept small because each candidate turn here already passed the
//     much stronger green-verify-after-last-write precondition.

export namespace IdleDone {
  export interface Options {
    /** Master switch — ALTIMATE_RUN_IDLE_DONE=0 disables the fallback entirely. */
    enabled: boolean
    /** Minimum completed compaction cycles before the fallback may arm. */
    minCompactions: number
    /** Consecutive post-compaction text-only turns required. */
    idleTurns: number
    /** Optional project-configured verify command (prefix match on the bash command). */
    verifyCommand?: string
  }

  export function optionsFromEnv(env: Record<string, string | undefined> = process.env): Options {
    const bound = (name: string, fallback: number) => {
      const raw = env[name]?.trim()
      if (!raw) return fallback
      const parsed = Number(raw)
      return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback
    }
    const enabledRaw = env["ALTIMATE_RUN_IDLE_DONE"]?.trim().toLowerCase()
    return {
      enabled: enabledRaw !== "0" && enabledRaw !== "false",
      minCompactions: bound("ALTIMATE_IDLE_DONE_MIN_COMPACTIONS", 2),
      idleTurns: bound("ALTIMATE_IDLE_DONE_IDLE_TURNS", 3),
      verifyCommand: env["ALTIMATE_RUN_VERIFY_COMMAND"]?.trim() || undefined,
    }
  }

  /**
   * Arming gate for the run command. The fallback may arm ONLY for a local
   * (non-attach) run with run mode active: `--attach` targets a remote,
   * possibly shared/interactive server session where aborting the in-flight
   * prompt is never acceptable, and an explicit `ALTIMATE_RUN_MODE=0` is the
   * documented opt-out for every run-mode-only mechanism (see run/run-mode.ts).
   */
  export function armedOptions(options: Options, gate: { attach: boolean; runMode: boolean }): Options {
    return { ...options, enabled: options.enabled && !gate.attach && gate.runMode }
  }

  // ── Generic bash classifier ───────────────────────────────────────────────
  // Conservative read-only-head allowlist. Direction of safety: a read-only
  // command misclassified as side-effecting could count as a green "verify", so
  // the allowlist is GREEDY — when in doubt a command is read-only and therefore
  // NOT a verify candidate (idle-done then simply never fires). Generic shell
  // vocabulary only — no vertical/product tokens.
  const READ_ONLY_HEADS = new Set([
    "ls",
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "wc",
    "pwd",
    "cd",
    "echo",
    "printf",
    "which",
    "whereis",
    "whoami",
    "date",
    "env",
    "printenv",
    "stat",
    "file",
    "du",
    "df",
    "tree",
    "find",
    "grep",
    "rg",
    "egrep",
    "fgrep",
    "awk",
    "sed",
    "cut",
    "sort",
    "uniq",
    "diff",
    "cmp",
    "md5",
    "md5sum",
    "shasum",
    "sha256sum",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "type",
    "true",
    "false",
    "test",
    "[",
    "sleep",
  ])
  const GIT_READ_ONLY_SUBCOMMANDS = new Set([
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "remote",
    "rev-parse",
    "ls-files",
    "blame",
    "describe",
    "shortlog",
    "config",
  ])

  /** True when every pipeline/statement head in the command is read-only. */
  export function isReadOnlyCommand(command: string): boolean {
    const statements = command
      .split(/&&|\|\||[;|\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (statements.length === 0) return true
    for (const statement of statements) {
      // Skip leading VAR=value assignments and common wrappers.
      const tokens = statement.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
      const head = tokens[0]?.replace(/^\(+/, "")
      if (!head) continue
      if (head === "git") {
        const sub = tokens[1]
        if (!sub || !GIT_READ_ONLY_SUBCOMMANDS.has(sub)) return false
        continue
      }
      if (!READ_ONLY_HEADS.has(head)) return false
    }
    return true
  }

  // Heads that always write, and in-place/redirection forms whose head alone
  // looks read-only (`sed -i file`, `cat a > b`, `... | tee out`).
  //
  // Snapshot patch parts normally report bash-mediated writes, but snapshots
  // are configurable (`snapshot: false`) and produce no patch part when off. A
  // write that goes unrecorded leaves the mutation watermark stale, so an
  // EARLIER green verification still satisfies the build-after-last-write
  // precondition and idle-done can claim nothing happened after it. Classifying
  // by command head alone is what misses these.
  const MUTATING_HEADS = new Set([
    "rm",
    "mv",
    "cp",
    "mkdir",
    "rmdir",
    "touch",
    "ln",
    "install",
    "chmod",
    "chown",
    "truncate",
    "dd",
    "tee",
  ])

  /** True when the command writes to the filesystem through a head, flag, or redirection. */
  export function isMutatingCommand(command: string): boolean {
    // Output redirection to a file. Excludes fd duplication (`2>&1`, `>&2`).
    if (/(?<![0-9&])>>?\s*(?![&|])/.test(command)) return true
    // In-place editors: the head is on the read-only list, the `-i` flag writes.
    if (/\b(?:sed|perl|ruby)\b[^|;&]*\s-[A-Za-z]*i\b/.test(command)) return true
    for (const statement of command.split(/&&|\|\||[;|\n]/)) {
      const tokens = statement
        .trim()
        .split(/\s+/)
        .filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
      const head = tokens[0]?.replace(/^\(+/, "")
      if (head && MUTATING_HEADS.has(head)) return true
    }
    return false
  }

  // Mutation-classified tool names: the harness's own file-writing tools. Patch
  // parts (snapshot diffs) additionally catch bash-mediated mutations.
  const MUTATING_TOOLS = new Set(["write", "edit", "multiedit", "patch"])

  export interface Deps {
    /** From RunAccounting — resolves whether a message belongs to compaction machinery. */
    isCompactionStep(messageID: string): boolean
  }

  // Minimal structural slice of the SDK part event this module consumes.
  export interface PartSlice {
    id: string
    messageID: string
    type: string
    tool?: string
    state?: {
      status?: string
      input?: Record<string, unknown>
      metadata?: Record<string, unknown>
    }
    reason?: string
  }

  export function create(options: Options, deps: Deps) {
    // Monotonic event-stream position; every observed part advances it, so
    // "after" comparisons reflect stream order, not wall clock.
    let seq = 0
    let lastMutationSeq = -1
    let lastVerifySeq = -1
    let lastVerifyGreen = false
    const runningToolParts = new Set<string>()
    const pendingPermissions = new Set<string>()
    const compactionsCompleted = new Set<string>()
    // Tool/patch activity per assistant message, to classify text-only turns.
    const messageHadActivity = new Set<string>()
    let consecutiveIdleTurns = 0
    let challengeIssued = false

    function observeBash(part: PartSlice) {
      const command = typeof part.state?.input?.["command"] === "string" ? (part.state.input["command"] as string) : ""
      const isCandidate = options.verifyCommand
        ? command.trimStart().startsWith(options.verifyCommand)
        : !isReadOnlyCommand(command)
      if (isCandidate) {
        const exit = part.state?.metadata?.["exit"]
        lastVerifySeq = seq
        lastVerifyGreen = exit === 0
        return
      }
      // Not a verification. If it still wrote, advance the mutation watermark —
      // otherwise a stale earlier verify keeps satisfying precondition (i) even
      // though the session changed files after it. Checked after the candidate
      // test so a configured verify command that redirects its own output
      // (`make test > log`) is still counted as the verification it is.
      if (isMutatingCommand(command)) lastMutationSeq = seq
    }

    return {
      /** Feed every message.part.updated event for the session through this. */
      observePart(part: PartSlice) {
        seq++
        if (part.type === "patch") {
          // Snapshot diff: files changed somewhere in this step (ground truth,
          // includes bash-mediated writes). Ordering within the step is unknown,
          // so the patch — emitted at step end — conservatively postdates any
          // verify that ran inside the same step.
          lastMutationSeq = seq
          messageHadActivity.add(part.messageID)
          return
        }
        if (part.type === "tool") {
          const status = part.state?.status
          if (status === "running") {
            runningToolParts.add(part.id)
            return
          }
          if (status !== "completed" && status !== "error") return
          runningToolParts.delete(part.id)
          messageHadActivity.add(part.messageID)
          if (status !== "completed") return
          if (part.tool && MUTATING_TOOLS.has(part.tool)) lastMutationSeq = seq
          if (part.tool === "bash") observeBash(part)
          return
        }
        if (part.type === "step-finish") {
          if (deps.isCompactionStep(part.messageID)) {
            compactionsCompleted.add(part.messageID)
            // A fresh compaction cycle: idle turns are counted per cycle.
            consecutiveIdleTurns = 0
            return
          }
          if (part.reason === "stop" && !messageHadActivity.has(part.messageID)) {
            consecutiveIdleTurns++
          } else {
            consecutiveIdleTurns = 0
          }
        }
      },
      onPermissionAsked(requestID: string) {
        pendingPermissions.add(requestID)
      },
      onPermissionResolved(requestID: string) {
        pendingPermissions.delete(requestID)
      },
      /** All hard preconditions (i)–(v). Evaluate after each observed step-finish. */
      shouldChallenge(): boolean {
        if (!options.enabled) return false
        if (challengeIssued) return false // (v) one-shot recursion guard
        if (compactionsCompleted.size < options.minCompactions) return false // (iv)
        if (consecutiveIdleTurns < options.idleTurns) return false // (iv)
        if (runningToolParts.size > 0) return false // (iii)
        if (pendingPermissions.size > 0) return false // (iii)
        if (!lastVerifyGreen) return false // (i)/(ii)
        // altimate_change start — upstream_fix: lastMutationSeq starts at -1, so a
        // run that never mutated a file (pure read/explore, or a session that
        // only ever verified) satisfied "verify after last write" vacuously —
        // there was no completed work for the green verify to actually confirm.
        if (lastMutationSeq < 0) return false // (i) at least one mutation must exist
        if (lastVerifySeq <= lastMutationSeq) return false // (i) build-after-last-write
        // altimate_change end
        return true
      },
      markChallengeIssued() {
        challengeIssued = true
      },
      get challengeIssued() {
        return challengeIssued
      },
      /** Introspection for logs/telemetry when the challenge fires. */
      snapshot() {
        return {
          compactions: compactionsCompleted.size,
          idle_turns: consecutiveIdleTurns,
          last_mutation_seq: lastMutationSeq,
          last_verify_seq: lastVerifySeq,
          last_verify_green: lastVerifyGreen,
          running_tools: runningToolParts.size,
          pending_permissions: pendingPermissions.size,
        }
      },
    }
  }
  export type Info = ReturnType<typeof create>
}
