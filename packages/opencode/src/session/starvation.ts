// Fork-only module — write-starvation circuit breaker, signature-hash loop
// detection, unchanged-read annotation, and the re-keyed doom-loop escalation
// ladder.
//
// Design constraints:
//   - ANNOTATE-ONLY BY DEFAULT: directive injection and any hard consequence are
//     config-gated OFF (`mode: "annotate"`) until validation shows no session
//     class regresses. In annotate mode the harness only logs
//     breaker-would-fire events and appends informational annotations.
//   - Directives are OUTCOME-NEUTRAL and always carry a DONE alternative — never
//     an unconditional "produce the edit now" (fabricated-edit risk on read-only
//     / review / analysis tasks).
//   - GENERIC classifiers only. Mutation evidence comes from file-mutation tool
//     completions and the harness snapshot diff (patch parts) — no command-string
//     matching, no vertical/tool-vendor tokens anywhere in this file (enforced
//     by a source-scan guard in the unit tests).
//   - Unchanged-read detection is by CONTENT HASH at read time; generated paths
//     are exempt; the annotation NEVER suppresses content.
//   - Doom-loop counting is keyed on (toolName + normalized args) — the legacy
//     per-NAME counter is telemetry only (legitimate multi-step work routinely
//     crosses a name-only counter). Escalation ladder: nudge → forced
//     status-check → stop; never straight to stop.
//   - Armed behavior is run-mode-only and skipped for plan/review-class agents;
//     directive delivery goes through the NudgeArbiter (one directive per turn).
import { createHash } from "node:crypto"

export namespace SessionStarvation {
  export type Mode = "off" | "annotate" | "armed"

  export interface ConfigShape {
    mode?: Mode
    max_turns_without_mutation?: number
    repeat_signature_threshold?: number
    doom_loop_threshold?: number
    polling_threshold_multiplier?: number
    polling_pattern?: string
    exempt_agents?: string[]
    generated_path_patterns?: string[]
  }

  export interface ResolvedConfig {
    mode: Mode
    maxTurnsWithoutMutation: number
    repeatSignatureThreshold: number
    doomLoopThreshold: number
    pollingThresholdMultiplier: number
    pollingPattern: string
    exemptAgents: string[]
    generatedPathPatterns: string[]
  }

  // Threshold rationale (config-exposed defaults, never fitted to any one
  // workload):
  //   - doomLoopThreshold = 3: matches the pre-existing upstream DOOM_LOOP_THRESHOLD;
  //     a legitimate edit→verify cycle takes only a couple of tool calls, so 3
  //     consecutive byte-identical (tool+args) calls sits outside any
  //     legitimate cycle shape.
  //   - repeatSignatureThreshold = 3: three identical (tool+args+touched-files+
  //     failure) signatures means three attempts produced the same failure —
  //     repeating the call cannot change the outcome.
  //   - maxTurnsWithoutMutation = 12: legitimate exploration bursts (read/search
  //     before a first edit or a final answer) span a handful of assistant
  //     turns; 12 consecutive assistant turns with zero corroborated file
  //     mutation is well beyond that regime while still permitting long
  //     read-only research tasks to proceed (the directive is outcome-neutral).
  //   - pollingThresholdMultiplier = 5: identical polling commands (sleep/watch/
  //     status probes) are legitimately repetitive; raising, not exempting,
  //     keeps a ceiling on unbounded polling loops.
  export const DEFAULTS: ResolvedConfig = {
    mode: "annotate",
    maxTurnsWithoutMutation: 12,
    repeatSignatureThreshold: 3,
    doomLoopThreshold: 3,
    pollingThresholdMultiplier: 5,
    pollingPattern: "\\b(sleep|watch|status)\\b",
    exemptAgents: ["plan", "review"],
    // Generated/regenerating artifacts: re-reading these is expected to see new
    // content on every build, so unchanged-read annotation must not fire.
    generatedPathPatterns: [
      "target/",
      "dist/",
      "build/",
      "out/",
      "node_modules/",
      ".git/",
      "__pycache__/",
      "*.log",
      "*.db",
      "*.duckdb",
      "*.sqlite",
    ],
  }

  export function resolveConfig(cfg: ConfigShape | undefined): ResolvedConfig {
    return {
      mode: cfg?.mode ?? DEFAULTS.mode,
      maxTurnsWithoutMutation: cfg?.max_turns_without_mutation ?? DEFAULTS.maxTurnsWithoutMutation,
      repeatSignatureThreshold: cfg?.repeat_signature_threshold ?? DEFAULTS.repeatSignatureThreshold,
      doomLoopThreshold: cfg?.doom_loop_threshold ?? DEFAULTS.doomLoopThreshold,
      pollingThresholdMultiplier: cfg?.polling_threshold_multiplier ?? DEFAULTS.pollingThresholdMultiplier,
      pollingPattern: cfg?.polling_pattern ?? DEFAULTS.pollingPattern,
      exemptAgents: cfg?.exempt_agents ?? DEFAULTS.exemptAgents,
      generatedPathPatterns: cfg?.generated_path_patterns ?? DEFAULTS.generatedPathPatterns,
    }
  }

  // ---------------------------------------------------------------------------
  // Generic classifiers — NO vertical tokens (FINAL-PLAN Global rule 4).
  // ---------------------------------------------------------------------------

  // Tools whose successful completion IS file mutation (harness-corroborated by
  // construction). Bash-mediated mutations (sed -i, heredocs) are corroborated
  // separately via the step snapshot diff (patch part files) in onStepFinish.
  const FILE_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch", "patch", "multiedit"])

  // Tools that can never mutate the workspace. Anything else ("bash", MCP tools,
  // unknown tools) classifies as "unknown" — ground truth for those comes from
  // the snapshot diff, never from parsing command strings.
  const READ_ONLY_TOOLS = new Set([
    "read",
    "glob",
    "grep",
    "list",
    "codesearch",
    "webfetch",
    "websearch",
    "skill",
    "todoread",
    "question",
    "lsp",
  ])

  export type CallClass = "mutating" | "read-only" | "unknown"

  export function classifyToolCall(tool: string): CallClass {
    if (FILE_MUTATION_TOOLS.has(tool)) return "mutating"
    if (READ_ONLY_TOOLS.has(tool)) return "read-only"
    return "unknown"
  }

  export function isGeneratedPath(filePath: string, patterns: string[]): boolean {
    const normalized = filePath.replaceAll("\\", "/")
    for (const pattern of patterns) {
      if (pattern.endsWith("/")) {
        if (normalized.includes(`/${pattern}`) || normalized.startsWith(pattern)) return true
        continue
      }
      if (pattern.startsWith("*.")) {
        if (normalized.endsWith(pattern.slice(1))) return true
        continue
      }
      if (normalized.includes(pattern)) return true
    }
    return false
  }

  /** Deterministic, order-insensitive stringification of tool args. */
  export function normalizeArgs(input: unknown): string {
    const seen = new Set<unknown>()
    function norm(value: unknown): unknown {
      if (value === null || typeof value !== "object") {
        if (typeof value === "string") return value.replace(/\s+/g, " ").trim()
        return value
      }
      if (seen.has(value)) return "[circular]"
      seen.add(value)
      if (Array.isArray(value)) return value.map(norm)
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = norm((value as Record<string, unknown>)[key])
      }
      return out
    }
    return JSON.stringify(norm(input))
  }

  function sha(text: string): string {
    return createHash("sha256").update(text).digest("hex")
  }

  /** repeat_signature = hash(tool + normalized args + touched files + failure message).
   *  Catches edit-verify-fail-revert-reedit loops that mutate files every turn but
   *  make no progress — invisible to zero-mutation counting. */
  export function repeatSignature(input: {
    tool: string
    args: unknown
    touchedFiles?: string[]
    failureMessage?: string
  }): string {
    return sha(
      [
        input.tool,
        normalizeArgs(input.args),
        [...(input.touchedFiles ?? [])].sort().join(","),
        (input.failureMessage ?? "").replace(/\s+/g, " ").trim(),
      ].join(" "),
    )
  }

  // ---------------------------------------------------------------------------
  // Directive text — outcome-neutral, always with a DONE alternative.
  // ---------------------------------------------------------------------------

  export function starvationDirective(input: {
    turnsWithoutMutation: number
    topReadPath?: string
    topReadCount?: number
  }): string {
    const readClause =
      input.topReadPath && (input.topReadCount ?? 0) > 1
        ? `; you have already read ${input.topReadPath} ${input.topReadCount} times`
        : ""
    return (
      `You have taken ${input.turnsWithoutMutation} turns without modifying any file${readClause}. ` +
      `If this task requires an edit, produce it now; if the correct deliverable is analysis with no ` +
      `file changes, state your final answer and say DONE.`
    )
  }

  /**
   * Run-mode gate for ANY persisted-output mutation. Interactive (TUI/serve)
   * sessions must see tool output byte-identical to what the tool produced —
   * they get a telemetry-only shadow instead of an appended annotation.
   */
  export function applyReadAnnotation(output: string, annotation: string, runMode: boolean): string {
    if (!runMode) return output
    return `${output}\n\n${annotation}`
  }

  export function repeatSignatureDirective(input: { count: number; tool: string }): string {
    return (
      `Your last ${input.count} \`${input.tool}\` attempts had identical inputs and identical outcomes. ` +
      `Repeating the same call again will not change the result. Diagnose why the previous attempts did ` +
      `not achieve the goal and take a different action; if the deliverable is already complete, state ` +
      `your final answer and say DONE.`
    )
  }

  export function doomLoopNudgeDirective(input: { count: number; tool: string }): string {
    return (
      `You have issued the same \`${input.tool}\` call with identical arguments ${input.count} times in a row. ` +
      `If a different action is needed, take it now; if the deliverable is already complete, state your ` +
      `final answer and say DONE.`
    )
  }

  export function doomLoopStatusDirective(input: { count: number; tool: string }): string {
    return (
      `You have repeated the same \`${input.tool}\` call ${input.count} times. Before any further tool ` +
      `calls, produce a status check: (1) what you are trying to accomplish, (2) what the repeated call ` +
      `returned, (3) why the next action will produce a different result. Then take that different ` +
      `action — or, if the deliverable is already complete, state your final answer and say DONE.`
    )
  }

  // ---------------------------------------------------------------------------
  // Tracker — session-scoped state machine. Pure with respect to the harness:
  // callers feed it events; it returns what (if anything) would fire.
  // ---------------------------------------------------------------------------

  export type DoomEscalation = "nudge" | "status_check" | "stop"

  export interface CallResult {
    class: CallClass
    /** Present when the (tool + normalized args) consecutive-repeat ladder crossed a rung. */
    doomLoop?: { escalation: DoomEscalation; count: number; threshold: number; directive: string }
  }

  export interface ResultOutcome {
    /** Informational annotation to APPEND to the tool output (never replaces it). */
    readAnnotation?: string
    /** Present when the repeat-signature loop detector crossed its threshold. */
    repeatLoop?: { count: number; signature: string; directive: string }
  }

  export interface StepOutcome {
    turnsWithoutMutation: number
    /** Present when the write-starvation breaker would fire this turn. */
    starvation?: { directive: string }
  }

  export interface Stats {
    step: number
    turnsWithoutMutation: number
    firstMutationStep: number | undefined
    toolCalls: number
    mutatingCalls: number
    unchangedReads: number
  }

  export function createTracker(config: ResolvedConfig) {
    let step = 1
    let turnsWithoutMutation = 0
    let stepSawMutation = false
    let firstMutationStep: number | undefined
    let toolCalls = 0
    let mutatingCalls = 0
    let unchangedReads = 0

    // Doom-loop ladder state — keyed on (tool + normalized args).
    let lastCallKey: string | undefined
    let consecutiveIdenticalCalls = 0

    // Repeat-signature loop state — consecutive identical signatures.
    let lastSignature: string | undefined
    let consecutiveIdenticalSignatures = 0

    // Read tracking: path → content hash + counts.
    const reads = new Map<string, { hash: string; count: number; lastStep: number; firstStep: number }>()

    const pollingRegex = (() => {
      try {
        return new RegExp(config.pollingPattern, "i")
      } catch {
        return new RegExp(DEFAULTS.pollingPattern, "i")
      }
    })()

    function markMutation() {
      stepSawMutation = true
      firstMutationStep ??= step
    }

    function topRead(): { path: string; count: number } | undefined {
      let best: { path: string; count: number } | undefined
      for (const [path, entry] of reads) {
        if (!best || entry.count > best.count) best = { path, count: entry.count }
      }
      return best
    }

    return {
      get config() {
        return config
      },

      onToolCall(input: { tool: string; input: unknown }): CallResult {
        toolCalls++
        const klass = classifyToolCall(input.tool)
        if (klass === "mutating") {
          mutatingCalls++
          // No mutation credit here: the call has not succeeded yet. Credit is
          // granted on successful completion (onToolResult) or snapshot-diff
          // evidence (onStepFinish) — a failed edit must not reset the
          // starvation counter.
        }

        const key = `${input.tool} ${normalizeArgs(input.input)}`
        if (key === lastCallKey) consecutiveIdenticalCalls++
        else {
          lastCallKey = key
          consecutiveIdenticalCalls = 1
        }

        // Polling patterns (identical sleep/watch/status probes) get a raised
        // threshold, not an exemption — a ceiling still exists.
        const command =
          input.input && typeof input.input === "object" && typeof (input.input as any).command === "string"
            ? ((input.input as any).command as string)
            : undefined
        const polling = command !== undefined && pollingRegex.test(command)
        const threshold = polling ? config.doomLoopThreshold * config.pollingThresholdMultiplier : config.doomLoopThreshold

        let escalation: DoomEscalation | undefined
        if (consecutiveIdenticalCalls >= threshold * 3) escalation = "stop"
        else if (consecutiveIdenticalCalls === threshold * 2) escalation = "status_check"
        else if (consecutiveIdenticalCalls === threshold) escalation = "nudge"

        if (escalation === "stop") {
          // Latch: the stop fires exactly once per completed ladder run — the
          // count resets so (a) further identical calls in the same stopping
          // step cannot re-fire it (directive/part spam), and (b) a retried
          // session starts with a cleared ladder and full runway instead of an
          // instant stop on its first repeated call.
          const count = consecutiveIdenticalCalls
          consecutiveIdenticalCalls = 0
          return {
            class: klass,
            doomLoop: {
              escalation,
              count,
              threshold,
              directive: doomLoopStatusDirective({ count, tool: input.tool }),
            },
          }
        }

        if (!escalation) return { class: klass }
        const directive =
          escalation === "status_check" || escalation === "stop"
            ? doomLoopStatusDirective({ count: consecutiveIdenticalCalls, tool: input.tool })
            : doomLoopNudgeDirective({ count: consecutiveIdenticalCalls, tool: input.tool })
        return {
          class: klass,
          doomLoop: { escalation, count: consecutiveIdenticalCalls, threshold, directive },
        }
      },

      onToolResult(input: {
        tool: string
        input: unknown
        output?: string
        failureMessage?: string
        touchedFiles?: string[]
      }): ResultOutcome {
        const outcome: ResultOutcome = {}

        // Successful file-mutation tool completions are corroborated mutations.
        if (classifyToolCall(input.tool) === "mutating" && input.failureMessage === undefined) markMutation()

        // Unchanged-read annotation — content hash at read time; annotate, never
        // suppress. Generated paths are exempt (they legitimately change or are
        // re-read across builds).
        if (input.tool === "read" && input.failureMessage === undefined && typeof input.output === "string") {
          const filePath =
            input.input && typeof input.input === "object" && typeof (input.input as any).filePath === "string"
              ? ((input.input as any).filePath as string)
              : undefined
          if (filePath !== undefined) {
            const hash = sha(input.output)
            const prior = reads.get(filePath)
            if (prior === undefined) {
              reads.set(filePath, { hash, count: 1, lastStep: step, firstStep: step })
            } else {
              const unchanged = prior.hash === hash
              const priorStep = prior.lastStep
              prior.hash = hash
              prior.count++
              prior.lastStep = step
              if (unchanged && !isGeneratedPath(filePath, config.generatedPathPatterns)) {
                unchangedReads++
                outcome.readAnnotation =
                  `[harness note: ${filePath} is unchanged since you read it at turn ${priorStep} ` +
                  `(identical content hash); this is read #${prior.count} of this file in this session.]`
              }
            }
          }
        }

        // Repeat-signature loop detection.
        const signature = repeatSignature({
          tool: input.tool,
          args: input.input,
          touchedFiles: input.touchedFiles,
          failureMessage: input.failureMessage,
        })
        if (signature === lastSignature) consecutiveIdenticalSignatures++
        else {
          lastSignature = signature
          consecutiveIdenticalSignatures = 1
        }
        if (
          consecutiveIdenticalSignatures >= config.repeatSignatureThreshold &&
          (consecutiveIdenticalSignatures - config.repeatSignatureThreshold) % config.repeatSignatureThreshold === 0
        ) {
          outcome.repeatLoop = {
            count: consecutiveIdenticalSignatures,
            signature,
            directive: repeatSignatureDirective({ count: consecutiveIdenticalSignatures, tool: input.tool }),
          }
        }

        return outcome
      },

      /** Called once per assistant step with the snapshot-diff evidence (patch
       *  part files) — the generic, command-agnostic mutation ground truth that
       *  also catches bash-mediated writes (sed -i, heredocs). */
      onStepFinish(input: { mutatedFiles: string[] }): StepOutcome {
        if (input.mutatedFiles.length > 0) markMutation()
        if (stepSawMutation) turnsWithoutMutation = 0
        else turnsWithoutMutation++
        stepSawMutation = false
        step++

        const outcome: StepOutcome = { turnsWithoutMutation }
        const t = config.maxTurnsWithoutMutation
        // Fire at the threshold, then re-fire every `threshold` turns — not every
        // turn (directive spam would drown the model's own reasoning).
        if (turnsWithoutMutation >= t && (turnsWithoutMutation - t) % t === 0) {
          const top = topRead()
          outcome.starvation = {
            directive: starvationDirective({
              turnsWithoutMutation,
              topReadPath: top?.path,
              topReadCount: top?.count,
            }),
          }
        }
        return outcome
      },

      stats(): Stats {
        return { step, turnsWithoutMutation, firstMutationStep, toolCalls, mutatingCalls, unchangedReads }
      },
    }
  }

  export type Tracker = ReturnType<typeof createTracker>

  // Session-scoped store — trackers must survive across processor instances
  // (SessionProcessor.create runs once per step). Bounded for long-lived servers.
  const MAX_SESSIONS = 128
  const trackers = new Map<string, Tracker>()

  export function forSession(sessionID: string, config: ResolvedConfig): Tracker {
    let tracker = trackers.get(sessionID)
    if (!tracker) {
      if (trackers.size >= MAX_SESSIONS) {
        const oldest = trackers.keys().next().value
        if (oldest !== undefined) trackers.delete(oldest)
      }
      tracker = createTracker(config)
      trackers.set(sessionID, tracker)
    }
    return tracker
  }

  export function clear(sessionID: string): void {
    trackers.delete(sessionID)
  }
}
