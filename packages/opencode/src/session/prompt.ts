import path from "path"
import { Token } from "@/util/token"
import { existsSync } from "node:fs"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
// altimate_change start — shared family→vendor classifier (#888 J1)
import { familyVendor } from "../provider/family"
// altimate_change end
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, asSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { NudgeArbiter } from "./nudge"
import { SessionTermination } from "./termination"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { MemoryPrompt } from "../memory/prompt"
import { UNIFIED_INJECTION_BUDGET } from "../memory/types"
// altimate_change - workspace memory read path
import * as WorkspaceMemory from "../altimate/workspace/memory-sync"
// altimate_change start — workspace engine turn boundary, managed-key refusal, tool precedence
import * as WorkspaceEngine from "../altimate/workspace/engine-overlay"
import { DATAMATE_KEY } from "../altimate/datamate-transport"
import * as Precedence from "../altimate/workspace/precedence"
import * as Awareness from "../altimate/workspace/awareness"
// altimate_change end
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
// altimate_change — upstream_fix (#701): unresolved-env record for the /mcps view.
import * as McpDiscover from "../mcp/discover"
// altimate_change start — upstream_fix (#701): file-scoped blank-variable diagnostics.
import { ConfigVariable } from "../config/variable"
// altimate_change end
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
// altimate_change — sync flag read, so the workspace-skill hook below can cost
// literally nothing (not even an await) for users who never opted in.
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { Truncate } from "@/tool/truncation"
import { decodeDataUrl } from "@/util/data-url"
// altimate_change start — bridge the Effect-based Tool API (v1.17.9) back to this Promise-based module
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
// altimate_change end
// altimate_change start - import fingerprint for env-based skill selection
import { Fingerprint } from "../altimate/fingerprint"
// altimate_change end

// altimate_change start - validator framework (see session/validators/types.ts header)
import { ValidatorRegistry } from "./validators/registry"
import { registerAltimateValidators } from "../altimate/validators"
import { sanitizeTelemetryDetails } from "../altimate/validators/validator-utils"
// Explicit registration call (not a side-effect import) so bun's --single
// bundler cannot tree-shake the validator registrations.
registerAltimateValidators()
import { Config } from "../config/config"
import { Tracer } from "../altimate/observability/tracing"
// altimate_change start — stamp an authoritative tool source + humanized MCP title
import { stampRegistryToolSource, describeMcpTool } from "../altimate/tool-source"
// altimate_change end
// altimate_change end
import { Telemetry } from "@/telemetry" // altimate_change — session telemetry
import * as OnboardingTelemetry from "@/altimate/telemetry/onboarding" // altimate_change — onboarding funnel

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })

  // altimate_change start — how long a turn will wait for the workspace skill
  // sync before proceeding without it. See the block in `prompt`.
  const WORKSPACE_SKILL_WAIT_MS = 2000

  /** Drop the caches in front of the synced skill files, if a sync moved them.
   * Shared by both branches of the block in `prompt`: opting out removes a
   * snapshot and needs the registry refreshed exactly as adding one does. */
  async function refreshSkillRegistry(dir: string): Promise<void> {
    const skillSync = await import("../altimate/workspace/skill-sync")
    if (!skillSync.registryStale(dir)) return
    // Marked BEFORE the work, not after: a refresh that throws must not be
    // retried on every subsequent turn forever, and the next real snapshot
    // change re-arms this anyway.
    skillSync.markRegistryApplied(dir)
    const { Skill } = await import("../skill")
    // Both drops go through the in-context services rather than the imperative
    // facades. Discovery re-derives its roots from `Config.directories()`, which
    // walks up looking for `.altimate-code/`; on a project that has never synced,
    // that directory does not exist at boot, so the list holds a miss that only
    // an invalidate reaching *this* instance can clear. Invalidating through the
    // facade leaves it, and the refreshed registry then rescans the same empty
    // root set — the skills stay invisible for the rest of the session.
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const config = yield* Config.Service
        const skill = yield* Skill.Service
        yield* config.invalidate()
        yield* skill.refresh()
      }),
    )
  }
  // altimate_change end

  // altimate_change start — testable validator completion gate shared by the dispatch path
  /** @internal Pure completion-gate predicate used by focused regression tests. */
  export function shouldDispatchValidators(input: {
    active: boolean
    result: SessionProcessor.Result
    finish?: string
    hasError: boolean
    validatorCount: number
    explicitDone: boolean
  }): boolean {
    return (
      input.active &&
      input.result !== "compact" &&
      (input.result !== "stop" || input.explicitDone) &&
      input.finish === "stop" &&
      !input.hasError &&
      input.validatorCount > 0
    )
  }
  // altimate_change end

  // altimate_change start (AI-7519) — first-answer latency instrumentation +
  // user-facing phase label.
  //
  // Wraps an awaited operation with a Tracer span so bootstrap sub-steps are
  // visible in session traces. Every wrapped await opens a discrete span so a
  // future regression that adds a slow await also shows up automatically.
  //
  // On top of the tracing, publish a session.phase event (start on entry, end
  // on exit) so the TUI can render an honest label like "Discovering
  // warehouse tools..." during the pre-first-visible-response window. This is
  // the SLO half of AI-7519 — target <10s to first *visible* response. The
  // instrumentation names double as user-facing signal.
  //
  // The trace span is a sibling of the root (tracing.ts:1009 assigns
  // parentSpanId to rootSpanId), not a nested child — good enough for
  // waterfall correlation via timestamps, and no schema change is required.
  async function traceSpan<T>(name: string, fn: () => Promise<T>, input?: unknown, sessionID?: SessionID): Promise<T> {
    const startTime = Date.now()
    if (sessionID) void SessionStatus.publishPhase(sessionID, name, true)
    try {
      const result = await fn()
      Tracer.active?.logSpan({ name, startTime, endTime: Date.now(), input })
      return result
    } catch (e) {
      Tracer.active?.logSpan({
        name,
        startTime,
        endTime: Date.now(),
        status: "error",
        input,
        output: { error: String(e) },
      })
      throw e
    } finally {
      if (sessionID) void SessionStatus.publishPhase(sessionID, name, false)
    }
  }
  // altimate_change end

  // altimate_change start — single source of truth for legacy agent-name normalization
  //
  // The "build" agent was renamed to "builder" but some persisted sessions and
  // the plan-exit synthetic message historically wrote `agent: "build"`. Agent.get()
  // applies an alias so execution still works, but every telemetry event with an
  // `agent` field needs to project to the canonical name or dashboards see a
  // phantom "build" bucket alongside "builder". This helper is the single place
  // that normalization lives — used by both session_start and agent_outcome
  // emits below so they can never drift. Future telemetry events with an `agent`
  // field should route through this helper too.
  function normalizeAgentName(name: string | undefined): string {
    // Defence-in-depth before the legacy-name compare:
    //   1. Strip C0 control characters (\x00-\x1f) — neutralizes log-injection
    //      via embedded newlines/CRs that would split the telemetry field into
    //      two fake events on App Insights.
    //   2. Unicode-normalize (NFKC) — collapses visually-identical homoglyphs
    //      so "ｂｕｉｌｄｅｒ" (fullwidth) doesn't create a separate bucket.
    //   3. Cap at 64 chars — agent names should be slugs; anything larger is
    //      a cardinality bomb or an injection vector. The agent registry's
    //      longest legitimate name is well under this cap.
    if (!name) return "builder"
    const cleaned = name
      .replace(/[\x00-\x1f\x7f]/g, "")
      .normalize("NFKC")
      .slice(0, 64)
    // Case-insensitive legacy-name guard: a future config, custom prompt, or
    // hand-edited persisted session could surface "Build"/"BUILD" and the
    // phantom telemetry bucket would come back.
    if (!cleaned || cleaned.toLowerCase() === "build") return "builder"
    return cleaned
  }
  // altimate_change end

  const state = Instance.state(
    () => {
      const data: Record<
        string,
        {
          abort: AbortController
          // altimate_change start — prevent idle listeners attaching to a closing prompt generation
          closing?: boolean
          loopOwned?: boolean
          // altimate_change end
          callbacks: {
            resolve(input: MessageV2.WithParts): void
            reject(reason?: any): void
          }[]
        }
      > = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        item.abort.abort()
      }
    },
  )

  export function assertNotBusy(sessionID: SessionID) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }

  export const PromptInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    const session = await Session.get(input.sessionID)
    // altimate_change start — fork Session.Info (index zod) ≡ core Session.Info (session.ts) at the SessionRevert boundary
    await SessionRevert.cleanup(session as unknown as Parameters<typeof SessionRevert.cleanup>[0])
    // altimate_change end

    // altimate_change start — make the bound workspace's custom skills visible
    // before the agent is resolved. `createUserMessage` -> `Agent.get` ->
    // `Skill.dirs()` is what first materialises the skill registry, so acting
    // here lands the skills on this turn rather than the next one.
    //
    // The flag is read SYNCHRONOUSLY and the opt-out path is deliberately not
    // awaited. An `await` here — even a zero-cost one — inserts an event-loop
    // tick before `createUserMessage`, which reorders this turn against a
    // forked `prompt.loop` fiber. That is not theoretical: it made
    // "running subtask preserves metadata after tool-call transition" fail
    // roughly two runs in three, while passing on main. A feature nobody
    // enabled must not perturb the turn at all.
    //
    // Opting out still has to take effect, since discovery loads whatever is on
    // disk without consulting the flag. The gate is a synchronous `existsSync`,
    // not a detached cleanup: a run with the flag ON leaves a snapshot behind,
    // and turning the flag off does not delete it, so a later opted-out turn
    // CAN find one. Detaching the purge let `createUserMessage` materialise
    // those stale skills first, which put `alwaysApply` instructions into a
    // turn the operator had disabled the feature for. Awaiting only when a
    // snapshot is actually there keeps the tick off the path that regressed —
    // a user who never opted in has no directory, so this costs one `stat` and
    // does not even load the sync module.
    if (!CoreFlag.ALTIMATE_WORKSPACE) {
      const dir = Instance.directory
      // Mirrors `MANAGED_DIR` in ./altimate/workspace/skill-sync. Inlined
      // rather than imported so the opted-out path stays free of that module.
      if (existsSync(path.join(dir, ".altimate-code", "skill", "_workspace"))) {
        try {
          const m = await import("../altimate/workspace/skill-sync")
          if ((await m.syncSkills(dir)).changed) await refreshSkillRegistry(dir)
        } catch (err) {
          log.warn("workspace skill opt-out cleanup failed", { err: String(err) })
        }
      }
    } else {
      try {
        const skillSync = await import("../altimate/workspace/skill-sync")
        const dir = Instance.directory
        const refreshRegistry = () => refreshSkillRegistry(dir)

        // A sync that ran elsewhere — a bind, most commonly — changes the
        // snapshot with no instance context to refresh from. Pick that up before
        // deciding whether this turn needs to poll at all.
        await refreshRegistry()

        if (!(await skillSync.recentlySynced(dir))) {
          const applied = skillSync.syncSkills(dir).then(refreshRegistry)
          applied.catch((err) => log.warn("workspace skill sync failed", { err: String(err) }))
          // Timer cleared when the sync wins the race: an armed timer keeps the
          // event loop alive, so a short-lived `run` would linger for the rest
          // of the bound, once per turn.
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              applied,
              new Promise((r) => {
                timer = setTimeout(r, WORKSPACE_SKILL_WAIT_MS)
              }),
            ])
          } finally {
            if (timer) clearTimeout(timer)
          }
        }
      } catch (err) {
        log.warn("workspace skill sync failed", { err: String(err) })
      }
    }
    // altimate_change end

    const message = await createUserMessage(input)
    await Session.touch(input.sessionID)

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.setPermission({ sessionID: session.id, permission: permissions })
    }

    if (input.noReply === true) {
      return message
    }

    return loop({ sessionID: input.sessionID })
  })

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: pathToFileURL(filepath).href,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  function start(sessionID: SessionID) {
    const s = state()
    // altimate_change start — replace closing prompt generations instead of reusing their callbacks
    if (s[sessionID] && !s[sessionID].closing) return
    // altimate_change end
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      callbacks: [],
    }
    return controller.signal
  }

  function resume(sessionID: SessionID) {
    const s = state()
    if (!s[sessionID]) return
    // altimate_change start — resume with a fresh generation once cleanup has begun
    if (s[sessionID].closing) return start(sessionID)
    // altimate_change end

    return s[sessionID].abort.signal
  }

  // altimate_change start — SessionStatus.set became async in v1.4.0; await so idle state actually flushes
  export async function cancel(sessionID: SessionID) {
    log.info("cancel", { sessionID })
    const s = state()
    const match = s[sessionID]
    if (!match) {
      // Session already ended or was never started — set idle directly since no processor will do it
      await SessionStatus.set(sessionID, { type: "idle" })
      return
    }
    // Make the tombstone replaceable before aborting. A replacement prompt may
    // arrive synchronously after cancel() and must start a fresh generation,
    // never queue its callback on the signal that was just aborted.
    match.closing = true
    match.abort.abort()
    if (!match.loopOwned) {
      // shell() also uses start(), but it has no loop disposer when no prompt
      // callbacks are queued. That owner must restore idle directly.
      if (s[sessionID] === match) delete s[sessionID]
      await SessionStatus.set(sessionID, { type: "idle" })
      return
    }
    // Keep this exact generation registered until loop()'s generation-scoped
    // disposer runs. Deleting it here makes the disposer miss its fallback-idle
    // transition when cancellation lands during bootstrap, compaction, or any
    // other path outside the processor catch block. The closing tombstone lets
    // start() install a fresh generation without attaching callbacks to this
    // aborted one; the old generation-scoped disposer ignores that replacement.
    // Processor-owned aborts still publish session.error before idle; the
    // disposer observes that idle and only removes the registry entry.
  }
  // altimate_change end

  export const LoopInput = z.object({
    sessionID: SessionID.zod,
    resume_existing: z.boolean().optional(),
  })
  export const loop = fn(LoopInput, async (input) => {
    const { sessionID, resume_existing } = input

    const abort = resume_existing ? resume(sessionID) : start(sessionID)
    if (!abort) {
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        const callbacks = state()[sessionID].callbacks
        callbacks.push({ resolve, reject })
      })
    }
    // altimate_change start — bind lifecycle cleanup to this active loop generation
    const generation = state()[sessionID]
    if (generation?.abort.signal === abort) generation.loopOwned = true
    // altimate_change end

    // altimate_change start — generation-scoped cleanup owns the fallback idle.
    // Retain this exact loop generation until its missing idle transition has
    // been published, then remove it without touching any replacement.
    // Processor errors may already have published error -> idle; in that case
    // SessionStatus is already idle and cleanup must not publish a stale second
    // idle into the next generation. Failures outside the processor (notably
    // the compaction circuit breaker) still get the missing idle transition.
    await using _ = defer(async () => {
      const s = state()
      const match = s[sessionID]
      if (!match || match.abort.signal !== abort) return
      // Keep a replaceable tombstone while publishing idle. start() may replace
      // it immediately when an idle listener begins the next generation, but
      // will not attach that new prompt to callbacks from this finished loop.
      match.closing = true
      match.abort.abort()
      const status = await SessionStatus.get(sessionID)
      if (s[sessionID] === match && status.type !== "idle") {
        await SessionStatus.set(sessionID, { type: "idle" }).catch((error) => {
          log.warn("failed to restore idle status during prompt-loop cleanup", { sessionID, error })
        })
      }
      if (s[sessionID] === match) delete s[sessionID]
    })
    // altimate_change end
    // A directive is valid only for this active generation. If the loop stops,
    // aborts, or throws after a detector registers but before the next turn
    // consumes it, do not leak that stale directive into a later resume.
    // altimate_change start — scope pending harness nudges to this prompt generation
    const nudgeGeneration = NudgeArbiter.begin(sessionID)
    using _nudgeGeneration = defer(() => NudgeArbiter.clear(sessionID, nudgeGeneration))
    // altimate_change end

    // Structured output state
    // Note: On session resumption, state is reset but outputFormat is preserved
    // on the user message and will be retrieved from lastUser below
    let structuredOutput: unknown | undefined

    let step = 0
    // altimate_change start — first tool catalog of this loop. `step` counts loop
    // iterations, and an iteration can `continue` before cataloguing (pending
    // compaction, context overflow), so "step === 1" is not "first catalog".
    let catalogued = false
    // altimate_change end
    // altimate_change start (AI-7519) — capture bootstrap start; emitted as a
    // single "bootstrap" span right before the first processor.process call so
    // the pre-first-generation region has a visible parent duration in traces.
    const bootstrapStart = Date.now()
    // Enter busy state BEFORE the first bootstrap traceSpan fires so the
    // phase labels the TUI renders are actually visible during
    // session-get / config-get / fingerprint-detect / telemetry-init. The
    // TUI's status renderer gates on `status.type === "busy"`; without
    // this early set only `bootstrap.resolve-tools` (which fires inside
    // the while-loop after the existing busy set at line 506) would show
    // a label. The while-loop re-set below is now a no-op busy → busy
    // transition, preserved for legacy call sites that may enter the
    // loop from elsewhere.
    await SessionStatus.set(sessionID, { type: "busy" })
    // altimate_change end
    // altimate_change start (AI-7519) — discharge the busy status if a bootstrap
    // await throws. cancel() (prompt.ts:364) deliberately does NOT set idle
    // when the state entry still exists — it relies on the processor's catch
    // block for that. But during bootstrap the processor hasn't taken over
    // yet, so a throw here (Session.get / Config.get / Fingerprint.detect /
    // Telemetry.init) would leave the session permanently `busy` with no
    // idle/error transition. Reset to idle on any bootstrap failure and
    // re-throw so callers still see the error.
    let session: Awaited<ReturnType<typeof Session.get>>
    let altCfg: Awaited<ReturnType<typeof Config.get>>
    try {
      session = await traceSpan("bootstrap.session-get", () => Session.get(sessionID), { sessionID }, sessionID)
      // altimate_change start - detect environment fingerprint at session start
      altCfg = await traceSpan("bootstrap.config-get", () => Config.get(), undefined, sessionID)
      if (altCfg.experimental?.env_fingerprint_skill_selection === true) {
        await traceSpan(
          "bootstrap.fingerprint-detect",
          () => Fingerprint.detect(Instance.directory, Instance.worktree),
          undefined,
          sessionID,
        ).catch((e) => {
          log.warn("fingerprint detection failed", { error: e })
        })
      }
      // altimate_change end
      // altimate_change start — session telemetry tracking
      await traceSpan("bootstrap.telemetry-init", () => Telemetry.init(), undefined, sessionID)
    } catch (e) {
      // Best-effort transition to idle so the TUI spinner + any busy-gated
      // callers don't stay stuck. Swallow inner failure so the original
      // bootstrap error is what bubbles out.
      await SessionStatus.set(sessionID, { type: "idle" }).catch(() => {})
      throw e
    }
    // altimate_change end
    Telemetry.setContext({ sessionId: sessionID, projectId: Instance.project?.id ?? "" })
    const sessionStartTime = Date.now()
    let sessionTotalCost = 0
    let sessionTotalTokens = 0
    let toolCallCount = 0
    let compactionCount = 0
    // altimate_change start — validator framework retry counter
    let validatorRetryCount = 0
    // altimate_change end
    let sessionAgentName = ""
    let sessionHadError = false
    // altimate_change start — plan refinement tracking
    let planRevisionCount = 0
    let planHasWritten = false
    let planLastUserMsgId: string | undefined
    // altimate_change end
    let emergencySessionEndFired = false
    // altimate_change start — quality signal, tool chain, error fingerprint tracking
    let lastToolCategory = ""
    // altimate_change start — agent_outcome diagnostic tracking
    let lastToolName = ""
    let lastMessageError = ""
    // altimate_change end
    const toolChain: string[] = []
    let toolErrorCount = 0
    let errorRecoveryCount = 0
    let lastToolWasError = false
    interface ErrorRecord {
      toolName: string
      toolCategory: string
      errorClass: string
      errorHash: string
      recovered: boolean
      recoveryTool: string
    }
    const errorRecords: ErrorRecord[] = []
    let pendingError: Omit<ErrorRecord, "recovered" | "recoveryTool"> | null = null
    // altimate_change end
    const emergencySessionEnd = () => {
      if (emergencySessionEndFired) return
      emergencySessionEndFired = true
      Telemetry.track({
        type: "session_end",
        timestamp: Date.now(),
        session_id: sessionID,
        total_cost: sessionTotalCost,
        total_tokens: sessionTotalTokens,
        tool_call_count: toolCallCount,
        duration_ms: Date.now() - sessionStartTime,
      })
    }
    process.once("beforeExit", emergencySessionEnd)
    process.once("exit", emergencySessionEnd)
    // altimate_change end
    // altimate_change start — refresh MCP tools on ToolsChanged event
    // When a datamate MCP server reconnects (transport change, window restart),
    // MCP.ToolsChanged is published. MCP.tools() already uses a per-client cache
    // that is invalidated by the notification handler that publishes this event,
    // so the next resolveTools() call (once per LLM turn) naturally picks up fresh
    // tools without any extra work here. This subscription makes the session layer
    // explicitly aware of the reconnect and logs it so it is traceable in prod.
    // MCP.ToolsChanged migrated to an EventV2 definition upstream; the EventV2Bridge
    // republishes it onto the legacy Bus by type, so filter the wildcard stream.
    const unsubscribeToolsChanged = Bus.subscribeAll((event) => {
      if (event.type !== MCP.ToolsChanged.type) return
      log.info("MCP.ToolsChanged received — tools will refresh on next turn", {
        server: (event.properties as { server?: string })?.server,
        sessionID,
      })
    })
    using _unsubToolsChanged = defer(unsubscribeToolsChanged)
    // altimate_change end
    while (true) {
      // altimate_change start — SessionStatus.set became async in v1.4.0; await so busy state flushes before LLM call
      await SessionStatus.set(sessionID, { type: "busy" })
      // altimate_change end
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      // altimate_change start — when the newest message is a pending
      // compaction marker, hydrate the stream once and pass that unfiltered
      // history to the ledger. Previously filterCompacted read the recent view
      // and process() synchronously hydrated the entire session a second time.
      const messageStream = MessageV2.stream(sessionID)
      const firstMessage = messageStream.next()
      const newestIsCompaction =
        !firstMessage.done && firstMessage.value.parts.some((part) => part.type === "compaction")
      let unfilteredCompactionHistory: MessageV2.WithParts[] | undefined
      let msgs: MessageV2.WithParts[]
      if (newestIsCompaction) {
        const newestFirst = [firstMessage.value, ...messageStream]
        unfilteredCompactionHistory = newestFirst.slice().reverse()
        msgs = MessageV2.filterCompacted(newestFirst)
      } else {
        function* fullStream() {
          if (!firstMessage.done) yield firstMessage.value
          yield* messageStream
        }
        msgs = MessageV2.filterCompacted(fullStream())
      }
      // altimate_change end

      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      // altimate_change start — always track the current agent name so early breaks still report it
      if (lastUser.agent) sessionAgentName = lastUser.agent
      // altimate_change end
      // altimate_change start — upstream_fix: a provider can finish with
      // "stop" while still emitting tool parts; those tools must be replayed
      // into the next loop instead of terminating the session.
      const lastAssistantHasToolParts =
        lastAssistant !== undefined &&
        (msgs
          .find((msg) => msg.info.id === lastAssistant.id)
          ?.parts.some((part) => {
            if (part.type !== "tool") return false
            return !(part.state.status === "error" && part.state.metadata?.interrupted === true)
          }) ??
          false)
      if (
        lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        !lastAssistantHasToolParts &&
        lastUser.id < lastAssistant.id
      ) {
        log.info("exiting loop", { sessionID })
        break
      }
      // altimate_change end

      step++
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        })

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID).catch((e) => {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${e.data.providerID}/${e.data.modelID}.${hint}`,
            }).toObject(),
          })
        }
        throw e
      })
      const task = tasks.pop()

      // pending subtask
      // TODO: centralize "invoke tool" logic
      if (task?.type === "subtask") {
        // altimate_change start — v1.17.9: TaskTool is an Effect of Info; init() yields the executable def
        const taskTool = await AppRuntime.runPromise(Effect.flatMap(TaskTool, (info) => info.init()))
        // altimate_change end
        const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
        const assistantMessage = (await Session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        let part = (await Session.updatePart({
          id: PartID.ascending(),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        }
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          { args: taskArgs },
        )
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        const taskCtx: Tool.Context = {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          // altimate_change start — fork MessageV2.WithParts ≡ core SessionV1.WithParts at the Tool.Context boundary
          messages: msgs as unknown as Tool.Context["messages"],
          metadata: (input) =>
            // altimate_change start — Tool.Context.metadata/ask now return Effect (v1.17.9)
            Effect.promise(async () => {
              part = (await Session.updatePart({
                ...part,
                type: "tool",
                state: {
                  ...part.state,
                  ...input,
                },
              } satisfies MessageV2.ToolPart)) as MessageV2.ToolPart
            }),
          ask: (req) =>
            Effect.promise(async () => {
              // altimate_change start — core PermissionV1.Request uses readonly arrays; ask() validates the shape at runtime
              await PermissionNext.ask({
                ...req,
                sessionID: sessionID,
                ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
              } as Parameters<typeof PermissionNext.ask>[0])
              // altimate_change end
            }),
          // altimate_change end
          // altimate_change end
        }
        const result = await AppRuntime.runPromise(taskTool.execute(taskArgs, taskCtx)).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        const attachments = result?.attachments?.map((attachment) => ({
          ...attachment,
          id: PartID.ascending(),
          sessionID,
          messageID: assistantMessage.id,
        }))
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "task",
            sessionID,
            callID: part.id,
            args: taskArgs,
          },
          result,
        )
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        // altimate_change start — count subtask tool calls in session metrics
        toolCallCount++
        // altimate_change end
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: "metadata" in part.state ? part.state.metadata : undefined,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserMsg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: lastUser.model,
          }
          await Session.updateMessage(summaryUserMsg)
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }

        continue
      }

      // pending compaction
      if (task?.type === "compaction") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
          overflow: task.overflow,
          // altimate_change start — keep nudge delivery scoped to this prompt generation
          nudgeGeneration,
          // altimate_change end
          // altimate_change start — reuse the one-pass full history hydration for the ledger
          unfilteredMessages: unfilteredCompactionHistory,
          // altimate_change end
        })
        // altimate_change start — treat any non-"continue" result as stop: an
        // undefined/unknown result must never fall through to `continue`, which
        // re-enters compaction on the same unresolved marker and busy-loops.
        if (result !== "continue") break
        // altimate_change end
        continue
      }

      // context overflow, needs compaction
      // altimate_change start — proactive overflow check: the recorded usage is
      // from the LAST assistant turn; tool results appended since then are not
      // counted, and one oversized output can jump the session past the window
      // between checks (a common failure mode for long headless runs). Estimate the
      // uncounted tail and include it.
      const uncountedTail = estimateUncountedTail(msgs, lastFinished?.id)
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({
          tokens: lastFinished.tokens,
          // Estimated component passed separately: the safety fraction applies
          // only to it, never to the provider-reported usage above.
          estimatedTokens: uncountedTail,
          model,
        }))
      ) {
        // altimate_change end
        // altimate_change start — task-pin livelock guard: record this
        // auto-compaction so consecutive threshold-reduction failures halve the
        // task pin instead of livelocking (fire → cannot reduce → re-fire).
        SessionCompaction.notePinCompaction(sessionID, msgs)
        // altimate_change end
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }

      // normal processing
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      // altimate_change start — insertReminders returns the trusted reminder parts
      // it appended. The function now also pre-applies `ignored: true` to those
      // parts (and to the persisted rows under experimental plan mode) for
      // non-Anthropic-like models, so `toModelMessages` skips them on every turn
      // — not just this one (#888 J2). The returned-parts list is the trust
      // boundary; we never infer trust from the `synthetic` flag (other code
      // paths set it on user-derived file/resource expansions). See #887/#888.
      const reminderResult = await insertReminders({
        messages: msgs,
        agent,
        session,
        model,
      })
      msgs = reminderResult.messages
      const hoistedReminders = isAnthropicLikeModel(model) ? [] : reminderResult.trustedReminderParts.map((p) => p.text)
      // altimate_change end

      // altimate_change start — plan refinement detection and telemetry
      if (agent.name === "plan") {
        // Check if plan file has been written in a previous step
        if (!planHasWritten) {
          const planPath = Session.plan(session)
          planHasWritten = await Filesystem.exists(planPath)
        }
        // If plan was already written and user sent a new message, this is a refinement.
        // Only count once per user message (not on internal loop iterations).
        const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
        const currentUserMsgId = lastUserMsg?.info.id
        if (planHasWritten && step > 1 && currentUserMsgId && currentUserMsgId !== planLastUserMsgId) {
          planLastUserMsgId = currentUserMsgId
          const userText =
            lastUserMsg?.parts
              .filter((p): p is MessageV2.TextPart => p.type === "text" && !("synthetic" in p && p.synthetic))
              .map((p) => p.text.toLowerCase())
              .join(" ") ?? ""

          if (planRevisionCount >= 5) {
            // Cap reached — track and inject a synthetic hint so the LLM informs the user
            Telemetry.track({
              type: "plan_revision",
              timestamp: Date.now(),
              session_id: sessionID,
              revision_number: planRevisionCount,
              action: "cap_reached",
            })
            // Append a synthetic text part to the last user message in the local msgs copy
            // so the LLM sees the limit and can communicate it. This does not persist.
            if (lastUserMsg) {
              lastUserMsg.parts = [
                ...lastUserMsg.parts,
                {
                  type: "text" as const,
                  id: PartID.ascending(),
                  sessionID,
                  messageID: lastUserMsg.info.id,
                  text: "\n\n[System note: This plan has reached the maximum revision limit (5). Please inform the user and suggest finalizing the plan or starting a new planning session.]",
                  synthetic: true,
                },
              ]
            }
          } else {
            planRevisionCount++

            // Refinement qualifiers: if the user says "yes, but ..." or "approve, however ..."
            // they intend to refine, not approve. Check for these before pure approval.
            const refinementQualifiers = [
              " but ",
              " however ",
              " except ",
              " change ",
              " modify ",
              " update ",
              " instead ",
              " although ",
              " with the following",
              " with these",
            ]
            const hasRefinementQualifier = refinementQualifiers.some((q) => userText.includes(q))

            const rejectionPhrases = [
              "don't",
              "stop",
              "reject",
              "not good",
              "not approve",
              "not approved",
              "disapprove",
              "undo",
              "abort",
              "start over",
              "wrong",
            ]
            // "no" as a standalone word to avoid matching "know", "notion", etc.
            const rejectionWords = ["no"]
            const approvalPhrases = [
              "looks good",
              "proceed",
              "approved",
              "approve",
              "lgtm",
              "go ahead",
              "ship it",
              "yes",
              "perfect",
            ]

            const isRejectionPhrase = rejectionPhrases.some((phrase) => userText.includes(phrase))
            const isRejectionWord = rejectionWords.some((word) => {
              const regex = new RegExp(`\\b${word}\\b`)
              return regex.test(userText)
            })
            const isRejection = isRejectionPhrase || isRejectionWord
            // Use word-boundary matching for approval phrases to avoid false positives
            // e.g. "this doesn't look good" should NOT match "looks good"
            const isApproval =
              !isRejection &&
              !hasRefinementQualifier &&
              approvalPhrases.some((phrase) => {
                const regex = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "i")
                return regex.test(userText)
              })
            const action = isRejection ? "reject" : isApproval ? "approve" : "refine"
            Telemetry.track({
              type: "plan_revision",
              timestamp: Date.now(),
              session_id: sessionID,
              revision_number: planRevisionCount,
              action,
            })
          }
        }
      }
      // altimate_change end

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: MessageID.ascending(),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
        // altimate_change start — keep nudge delivery scoped to this prompt generation
        nudgeGeneration,
        // altimate_change end
      })
      using _ = defer(() => InstructionPrompt.clear(processor.message.id))

      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      // altimate_change start (AI-7519) — trace resolveTools per step.
      // Included in the parent `bootstrap` span on step===1; on later steps
      // this measures the per-turn tool-listing overhead (MCP.tools connect
      // cost etc.). Distinct span name per phase so telemetry doesn't
      // double-count non-bootstrap turns under "bootstrap.*", and the TUI
      // falls back to the safe "Thinking..." label on later turns.
      const catalog = () =>
        traceSpan(
          step === 1 ? "bootstrap.resolve-tools" : "turn.resolve-tools",
          () =>
            resolveTools({
              agent,
              session,
              model,
              tools: lastUser.tools,
              processor,
              bypassAgentCheck,
              messages: msgs,
            }),
          { step, agent: agent.name },
          sessionID,
        )
      // Workspace engine turn boundary, on the turn's FIRST catalog (not its first
      // loop iteration — a compaction can run before any catalog): reconcile the
      // bound workspace's engine (re-link, one retry on a failed handshake), settle
      // this session's outcome, announce it once per verdict — then catalog the
      // tools under the same per-directory lock, so another session's boundary
      // cannot replace the engine between this reconcile and this snapshot. The
      // cold engine boot happens inside MCP's own bootstrap, bounded by its
      // per-server timeout. Later catalogs keep the engine tools this turn started
      // with.
      const firstCatalog = !catalogued
      catalogued = true
      const tools = firstCatalog ? await WorkspaceEngine.atTurnStart(sessionID, catalog) : await catalog()
      WorkspaceEngine.pinTurnTools(sessionID, firstCatalog, tools)
      // altimate_change end

      // Inject StructuredOutput tool if JSON schema mode enabled
      if (lastUser.format?.type === "json_schema") {
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: lastUser.format.schema,
          onSuccess(output) {
            structuredOutput = output
          },
        })
      }

      if (step === 1) {
        // altimate_change start - reset training session tracking to avoid stale applied counts
        MemoryPrompt.resetSession()
        // altimate_change end
        // altimate_change start - workspace memory: one fetch per session, held as an
        // in-memory overlay merged at injection time. Started rather than awaited so
        // the turn proceeds immediately; MemoryPrompt.inject applies a bounded wait.
        //
        // This block runs on EVERY user turn (see the comment below on `step === 1`),
        // so `hydrate` is idempotent per session id and is deliberately not preceded
        // by a reset — resetting here made every turn refetch, and cleared the overlay
        // before the refetch, so workspace memory blinked out of the prompt whenever a
        // fetch ran long.
        void WorkspaceMemory.hydrate(sessionID).catch(() => {})
        // altimate_change end
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
        // altimate_change start — session start telemetry
        // Agent name routed through normalizeAgentName so session_start and the
        // downstream agent_outcome event always agree on the canonical bucket
        // (funnel analysis from start → outcome would otherwise drop legacy
        // "build" sessions). See the helper at the top of this namespace.
        Telemetry.track({
          type: "session_start",
          timestamp: Date.now(),
          session_id: sessionID,
          model_id: model.id,
          provider_id: model.providerID,
          agent: normalizeAgentName(lastUser.agent),
          project_id: Instance.project?.id ?? "",
          os: process.platform,
          arch: process.arch,
          node_version: process.version,
          // altimate_change start — per-session source override: VS Code extensions set
          // metadata.source (e.g. "datamates", "poweruser") when creating the session via POST /session.
          // This lets both extensions share the same altimate serve process while producing
          // distinguishable session_start telemetry. session_start carries this per-session value;
          // events without their own `source` fall back to the process-level Flag.ALTIMATE_CLI_CLIENT
          // injected in telemetry, so per-extension attribution of those events requires a join on
          // session_id. metadata is arbitrary client JSON, so type-guard source and fall back to the
          // flag if it is absent or not a string (a non-string would otherwise be routed to
          // measurements downstream instead of appearing as the source property).
          source:
            (typeof session.metadata?.source === "string" ? session.metadata.source : undefined) ??
            Flag.ALTIMATE_CLI_CLIENT,
          // altimate_change end
        })
        // altimate_change start — task intent classification (keyword/regex, zero LLM cost)
        const userMsg = msgs.find((m) => m.info.id === lastUser!.id)
        if (userMsg) {
          const userText = userMsg.parts
            .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.ignored && !p.synthetic)
            .map((p) => p.text)
            .join("\n")
          if (userText.length > 0) {
            const { intent, confidence } = Telemetry.classifyTaskIntent(userText)
            const fp = Fingerprint.get()
            const warehouseType =
              fp?.tags.find((t) =>
                [
                  "snowflake",
                  "bigquery",
                  "redshift",
                  "databricks",
                  "postgres",
                  "mysql",
                  "sqlite",
                  "duckdb",
                  "trino",
                  "spark",
                  "clickhouse",
                ].includes(t),
              ) ?? "unknown"
            Telemetry.track({
              type: "task_classified",
              timestamp: Date.now(),
              session_id: sessionID,
              intent: intent as any,
              confidence,
              warehouse_type: warehouseType,
            })
          }
        }
        // altimate_change end — task intent classification
        // altimate_change start — onboarding funnel: first free-text prompt.
        //
        // Three guards, each load-bearing:
        //   - `step === 1` (the enclosing block) is NOT "first message of the session". `step`
        //     is declared inside loop() and loop() runs once per user turn, so this block runs
        //     on every turn. `claimFirstPrompt` is what makes this once-per-session.
        //   - `isOnboardingSession` scopes it to the funnel. Without it, an onboarding-taxonomy
        //     event would fire for every session in the product — TUI, `run`, GitHub, API.
        //   - `consumeCommandSubmission` excludes slash commands, because the scan gate submits
        //     a hidden `/onboard-connect` as an ordinary user message: it would otherwise be
        //     recorded as the user's first typed prompt in every fresh onboarding.
        //   - a real text part, because a message carrying only attachments (a dragged-in file,
        //     a pasted image) reached this block too and was recorded as the user's first typed
        //     prompt before they had typed anything. Same filter as the intent classifier above.
        const fromCommand = OnboardingTelemetry.consumeCommandSubmission(sessionID)
        const hasUserText = !!userMsg?.parts.some(
          (p) => p.type === "text" && !p.ignored && !p.synthetic && p.text.trim().length > 0,
        )
        if (
          !fromCommand &&
          hasUserText &&
          OnboardingTelemetry.isOnboardingSession(sessionID) &&
          OnboardingTelemetry.claimFirstPrompt(sessionID)
        ) {
          void OnboardingTelemetry.emit({ type: "first_prompt_sent" }, sessionID)
        }
        // altimate_change end
        // altimate_change end — session start telemetry
      }

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of msgs) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

      // altimate_change — the current date is provided via the ambient <env> block in the system
      // prompt (see session/system.ts), NOT appended to the trailing user message: appending it
      // made models echo the date back on every turn.

      // Build system prompt, adding structured output instruction if needed
      const skills = await SystemPrompt.skills(agent)
      // altimate_change start - unified context-aware injection for memory + training
      const knowledgeInjection = Flag.ALTIMATE_DISABLE_MEMORY
        ? ""
        : await MemoryPrompt.inject(UNIFIED_INJECTION_BUDGET, {
            agent: agent.name,
            disableTraining: Flag.ALTIMATE_DISABLE_TRAINING,
            sessionID,
          })
      // altimate_change end
      // altimate_change start — workspace tool awareness.
      // Reads the snapshot `Precedence.refresh` stored for this turn during tool
      // resolution, so the section, the tool descriptions and the mid-turn `check()`
      // verdict all derive from one object. This runs on every step of the loop, not
      // once per turn, so it stays a cheap pure render. Yields "" unless a bound
      // workspace's engine is attributed AND its tools materialised — so a session
      // with no workspace assembles exactly the array it did before this shipped.
      const workspaceAwareness = Awareness.systemSection(Precedence.forSession(sessionID))
      // altimate_change end
      const system = [
        ...(await SystemPrompt.environment(model)),
        ...(skills ? [skills] : []),
        ...(knowledgeInjection ? [knowledgeInjection] : []),
        // altimate_change start — workspace routing directive
        ...(workspaceAwareness ? [workspaceAwareness] : []),
        // altimate_change end
        ...(await InstructionPrompt.system()),
        ...hoistedReminders,
      ]
      // altimate_change start — run-mode-only completion instruction. This text
      // used to sit in builder.txt, but builder is a PRIMARY agent, so it also
      // reached interactive chat, where nothing interprets or strips the token
      // and the user saw a literal DONE on every final answer. Scoped to run
      // mode AND to builder, which reproduces the previous run-mode behaviour
      // exactly — builder was the only agent prompt that carried it.
      const completionInstruction = SessionTermination.completionInstruction({
        runMode: Flag.ALTIMATE_RUN_MODE,
        agent: agent.name,
      })
      if (completionInstruction) system.push(completionInstruction)
      // altimate_change end
      const format = lastUser.format ?? { type: "text" }
      if (format.type === "json_schema") {
        system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
      }

      // altimate_change start - trace system prompt once per loop() call.
      // The system prompt is functionally identical across steps within a single
      // loop() invocation (same agent, same environment). Agent switches re-enter
      // loop() with step reset to 0, so each agent's prompt is traced separately.
      if (step === 1) {
        Tracer.active?.logSpan({
          name: "system-prompt",
          startTime: Date.now(),
          endTime: Date.now(),
          input: { agent: agent.name, step },
          output: { parts: system.length, content: system.join("\n\n") },
        })
        // altimate_change start (AI-7519) — emit the parent bootstrap span
        // covering everything from loop() entry to just-before-first-generation.
        // Companion sub-spans (bootstrap.session-get, bootstrap.config-get,
        // bootstrap.resolve-tools, etc.) are already emitted; this span gives
        // the waterfall a single top-level duration to render + gate against.
        // Capture endTime once so duration_ms is guaranteed to match — two
        // Date.now() calls can straddle a clock tick.
        const bootstrapEnd = Date.now()
        Tracer.active?.logSpan({
          name: "bootstrap",
          startTime: bootstrapStart,
          endTime: bootstrapEnd,
          input: { agent: agent.name, sessionID },
          output: {
            duration_ms: bootstrapEnd - bootstrapStart,
            system_parts: system.length,
          },
        })
        // altimate_change end
      }
      // altimate_change end

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system,
        messages: [
          ...(await MessageV2.toModelMessages(msgs, model)),
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ],
        tools,
        model,
        toolChoice: format.type === "json_schema" ? "required" : undefined,
      })

      // If structured output was captured, save it and exit immediately
      // This takes priority because the StructuredOutput tool was called successfully
      if (structuredOutput !== undefined) {
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await Session.updateMessage(processor.message)
        break
      }

      // Check if model finished (finish reason is not "tool-calls" or "unknown")
      const modelFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)

      if (modelFinished && !processor.message.error) {
        if (format.type === "json_schema") {
          // Model stopped without calling StructuredOutput tool
          processor.message.error = new MessageV2.StructuredOutputError({
            message: "Model did not produce structured output",
            retries: 0,
          }).toObject()
          await Session.updateMessage(processor.message)
          break
        }
      }

      // altimate_change start — accumulate session metrics
      sessionTotalCost += processor.message.cost ?? 0
      const t = processor.message.tokens
      sessionTotalTokens += t.input + t.output + t.reasoning + t.cache.read + t.cache.write
      const stepParts = await MessageV2.parts(processor.message.id)
      toolCallCount += stepParts.filter((p) => p.type === "tool").length
      if (processor.message.error) sessionHadError = true
      // altimate_change start — capture last message error for agent_outcome reason
      if (processor.message.error) {
        const err = processor.message.error as any
        try {
          const name = typeof err?.name === "string" ? err.name : "unknown"
          const rawMessage = typeof err?.data?.message === "string" ? err.data.message : ""
          const masked = rawMessage ? Telemetry.maskString(rawMessage).slice(0, 300) : ""
          lastMessageError = masked ? `${name}: ${masked}` : String(name)
        } catch {
          lastMessageError = "unknown"
        }
      }
      // altimate_change end
      // altimate_change start — quality signal + tool chain + error fingerprints
      const toolParts = stepParts.filter((p) => p.type === "tool")
      for (const part of toolParts) {
        if (part.type !== "tool") continue
        const toolType = part.tool.startsWith("mcp__") ? ("mcp" as const) : ("standard" as const)
        const toolCategory = Telemetry.categorizeToolName(part.tool, toolType)
        lastToolCategory = toolCategory
        // altimate_change start — track last tool name for agent_outcome diagnostics
        lastToolName = part.tool
        // altimate_change end
        if (toolChain.length < 50) toolChain.push(part.tool)
        const isError = part.state?.status === "error"
        if (isError) {
          toolErrorCount++
          // Flush previous unrecovered error before recording new one
          if (pendingError) {
            if (errorRecords.length < 200) errorRecords.push({ ...pendingError, recovered: false, recoveryTool: "" })
          }
          lastToolWasError = true
          const errorMsg =
            part.state.status === "error" && typeof part.state.error === "string" ? part.state.error : "unknown"
          const masked = Telemetry.maskString(errorMsg).slice(0, 500)
          pendingError = {
            toolName: part.tool,
            toolCategory,
            errorClass: Telemetry.classifyError(errorMsg),
            errorHash: Telemetry.hashError(masked),
          }
        } else {
          if (lastToolWasError && pendingError) {
            errorRecoveryCount++
            if (errorRecords.length < 200)
              errorRecords.push({ ...pendingError, recovered: true, recoveryTool: part.tool })
            pendingError = null
          }
          lastToolWasError = false
        }
      }
      // Flush unrecovered error at end of step
      if (pendingError && !lastToolWasError) {
        errorRecords.push({ ...pendingError, recovered: false, recoveryTool: "" })
        pendingError = null
      }
      // altimate_change end — quality signal + tool chain + error fingerprints
      // altimate_change end — accumulate session metrics

      // altimate_change start — detect plan file creation after tool calls
      if (agent.name === "plan" && !planHasWritten) {
        const planPath = Session.plan(session)
        planHasWritten = await Filesystem.exists(planPath)
      }
      // altimate_change end

      // altimate_change start — validator dispatch (harness-side completion gate)
      // Fires when the model declares a clean stop on this step (finish === "stop"
      // and no tool calls outstanding). Runs all registered validators that
      // declare themselves applicable to this session. If any validator says
      // the work is not done, the framework injects a synthetic user message
      // describing the gap and continues the loop — the model gets one more
      // turn to fix the issue. Bounded by a per-session retry budget; once
      // exhausted the loop falls through to the natural break.
      //
      // Feature flag: ALTIMATE_VALIDATORS_ENABLED=1 opts in. Default OFF so
      // existing sessions are unaffected until validators are vetted in
      // production.
      //
      // ALTIMATE_VALIDATORS_SHADOW=1 runs validators WITHOUT enforcement so
      // telemetry can measure "would have fired" rates against historical
      // traffic. Shadow suppresses ONLY the synthetic-message retry: every
      // applicable validator still executes in full, including the two that
      // spawn one `altimate-dbt` child per touched model. Shadow is therefore
      // free of behavioural risk but NOT free of cost — it pays the same
      // filesystem scans, subprocess time and warehouse work as enforcement,
      // just without acting on the result. Budget for it accordingly.
      //
      // By default NEITHER flag is set, so non-opting-in sessions skip the
      // entire dispatch path (no fs scan, no subprocess spawn, no perf tax).
      const validatorsEnabled = process.env.ALTIMATE_VALIDATORS_ENABLED === "1"
      const validatorsShadow = process.env.ALTIMATE_VALIDATORS_SHADOW === "1"
      const validatorsActive = validatorsEnabled || validatorsShadow
      const maxValidatorRetries = Number(process.env.ALTIMATE_VALIDATORS_MAX_RETRIES ?? "3")
      const validatorsDebug = process.env.ALTIMATE_VALIDATORS_DEBUG === "1"
      const validatorCount = ValidatorRegistry.list().length
      const validatorExplicitDone = SessionTermination.explicitDoneStop({
        finish: processor.message.finish,
        hasError: processor.message.error !== undefined,
        parts: stepParts,
      })
      // Always emit to opencode's file log. Mirror to stderr only when
      // ALTIMATE_VALIDATORS_DEBUG=1 — needed during framework bring-up so
      // automated harness logs capture the hook signal, but noisy enough
      // that we keep it off by default for normal sessions.
      const diag = {
        kind: "validator_hook_reached",
        sessionID,
        step,
        result,
        finish: processor.message.finish,
        hasError: Boolean(processor.message.error),
        validatorsEnabled,
        validatorCount,
        validatorRetryCount,
      }
      log.info("validator_hook_reached", diag)
      if (validatorsDebug) {
        // eslint-disable-next-line no-console
        console.error("[altimate-validators] " + JSON.stringify(diag))
      }
      if (
        shouldDispatchValidators({
          active: validatorsActive,
          result,
          finish: processor.message.finish,
          hasError: processor.message.error !== undefined,
          validatorCount,
          explicitDone: validatorExplicitDone,
        })
      ) {
        try {
          const vCtx = {
            sessionID,
            workingDirectory: Instance.directory,
            sessionStartMs: sessionStartTime,
            step,
            retryCount: validatorRetryCount,
          }
          if (validatorsDebug) {
            // eslint-disable-next-line no-console
            console.error(
              "[altimate-validators] " +
                JSON.stringify({
                  kind: "dispatch_enter",
                  sessionID,
                  step,
                  cwd: vCtx.workingDirectory,
                  sessionStartMs: vCtx.sessionStartMs,
                }),
            )
          }
          const checks = await ValidatorRegistry.runAll(vCtx)
          if (validatorsDebug) {
            // eslint-disable-next-line no-console
            console.error(
              "[altimate-validators] " +
                JSON.stringify({
                  kind: "dispatch_result",
                  sessionID,
                  step,
                  checks_count: checks.length,
                  results: checks.map((c) => ({ name: c.validator.name, ok: c.result.ok, details: c.result.details })),
                }),
            )
          }
          const failures = checks.filter((c) => !c.result.ok)

          // Telemetry: emit one event per validator that ran, plus a session
          // rollup. Always emitted, even when the feature flag is off, so we
          // can measure baseline fire rate vs prompt-only enforcement.
          for (const { validator, result: vRes } of checks) {
            // Several validators' `details` carry absolute filesystem paths
            // (dbt project root, run_results.json path, discovered task
            // file, …) for use in `reason`/`fixHint` text. Forwarded
            // verbatim, that sends local directory names — and the
            // usernames often embedded in them — to telemetry despite the
            // documented contract that file paths are never collected
            // (docs/docs/reference/telemetry.md). sanitizeTelemetryDetails
            // hashes any absolute-path-shaped string; everything else
            // (verdict enums, counters, model names) passes through.
            Telemetry.track({
              type: "validator_check",
              timestamp: Date.now(),
              session_id: sessionID,
              validator_name: validator.name,
              ok: vRes.ok,
              step,
              retry_count: validatorRetryCount,
              enforced: validatorsEnabled,
              ...(vRes.details && { details: sanitizeTelemetryDetails(vRes.details) }),
            } as any)
          }

          if (failures.length > 0 && validatorsEnabled && validatorRetryCount < maxValidatorRetries) {
            // Build a single synthetic user-turn body that aggregates every
            // failing validator's reason + fixHint. The agent sees this as
            // the next user message and gets one more turn to address it.
            const body = failures
              .map(({ validator, result: vRes }) => {
                const head = `[altimate-validator: ${validator.name}] ${vRes.reason ?? "validation failed"}`
                const tail = vRes.fixHint ? `\n${vRes.fixHint}` : ""
                return head + tail
              })
              .join("\n\n")

            log.info("validator failures detected, injecting synthetic user turn", {
              sessionID,
              failures: failures.map((f) => f.validator.name),
              retry: validatorRetryCount + 1,
            })

            const syntheticMessageID = MessageID.ascending()
            await Session.updateMessage({
              id: syntheticMessageID,
              role: "user" as const,
              sessionID,
              time: { created: Date.now() },
              agent: lastUser.agent,
              model: lastUser.model,
            } as MessageV2.Info)

            // Append the validator body as a text part on the new user message.
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: syntheticMessageID,
              sessionID,
              type: "text",
              synthetic: true,
              text: body,
              time: { start: Date.now(), end: Date.now() },
            })

            validatorRetryCount++
            continue
          } else if (failures.length > 0 && validatorsEnabled && validatorRetryCount >= maxValidatorRetries) {
            // Retry budget exhausted with outstanding failures. Session will
            // terminate on the natural break below. Emit an explicit signal so
            // the operator dashboard can distinguish "completed cleanly" from
            // "completed with unresolved validator failures".
            log.warn("validator retries exhausted, session terminating with unresolved failures", {
              sessionID,
              failures: failures.map((f) => f.validator.name),
            })
            Telemetry.track({
              type: "validator_retries_exhausted",
              timestamp: Date.now(),
              session_id: sessionID,
              step,
              validator_names: failures.map((f) => f.validator.name),
            } as any)
          }
        } catch (e) {
          // A bug in the validator framework should never block the agent loop.
          log.warn("validator dispatch errored, skipping", {
            sessionID,
            error: e instanceof Error ? e.message : String(e),
          })
          if (validatorsDebug) {
            // eslint-disable-next-line no-console
            console.error(
              "[altimate-validators] " +
                JSON.stringify({
                  kind: "dispatch_error",
                  sessionID,
                  step,
                  error: e instanceof Error ? e.message : String(e),
                }),
            )
          }
        }
      }
      // altimate_change end

      if (result === "stop") break
      if (result === "compact") {
        // altimate_change start — track compaction count
        compactionCount++
        // altimate_change end
        // altimate_change start — task-pin livelock guard (see the
        // proactive-overflow site above for rationale).
        SessionCompaction.notePinCompaction(sessionID, msgs)
        // altimate_change end
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
          overflow: !processor.message.finish,
        })
      }
      continue
    }
    // altimate_change start — the generation-scoped disposer publishes the
    // sole normal idle transition after removing this loop from state. Abort
    // and processor-error paths may already be idle; the disposer detects that.
    // altimate_change end
    SessionCompaction.prune({ sessionID })
    // altimate_change start — session end telemetry
    const outcome = abort.aborted
      ? "aborted"
      : sessionHadError
        ? "error"
        : sessionTotalCost === 0 && toolCallCount === 0
          ? "abandoned"
          : "completed"
    // altimate_change start — emit quality signal, tool chain, and error fingerprint events
    Telemetry.track({
      type: "task_outcome_signal",
      timestamp: Date.now(),
      session_id: sessionID,
      signal: Telemetry.deriveQualitySignal(outcome),
      tool_count: toolCallCount,
      step_count: step,
      duration_ms: Date.now() - sessionStartTime,
      last_tool_category: lastToolCategory || "none",
    })
    // Tool chain effectiveness — aggregated tool sequence + outcome
    if (toolChain.length > 0) {
      Telemetry.track({
        type: "tool_chain_outcome",
        timestamp: Date.now(),
        session_id: sessionID,
        chain: JSON.stringify(toolChain),
        chain_length: toolChain.length,
        had_errors: toolErrorCount > 0,
        error_recovery_count: errorRecoveryCount,
        final_outcome: outcome,
        total_duration_ms: Date.now() - sessionStartTime,
        total_cost: sessionTotalCost,
      })
    }
    // Flush any pending unrecovered error
    if (pendingError) {
      errorRecords.push({ ...pendingError, recovered: false, recoveryTool: "" })
    }
    // Error fingerprints — one event per unique error (capped at 20)
    for (const err of errorRecords.slice(0, 20)) {
      Telemetry.track({
        type: "error_fingerprint",
        timestamp: Date.now(),
        session_id: sessionID,
        error_hash: err.errorHash,
        error_class: err.errorClass,
        tool_name: err.toolName,
        tool_category: err.toolCategory,
        recovery_successful: err.recovered,
        recovery_tool: err.recoveryTool,
      })
    }
    // altimate_change end — emit quality signal, tool chain, and error fingerprint events
    // altimate_change start — populate agent_outcome diagnostic fields
    const abortReason: string | null = abort.aborted
      ? typeof abort.reason === "string"
        ? abort.reason
        : abort.reason instanceof Error
          ? abort.reason.message
          : abort.reason
            ? "non_string_reason"
            : null
      : null
    const lastErrorClass = errorRecords.length > 0 ? errorRecords[errorRecords.length - 1].errorClass : ""
    const diag = Telemetry.deriveAgentOutcomeReason({
      outcome,
      lastToolName: lastToolName || null,
      lastMessageError: lastMessageError || null,
      abortReason,
      lastErrorClass,
    })
    // altimate_change end
    Telemetry.track({
      type: "agent_outcome",
      timestamp: Date.now(),
      session_id: sessionID,
      // altimate_change start — route through normalizeAgentName (shared with
      // session_start above) so the two events always agree on the bucket name.
      // See the helper at the top of this namespace for the legacy-name policy.
      agent: normalizeAgentName(sessionAgentName),
      // altimate_change end
      tool_calls: toolCallCount,
      generations: step,
      duration_ms: Date.now() - sessionStartTime,
      cost: sessionTotalCost,
      compactions: compactionCount,
      outcome,
      // altimate_change start — agent_outcome diagnostic fields
      final_tool: diag.final_tool,
      error_class: diag.error_class,
      reason: diag.reason,
      // altimate_change end
    })
    if (!emergencySessionEndFired) {
      emergencySessionEndFired = true
      process.off("beforeExit", emergencySessionEnd)
      process.off("exit", emergencySessionEnd)
      Telemetry.track({
        type: "session_end",
        timestamp: Date.now(),
        session_id: sessionID,
        total_cost: sessionTotalCost,
        total_tokens: sessionTotalTokens,
        tool_call_count: toolCallCount,
        duration_ms: Date.now() - sessionStartTime,
      })
    }
    await Telemetry.shutdown()
    // altimate_change end
    // altimate_change start — resolve callbacks from this prompt generation only
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      // Resolve only callers queued on THIS loop generation. A cancelled loop
      // may finish unwinding after a replacement generation has already begun;
      // looking callbacks up through mutable global state would resolve the
      // replacement's queue with this stale result.
      const queued = generation?.callbacks.splice(0) ?? []
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    // altimate_change end
    throw new Error("Impossible")
  })

  async function lastModel(sessionID: SessionID) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  /** @internal Exported for testing */
  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: MessageV2.WithParts[]
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}

    // altimate_change start — carry tool identity into repeated-id metadata lookup
    const context = (toolName: string, args: any, options: ToolCallOptions) => {
      const execution = input.processor.beginToolExecution(options.toolCallId)
      const ctx: Tool.Context = {
        sessionID: input.session.id,
        abort: options.abortSignal!,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
        agent: input.agent.name,
        // altimate_change start — fork MessageV2.WithParts ≡ core SessionV1.WithParts at the Tool.Context boundary
        messages: input.messages as unknown as Tool.Context["messages"],
        // altimate_change end
        metadata: (val: { title?: string; metadata?: any }) =>
          // altimate_change start — Tool.Context.metadata/ask now return Effect (v1.17.9)
          Effect.promise(async () => {
            const match =
              input.processor.partFromToolExecution(execution) ??
              input.processor.partFromToolCall(options.toolCallId, { toolName, input: args })
            if (match && match.state.status === "running") {
              await Session.updatePart({
                ...match,
                state: {
                  title: val.title,
                  metadata: val.metadata,
                  status: "running",
                  input: args,
                  time: {
                    start: Date.now(),
                  },
                },
              })
            }
          }),
        ask: (req) =>
          Effect.promise(async () => {
            // altimate_change start — core PermissionV1.Request uses readonly arrays; ask() validates the shape at runtime
            await PermissionNext.ask({
              ...req,
              sessionID: input.session.id,
              tool: { messageID: input.processor.message.id, callID: options.toolCallId },
              ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
            } as Parameters<typeof PermissionNext.ask>[0])
            // altimate_change end
          }),
        // altimate_change end
      }
      return { ctx, execution }
    }
    // altimate_change end

    // altimate_change start — workspace precedence.
    // Derived once per turn from the LIVE tool map rather than cached at attach:
    // precedence is a pure function of the materialised set, and `MCP.tools()` is
    // cache-invalidated by the `tools/list_changed` notification, so re-deriving here
    // is what keeps precedence correct when an engine's tool set changes under us.
    // Resolved before the loops below because both sides' descriptions depend on it.
    const mcpTools = await MCP.tools()
    const precedence = await Precedence.refresh(
      input.session.id,
      mcpTools,
      PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
    )
    // altimate_change end

    for (const item of await ToolRegistry.tools(
      { modelID: ModelID.make(input.model.api.id), providerID: input.model.providerID },
      input.agent,
    )) {
      // altimate_change start — v1.17.9: tool parameters are Effect Schema; derive JSON Schema via ToolJsonSchema
      const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
      // altimate_change end
      tools[item.id] = tool({
        id: item.id as any,
        // altimate_change start — name the workspace on the native side too
        description: Precedence.describeNativeTool(item.id, item.description, precedence),
        // altimate_change end
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          // altimate_change start — disambiguate repeated concurrent tool-call ids
          const { ctx, execution } = context(item.id, args, options)
          // altimate_change end
          // altimate_change start — release the execution identity on every exit path
          try {
            await Plugin.trigger(
              "tool.execute.before",
              {
                tool: item.id,
                sessionID: ctx.sessionID,
                callID: ctx.callID,
              },
              {
                args,
              },
            )
            // altimate_change start — v1.17.9: Tool.Def.execute returns an Effect
            const result = await AppRuntime.runPromise(item.execute(args, ctx))
            // altimate_change end
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            // altimate_change start — stamp authoritative tool source so clients render the right
            // badge. Shared with SessionTools.resolve (session/tools.ts) so the resolvers can't drift.
            const stamped = stampRegistryToolSource(output, item)
            // altimate_change end
            await Plugin.trigger(
              "tool.execute.after",
              {
                tool: item.id,
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                args,
              },
              // altimate_change start — plugins observe the source-stamped output
              stamped,
              // altimate_change end
            )
            // altimate_change start — return the source-stamped output
            return stamped
            // altimate_change end
          } finally {
            input.processor.finishToolExecution(execution)
          }
          // altimate_change end
        },
      })
    }

    // altimate_change start — split the original client name off the model-facing tool object so
    // it's used only for source classification and never leaks into the schema sent to the model.
    for (const [key, entry] of Object.entries(mcpTools)) {
      const { client: clientName, ...item } = entry
      // altimate_change start — mark the engine tools that now serve a shadowed capability
      item.description = Precedence.describeEngineTool(key, item.description ?? "", precedence)
      // altimate_change end
      // altimate_change end
      const execute = item.execute
      if (!execute) continue

      const schemaResult = asSchema(item.inputSchema) as { jsonSchema: any }
      const transformed = ProviderTransform.schema(input.model, schemaResult.jsonSchema)
      item.inputSchema = jsonSchema(transformed)
      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        // altimate_change start — disambiguate repeated concurrent tool-call ids
        const { ctx, execution } = context(key, args, opts)
        // altimate_change end
        // altimate_change start — release the execution identity on every exit path
        try {
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: key,
              sessionID: ctx.sessionID,
              callID: opts.toolCallId,
            },
            {
              args,
            },
          )

          // altimate_change start — upstream_fix: ctx.ask is Effect-valued; `await` on it only awaits the
          // Effect object and NEVER runs PermissionNext.ask, so MCP tools executed with NO permission
          // check. Run the effect (matches the normal tool path's AppRuntime.runPromise(item.execute)).
          await AppRuntime.runPromise(
            ctx.ask({
              permission: key,
              metadata: {},
              patterns: ["*"],
              always: ["*"],
            }),
          )
          // altimate_change end

          const result = await execute(args, opts)

          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: key,
              sessionID: ctx.sessionID,
              callID: opts.toolCallId,
              args,
            },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []

          for (const contentItem of result.content) {
            if (contentItem.type === "text") {
              textParts.push(contentItem.text)
            } else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) {
                textParts.push(resource.text)
              }
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
          // altimate_change start — authoritative source + readable title from the original client
          // name, shared with SessionTools.resolve (session/tools.ts) so the resolvers can't drift.
          const described = describeMcpTool(key, clientName)
          // altimate_change end
          const metadata = {
            ...(result.metadata ?? {}),
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
            // altimate_change start — stamp the authoritative source badge
            source: described.source,
            // altimate_change end
          }

          return {
            // altimate_change start — MCP tools have no native title; give a readable label
            title: described.title,
            // altimate_change end
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content, // directly return content to preserve ordering when outputting to model
          }
        } finally {
          input.processor.finishToolExecution(execution)
        }
        // altimate_change end
      }
      tools[key] = item
    }

    return tools
  }

  /** @internal Exported for testing */
  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    // Remove $schema property if present (not needed for tool input)
    const { $schema, ...toolSchema } = input.schema

    return tool({
      id: "StructuredOutput" as any,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as any),
      async execute(args) {
        // AI SDK validates args against inputSchema before calling execute()
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput(result) {
        // result.output is the tool's return value (an object with `output: string`).
        const value = typeof result.output === "string" ? result.output : ((result.output as any)?.output ?? "")
        return {
          type: "text",
          value,
        }
      },
    })
  }

  async function createUserMessage(input: PromptInput) {
    const agentName = input.agent ?? (await Agent.defaultAgent())
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) =>
        agents.filter((a: any) => !a.hidden).map((a: any) => a.name),
      )
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      throw new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
    }

    // altimate_change start — agent.model carries core ProviderV2.ID/ModelV2.ID brands; re-brand to fork ProviderID/ModelID (identity at runtime)
    const resolvedModel = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const model = {
      providerID: ProviderID.make(resolvedModel.providerID),
      modelID: ModelID.make(resolvedModel.modelID),
    }
    // altimate_change end
    // Use agent.variant only when the user did not provide an explicit model
    // override; if the user picked a different model, agent.variant doesn't apply.
    const useAgentModel = !input.model
    const full =
      !input.variant && agent.variant && useAgentModel
        ? await Provider.getModel(model.providerID, model.modelID).catch(() => undefined)
        : undefined
    const variant =
      input.variant ??
      (agent.variant && useAgentModel
        ? full?.variants?.[agent.variant]
          ? agent.variant
          : agent.variant // accept agent variant even if model registry has no variants entry
        : undefined)

    const info: MessageV2.Info = {
      id: input.messageID ?? MessageID.ascending(),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.name,
      model: variant ? { ...model, variant } : model,
      system: input.system,
      format: input.format,
      variant,
    }
    using _ = defer(() => InstructionPrompt.clear(info.id))

    type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
    const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
      ...part,
      id: part.id ? PartID.make(part.id) : PartID.ascending(),
    })

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<Draft<MessageV2.Part>[]> => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const s = Filesystem.stat(filepath)

              if (s?.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI).catch(() => [])
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) {
                    limit = end - (offset - 1)
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                // altimate_change start — upstream_fix: keep ReadTool init and execute inside the same Scope.
                const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                const readCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true, model },
                  messages: [],
                  // altimate_change start — Tool.Context.metadata/ask now return Effect (v1.17.9)
                  metadata: () => Effect.void,
                  ask: () => Effect.void,
                  // altimate_change end
                }
                try {
                  const result = await AppRuntime.runPromise(
                    Effect.scoped(
                      Effect.flatMap(ReadTool, (info) => info.init()).pipe(
                        Effect.flatMap((t) => t.execute(args, readCtx)),
                      ),
                    ),
                  )
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((attachment) => ({
                        ...attachment,
                        synthetic: true,
                        filename: attachment.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({
                      ...part,
                      messageID: info.id,
                      sessionID: input.sessionID,
                    })
                  }
                } catch (error) {
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  Bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({
                      message,
                    }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                // altimate_change end

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  messages: [],
                  // altimate_change start — Tool.Context.metadata/ask now return Effect (v1.17.9)
                  metadata: () => Effect.void,
                  ask: () => Effect.void,
                  // altimate_change end
                }
                // altimate_change start — v1.17.9: ReadTool is an Effect of Info; execute returns an Effect.
                // ReadTool requires Scope.Scope — discharge it with Effect.scoped before running on AppRuntime.
                const result = await AppRuntime.runPromise(
                  Effect.scoped(
                    Effect.flatMap(ReadTool, (info) => info.init()).pipe(
                      Effect.flatMap((t) => t.execute(args, listCtx)),
                    ),
                  ),
                )
                // altimate_change end
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              FileTime.read(input.sessionID, filepath)
              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  synthetic: true,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + (await Filesystem.readBytes(filepath)).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = PermissionNext.evaluate("task", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat().map(assign))

    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: info,
        parts,
      },
    )

    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }

    return {
      info,
      parts,
    }
  }

  //
  // NOTE: `family` is a free-form, config-settable string on the model schema —
  // a connection that declares `family: "claude-*"` on a non-Anthropic gateway
  // will classify as Anthropic-like and SKIP the hoist, which reintroduces the
  // #887 refusal on that backend. This is a routing-trust input, not an
  // escalation vector (whoever sets the model config already controls the
  // prompt), but operators adding gateway models should set `family` correctly.
  //
  // Exported for testing — the hoist/classification contract is exercised
  // behaviorally in test/session/plan-layer-e2e.test.ts.
  // altimate_change start — model-family helper used by the trust-aware hoist below.
  // Uses `familyVendor` so specific family values (`claude-sonnet`, `claude-haiku`,
  // `gemini-pro`, etc.) classify correctly — an exact `family === "anthropic"`
  // check would miss the gateway-emitted specific names (#888 J1). The api.id
  // checks are lowercased and tightened to a `claude-` / `anthropic-` /
  // `anthropic/...` shape so a model named `foo-claude-bench` doesn't false-match.
  export function isAnthropicLikeModel(model: Provider.Model): boolean {
    if (model.providerID === "anthropic") return true
    if (model.providerID === "google-vertex-anthropic") return true
    if (familyVendor(model.family) === "anthropic") return true
    if (model.api.npm === "@ai-sdk/anthropic") return true
    const apiId = model.api.id.toLowerCase()
    const lastSeg = apiId.split("/").pop() ?? apiId
    if (/^claude[-_.]/.test(lastSeg)) return true
    if (/^anthropic[-_/]/.test(apiId)) return true
    return false
  }
  // altimate_change end

  // altimate_change start — pin the original task
  // verbatim through compaction.
  //
  // After compaction the model sees only a lossy summary of the task; the
  // summarizer can drop or mutate literal contract terms
  // (hallucinated table names, renamed output files). The pin re-injects the
  // task instruction VERBATIM as a trusted reminder, labeled authoritative over
  // any summary, and is hoisted into the system prompt on non-Anthropic models
  // via the trustedReminderParts path below.
  //
  // Mode-aware pin selection: run mode (`run` CLI, CI/headless — signaled
  // by the ALTIMATE_RUN_MODE marker, with ALTIMATE_NON_INTERACTIVE=1 — the same
  // signal question.ts uses — as a fallback) pins the
  // FIRST non-synthetic user message (the CLI task). Interactive sessions pin
  // the MOST RECENT substantive user instruction — users pivot mid-session, and
  // hoisting message #1 as "authoritative" would fight later redirections in
  // exactly the long sessions that compact. A RESUMED run (`--continue`,
  // `--session`, `--fork`) uses the interactive rule too: its history begins
  // with an earlier invocation's task, so "first" would pin a stale request
  // over the one this run supplied (see resolvePinRunMode).
  //
  // Budget: SessionCompaction.pinBudget — min(4k, ~17.5% of the post-overhead
  // usable window), hard invariant pin + reserved + ≥2k slack < compaction
  // threshold, halved by the livelock guard. When a task exceeds the budget we
  // keep verbatim head+tail plus a deterministic ≤500-token contract card of
  // regex-extracted literals. Never paraphrase.

  // altimate_change start — extracted from the proactive-overflow check so this
  // load-bearing context-safety estimate is unit-testable (it had no coverage).
  /**
   * Tokens present in the conversation that the provider's reported usage for
   * `lastFinishedID` does NOT include. The recorded usage is from the last
   * assistant turn, but tool results are appended to that message AFTER the
   * generation ends, and further messages accumulate before the next check —
   * one oversized output can jump the session past the window in between.
   *
   * `lastFinished`'s own TOOL parts are counted (uncounted by the provider
   * figure); its own text is not (already inside `tokens.output`).
   * Everything after it is counted in full.
   */
  export function estimateUncountedTail(msgs: MessageV2.WithParts[], lastFinishedID: MessageID | undefined): number {
    if (!lastFinishedID) return 0
    const lastFinished = msgs.find((m) => m.info.id === lastFinishedID)
    if (!lastFinished) return 0
    const toolText = (part: MessageV2.ToolPart): string => {
      if (part.state.status === "completed") {
        if (!part.state.time.compacted) return part.state.output ?? ""
        const mask = part.state.metadata?.observation_mask
        return typeof mask === "string" && mask.length > 0 ? mask : "[Old tool result content cleared]"
      }
      if (part.state.status === "error") {
        const partial = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
        return typeof partial === "string" ? partial : (part.state.error ?? "")
      }
      return "[Tool execution was interrupted]"
    }
    let tokens = 0
    for (const part of lastFinished.parts) {
      if (part.type === "tool") tokens += Token.estimate(toolText(part))
    }
    // filterCompacted deliberately reorders retained-tail and summary messages,
    // so array position is not chronology. IDs are monotonic; select genuinely
    // newer messages by ID regardless of their rendered position.
    for (const m of msgs) {
      if (m.info.id <= lastFinishedID) continue
      for (const part of m.parts) {
        if (part.type === "text") tokens += Token.estimate(part.text ?? "")
        if (part.type === "tool") tokens += Token.estimate(toolText(part))
      }
    }
    return tokens
  }
  // altimate_change end

  /** Exported for unit tests. Selects the message whose text gets pinned. */
  export function selectPinSource(
    history: MessageV2.WithParts[],
    runMode: boolean,
  ): { id: MessageID; text: string } | undefined {
    const candidates: { id: MessageID; text: string }[] = []
    for (const msg of history) {
      if (msg.info.role !== "user") continue
      if (msg.parts.some((p) => p.type === "compaction")) continue
      const text = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)
        .map((p) => p.text)
        .join("\n\n")
        .trim()
      if (!SessionCompaction.isPinnableTaskText(text)) continue
      candidates.push({ id: msg.info.id, text })
    }
    if (!candidates.length) return undefined
    return runMode ? candidates[0] : candidates[candidates.length - 1]
  }

  // Deterministic contract card: regex-extracted literals from the task text
  // (paths, identifier-shaped names, code spans, quoted terms, constraint
  // lines), every entry a verbatim substring of the original — never a
  // paraphrase. Patterns are GENERIC lexical shapes only; no vertical (dbt/
  // warehouse) tokens. Budget enforced by tail-truncation:
  // stop adding once the cap is reached.
  export function extractContractCard(text: string, capTokens: number): string {
    if (capTokens <= 0) return ""
    const seen = new Set<string>()
    const take = (raw: string | undefined) => {
      const v = raw?.trim()
      if (!v || v.length > 200 || seen.has(v)) return undefined
      seen.add(v)
      return v
    }
    const collect = (re: RegExp, group = 0) => {
      const out: string[] = []
      for (const m of text.matchAll(re)) {
        const v = take(m[group])
        if (v) out.push(v)
      }
      return out
    }
    // Paths: contain a slash, or bare filename with a dot-extension.
    const paths = collect(/(?:[\w.@~-]+\/)+[\w.-]+|\b[\w-]+\.[A-Za-z]\w{0,7}\b/g)
    // snake_case identifier shape (column/model/variable names) — generic.
    const identifiers = collect(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)
    // Inline code spans (commands, expressions).
    const codeSpans = collect(/`([^`\n]{1,160})`/g, 1)
    // Quoted terms.
    const quoted: string[] = []
    for (const m of text.matchAll(/"([^"\n]{2,120})"|'([^'\n]{2,120})'/g)) {
      const v = take(m[1] ?? m[2])
      if (v) quoted.push(v)
    }
    // Constraint/prohibition lines, kept verbatim in full.
    const constraints: string[] = []
    for (const line of text.split("\n")) {
      if (
        /\b(do not|don'?t|never|must(?: not)?|should not|shall not|avoid|only|require[sd]?|forbidden|prohibited)\b/i.test(
          line,
        )
      ) {
        const v = take(line)
        if (v) constraints.push(v)
      }
    }

    const header = "Contract card — literals extracted verbatim from the task (never paraphrased):"
    if (Token.estimate(header) > capTokens) return ""
    const out: string[] = [header]
    // Budget enforced on the ACTUAL rendered card (labels and separators
    // included), tail-truncating: stop adding once the cap would be exceeded.
    const fits = (candidate: string[]) => Token.estimate(candidate.join("\n")) <= capTokens
    const emitList = (label: string, items: string[]) => {
      if (!items.length) return
      let line = ""
      for (const item of items) {
        const next = line ? `${line}, ${item}` : `- ${label}: ${item}`
        if (!fits([...out, next])) break
        line = next
      }
      if (line) out.push(line)
    }
    emitList("files/paths", paths)
    emitList("identifiers", identifiers)
    emitList("code/commands", codeSpans)
    emitList("quoted terms", quoted)
    if (constraints.length) {
      const kept: string[] = ["- constraints (verbatim lines):"]
      for (const line of constraints) {
        const next = [...kept, `  - ${line}`]
        if (!fits([...out, ...next])) break
        kept.push(`  - ${line}`)
      }
      if (kept.length > 1) out.push(...kept)
    }
    if (out.length <= 1) return ""
    return out.join("\n")
  }

  /**
   * Exported for unit tests. Returns the pin body: the task verbatim when it
   * fits the cap; otherwise verbatim head+tail plus the contract card.
   */
  export function buildPinnedTask(input: {
    text: string
    capTokens: number
    cardCapTokens: number
  }): string | undefined {
    if (input.capTokens <= 0) return undefined
    const text = input.text
    if (Token.estimate(text) <= input.capTokens) return text
    // Slice by Unicode code points, not UTF-16 code units. Either head/tail
    // boundary can otherwise bisect a surrogate pair and persist invalid text
    // in the pinned task.
    const characters = Array.from(text)
    // Over cap: middle truncation alone deletes exactly the mid-prompt facts
    // the evidence shows decaying — pair verbatim head+tail with the card.
    const cardCap = Math.min(input.cardCapTokens, Math.floor(input.capTokens / 2))
    const card = extractContractCard(text, cardCap)
    const marker =
      "\n\n[... middle of the original task truncated — literal terms preserved in the contract card below ...]\n\n"
    const bodyBudget = input.capTokens - Token.estimate(card) - Token.estimate(marker) - 8
    if (bodyBudget <= 0) return card || undefined
    // Token.estimate is ratio-based; shrink the char budget geometrically until
    // the assembled result fits. Deterministic for a given input.
    let charBudget = Math.floor(bodyBudget * 3.7)
    while (charBudget >= 100) {
      const half = Math.floor(charBudget / 2)
      const candidate =
        characters.slice(0, half).join("") +
        marker +
        characters.slice(characters.length - half).join("") +
        (card ? "\n\n" + card : "")
      if (Token.estimate(candidate) <= input.capTokens) return candidate
      charBudget = Math.floor(charBudget * 0.85)
    }
    if (card) return card
    // A positive body budget must always be renderable; otherwise compaction
    // could omit the task from its summary while the corresponding pin silently
    // disappears. Fall back to the longest verbatim prefix that fits.
    let prefixLength = Math.min(characters.length, Math.max(1, Math.ceil(input.capTokens * 4)))
    while (prefixLength > 0) {
      const prefix = characters.slice(0, prefixLength).join("")
      if (Token.estimate(prefix) <= input.capTokens) return prefix
      prefixLength = Math.floor(prefixLength * 0.75)
    }
    return undefined
  }

  /**
   * Exported for unit tests (mid-session-redirect case is covered here without
   * DB fixtures). Pure: assembles the labeled reminder text from the full
   * chronological history and the currently visible (compaction-filtered)
   * messages, or returns undefined when no pin should be injected.
   */
  export function taskPinText(input: {
    history: MessageV2.WithParts[]
    visible: MessageV2.WithParts[]
    runMode: boolean
    capTokens: number
    cardCapTokens: number
  }): string | undefined {
    const source = selectPinSource(input.history, input.runMode)
    if (!source) return undefined
    return taskPinFromSource({
      source,
      visible: input.visible,
      capTokens: input.capTokens,
      cardCapTokens: input.cardCapTokens,
    })
  }

  function taskPinFromSource(input: {
    source: { id: MessageID; text: string }
    visible: MessageV2.WithParts[]
    capTokens: number
    cardCapTokens: number
  }): string | undefined {
    // Skip while the source message is still in visible context verbatim — the
    // pin exists to survive compaction, not to duplicate live messages.
    if (input.visible.some((m) => m.info.id === input.source.id)) return undefined
    // altimate_change start — the wrapper counts against the cap. The framing
    // below was previously added AFTER buildPinnedTask had spent the whole
    // budget, so the rendered reminder exceeded the advertised hard cap and ate
    // into the reserved working headroom the pin invariant (pin + reserved +
    // >=2k slack < compaction threshold) depends on. Budget the body against
    // cap minus the framing, and keep at least a token of body budget so a
    // tight configured cap degrades to a small pin rather than none.
    let bodyCap = SessionCompaction.taskPinBodyBudget(input.capTokens)
    // altimate_change end
    while (bodyCap > 0) {
      const body = buildPinnedTask({
        text: input.source.text,
        capTokens: bodyCap,
        cardCapTokens: Math.min(input.cardCapTokens, bodyCap),
      })
      if (!body) return undefined
      const rendered = SessionCompaction.renderTaskPin(body)
      const estimated = Token.estimate(rendered)
      if (estimated <= input.capTokens) return rendered
      // Token.estimate chooses its ratio from the COMPLETE text, so the empty
      // frame estimate is not additive. Shrink against the actual rendered
      // reminder until its hard cap is true under the final classification.
      const over = estimated - input.capTokens
      const next = Math.min(bodyCap - 1, bodyCap - over, Math.floor(bodyCap * 0.85))
      if (next >= bodyCap) return undefined
      bodyCap = Math.max(0, next)
    }
    return undefined
  }

  /**
   * Run mode = the dedicated ALTIMATE_RUN_MODE marker (set by run.ts, never by
   * TUI/serve), with ALTIMATE_NON_INTERACTIVE=1 as a fallback signal for
   * headless drivers that predate the marker. An EXPLICITLY set run-mode value
   * always wins — a user exporting ALTIMATE_RUN_MODE=0 has opted out of
   * run-mode semantics and must not be flipped back by the legacy fallback;
   * the fallback applies only when the marker is undefined/blank.
   * Exported for unit tests.
   */
  export function resolvePinRunMode(env: Record<string, string | undefined> = process.env): boolean {
    // A resumed run (`--continue` / `--session` / `--fork`, marked by run.ts)
    // carries earlier invocations' messages, so "first user message" is a
    // previous task, not this run's. Those sessions use interactive selection —
    // the latest substantive instruction — which is the request this invocation
    // actually supplied.
    if (env["ALTIMATE_RUN_RESUMED"] === "1") return false
    if (env["ALTIMATE_RUN_MODE"]?.trim()) return Flag.parseRunModeValue(env["ALTIMATE_RUN_MODE"])
    return env["ALTIMATE_NON_INTERACTIVE"] === "1"
  }

  const runPinSourceCache = Instance.state(() => new Map<SessionID, { id: MessageID; text: string }>())
  const RUN_PIN_CACHE_MAX = 128

  function rememberRunPinSource(sessionID: SessionID, source: { id: MessageID; text: string }) {
    const cache = runPinSourceCache()
    cache.delete(sessionID)
    cache.set(sessionID, source)
    if (cache.size <= RUN_PIN_CACHE_MAX) return
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }

  function pinSourceFromStream(sessionID: SessionID, runMode: boolean) {
    if (runMode) {
      const cached = runPinSourceCache().get(sessionID)
      if (cached) {
        rememberRunPinSource(sessionID, cached)
        return cached
      }
    }

    let oldest: { id: MessageID; text: string } | undefined
    // stream() is newest-first. Interactive selection can stop at the first
    // substantive user message. Fresh run mode needs the oldest source once;
    // cache that result so later compacted turns do not repeatedly scan all
    // persisted history.
    for (const message of MessageV2.stream(sessionID)) {
      const candidate = selectPinSource([message], runMode)
      if (!candidate) continue
      if (!runMode) return candidate
      oldest = candidate
    }
    if (runMode && oldest) rememberRunPinSource(sessionID, oldest)
    return oldest
  }

  // Compaction-gated entry point used by insertReminders: fires only when the
  // visible context already contains a completed summary, the pin budget is
  // positive, and the pinned source message is no longer visible.
  async function taskPinReminder(input: {
    visible: MessageV2.WithParts[]
    session: Session.Info
    model: Provider.Model
  }): Promise<string | undefined> {
    // Compaction gate FIRST — it is pure message inspection, so never-compacted
    // sessions (the common path) pay no Config/DB cost here.
    const compacted = input.visible.some(
      (m) => m.info.role === "assistant" && m.info.summary && m.info.finish && !m.info.error,
    )
    if (!compacted) return undefined
    // Fail-safe from here on: the pin is an additive reminder — a session that
    // cannot compute it must still run the turn.
    try {
      const cfg = await Config.get()
      if (!SessionCompaction.pinEnabled(cfg)) return undefined
      const cap = SessionCompaction.pinBudget({ cfg, model: input.model, sessionID: input.session.id })
      if (cap <= 0) return undefined
      const runMode = resolvePinRunMode()
      const source = pinSourceFromStream(input.session.id, runMode)
      if (!source) return undefined
      return taskPinFromSource({
        source,
        visible: input.visible,
        capTokens: cap,
        cardCapTokens: SessionCompaction.pinCardBudget(cfg),
      })
    } catch (e) {
      log.warn("task pin skipped", { error: e instanceof Error ? e.message : String(e) })
      return undefined
    }
  }
  // altimate_change end

  // altimate_change start — return the trusted reminder parts insertReminders just appended
  // so the caller can hoist them into the system prompt on non-Anthropic models.
  // The returned-parts contract is the trust boundary: only parts that *this function*
  // creates are eligible for promotion. The schema-wide `synthetic` flag is set by other
  // code paths too (file/resource expansions at lines ~1729/1751/1801 attach
  // file content as synthetic text), so it is not safe to infer trust from `synthetic`
  // alone. See #888 review feedback.
  type InsertRemindersResult = { messages: MessageV2.WithParts[]; trustedReminderParts: MessageV2.TextPart[] }
  // Exported for testing — the trust boundary (only self-injected reminders land
  // in `trustedReminderParts`, never user/file/resource content) is verified
  // behaviorally in test/session/plan-layer-e2e.test.ts.
  export async function insertReminders(input: {
    messages: MessageV2.WithParts[]
    agent: Agent.Info
    session: Session.Info
    // altimate_change start — used to bake `ignored` into the persisted experimental
    // plan-mode reminders so they don't replay as user-role `<system-reminder>` on
    // turn 2+ on non-Anthropic models (#888 J2).
    model: Provider.Model
    // altimate_change end
  }): Promise<InsertRemindersResult> {
    const trustedReminderParts: MessageV2.TextPart[] = []
    // altimate_change start — pre-compute the hoist decision once so it can be
    // applied at insertion time (including to persisted rows). For non-Anthropic
    // models, every trusted reminder is marked `ignored: true` immediately so
    // `toModelMessages` will skip it (the caller no longer needs to mutate the
    // flag, and DB-persisted rows survive the contract across turns).
    const nonAnthropic = !isAnthropicLikeModel(input.model)
    // altimate_change end
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return { messages: input.messages, trustedReminderParts }

    // altimate_change start — pin the original task
    // verbatim through compaction, hoisted via the trustedReminderParts path
    // and labeled "Original task — authoritative over any summary". The pin
    // text embeds the user's OWN instruction verbatim — the user's directive,
    // not third-party file/resource content — so promoting it through
    // trustedReminderParts does not cross the trust boundary documented above.
    // Not persisted: recomputed per turn, like the plan reminder below.
    const pinText = await taskPinReminder({ visible: input.messages, session: input.session, model: input.model })
    if (pinText) {
      const part: MessageV2.TextPart = {
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: pinText,
        synthetic: true,
        ...(nonAnthropic ? { ignored: true } : {}),
      }
      userMessage.parts.push(part)
      trustedReminderParts.push(part)
    }
    // altimate_change end

    // Original logic when experimental plan mode is disabled
    if (!Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) {
      if (input.agent.name === "plan") {
        const part: MessageV2.TextPart = {
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: PROMPT_PLAN,
          synthetic: true,
          ...(nonAnthropic ? { ignored: true } : {}),
        }
        userMessage.parts.push(part)
        trustedReminderParts.push(part)
      }
      const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
      if (wasPlan && input.agent.name === "builder") {
        const part: MessageV2.TextPart = {
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: BUILD_SWITCH,
          synthetic: true,
          ...(nonAnthropic ? { ignored: true } : {}),
        }
        userMessage.parts.push(part)
        trustedReminderParts.push(part)
      }
      return { messages: input.messages, trustedReminderParts }
    }

    // New plan mode logic when flag is enabled
    const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")

    // Switching from plan mode to build mode
    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (exists) {
        const part = await Session.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            BUILD_SWITCH + "\n\n" + `A plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
          ...(nonAnthropic ? { ignored: true } : {}),
        })
        userMessage.parts.push(part)
        trustedReminderParts.push(part as MessageV2.TextPart)
      }
      return { messages: input.messages, trustedReminderParts }
    }

    // Entering plan mode
    if (input.agent.name === "plan" && assistantMessage?.info.agent !== "plan") {
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

// altimate_change start — two-step plan approach with refinement loop
## Two-Step Plan Approach

When creating a plan:
1. FIRST, present a brief outline (3-5 bullet points) summarizing your proposed approach
2. Ask the user if this direction looks right before expanding
3. If the user wants changes, refine the outline based on their feedback
4. Only write the full detailed plan to the plan file after the user confirms the approach

When the user provides feedback on a plan you have already written:
1. Read the existing plan file
2. Incorporate their feedback into the plan
3. Update the plan file with revisions
4. Summarize what changed
// altimate_change end

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
        ...(nonAnthropic ? { ignored: true } : {}),
      })
      userMessage.parts.push(part)
      trustedReminderParts.push(part as MessageV2.TextPart)
      return { messages: input.messages, trustedReminderParts }
    }
    return { messages: input.messages, trustedReminderParts }
  }
  // altimate_change end

  export const ShellInput = z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }

    // altimate_change start — await idle restoration for shell-owned generations
    await using _ = defer(async () => {
      // If no queued callbacks, cancel (the default)
      const callbacks = state()[input.sessionID]?.callbacks ?? []
      if (callbacks.length === 0) {
        await cancel(input.sessionID)
      } else {
        // Otherwise, trigger the session loop to process queued items
        loop({ sessionID: input.sessionID, resume_existing: true }).catch((error) => {
          log.error("session loop failed to resume after shell command", { sessionID: input.sessionID, error })
        })
      }
    })
    // altimate_change end

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      // altimate_change start — fork Session.Info (index zod) ≡ core Session.Info (session.ts) at the SessionRevert boundary
      await SessionRevert.cleanup(session as unknown as Parameters<typeof SessionRevert.cleanup>[0])
      // altimate_change end
    }
    const agent = await Agent.get(input.agent)
    // altimate_change start — agent.model carries core ProviderV2.ID/ModelV2.ID brands; re-brand to fork ProviderID/ModelID (identity at runtime)
    const resolvedModel = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const model = {
      providerID: ProviderID.make(resolvedModel.providerID),
      modelID: ModelID.make(resolvedModel.modelID),
    }
    // altimate_change end
    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateMessage(userMsg)
    const userPart: MessageV2.Part = {
      type: "text",
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    const msg: MessageV2.Assistant = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    const part: MessageV2.Part = {
      type: "tool",
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    // altimate_change — upstream_fix: command expansion must honor configured shell.
    const shell = Shell.preferred((await Config.get()).shell)
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const cwd = Instance.directory
    const shellEnv = await Plugin.trigger(
      "shell.env",
      { cwd, sessionID: input.sessionID, callID: part.callID },
      { env: {} },
    )
    const proc = spawn(shell, args, {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...shellEnv.env,
        TERM: "dumb",
      },
    })

    let output = ""

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve()
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    return { info: msg, parts: [part] }
  }

  export const CommandInput = z.object({
    messageID: MessageID.zod.optional(),
    sessionID: SessionID.zod,
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  // altimate_change start — shared text formatter for /mcps runtime status (#972)
  /** @internal Exported for tests. */
  // altimate_change start — upstream_fix (#878): `/mcps` reported neither drift nor file-scoped
  // blanks, so the session view consistently showed less than `mcp list` for the same problem.
  /** Config-drift lines for `/mcps`, empty string when nothing has drifted. */
  export function formatConfigDriftForDisplay(entries: { server: string; source: string; fields: string[] }[]): string {
    return entries
      .map(
        ({ server, source, fields }) =>
          "- `" + server + "` differs from `" + source + "`: " + fields.join(", ") + " (config wins)",
      )
      .join("\n")
  }
  // altimate_change end
  // altimate_change start — upstream_fix (#701): exported so the wording is testable without
  // standing up a session; `/mcps` is otherwise only reachable through the whole handler.
  /** File-scoped blank-variable lines for `/mcps`, empty string when there are none. */
  export function formatBlankedEnvForDisplay(entries: { source: string; names: string[] }[]): string {
    return entries
      .map(({ source, names }) => "- `" + names.join(", ") + "` resolved to empty in `" + source + "` (set or remove)")
      .join("\n")
  }
  // altimate_change end

  export function formatMcpStatusForDisplay(name: string, status: MCP.Status, unresolvedEnv: string[] = []) {
    const icon = status.status === "connected" ? "\u2713" : "\u25cb"
    // upstream_fix (#701): a server whose `${VAR}` did not resolve launched with that value
    // blank — most often a password. It then fails with a downstream error naming neither the
    // variable nor the config file, and the only trace is a log line nobody opens. Say it here,
    // where the user is already looking, and say it even when the server appears connected: a
    // blank credential often connects and fails on first use.
    const blanks =
      unresolvedEnv.length > 0 ? " \u2014 unresolved: " + unresolvedEnv.join(", ") + " (set or remove)" : ""
    if (status.status === "failed") return icon + " " + status.status + " (" + status.error + ")" + blanks
    if (status.status === "needs_auth")
      return icon + " Needs authentication (run: altimate mcp auth " + name + ")" + blanks
    return icon + " " + status.status + blanks
  }
  // altimate_change end

  export async function command(input: CommandInput): Promise<MessageV2.WithParts> {
    log.info("command", input)

    // altimate_change start — /mcps enable/disable: direct handler bypasses LLM
    if (input.command === "mcps") {
      // Helper: build and persist an assistant reply for a command shortcut.
      async function respond(
        parentID: MessageID,
        responseText: string,
        model: { modelID: ModelID; providerID: ProviderID },
      ): Promise<MessageV2.WithParts> {
        const now = Date.now()
        const assistantMsg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: input.sessionID,
          parentID,
          modelID: model.modelID,
          providerID: model.providerID,
          mode: "builder",
          agent: "builder",
          path: { cwd: Instance.directory, root: Instance.worktree },
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
          time: { created: now, completed: now },
        }
        await Session.updateMessage(assistantMsg)
        const textPart: MessageV2.TextPart = {
          id: PartID.ascending(),
          sessionID: input.sessionID,
          messageID: assistantMsg.id,
          type: "text",
          text: responseText,
          time: { start: now, end: now },
        }
        await Session.updatePart(textPart)
        AppRuntime.runPromise(
          EventV2Bridge.Service.use((events) =>
            events.publish(Command.Event.Executed, {
              name: input.command,
              sessionID: input.sessionID,
              arguments: input.arguments,
              messageID: assistantMsg.id,
            }),
          ),
        )
        return { info: assistantMsg, parts: [textPart] } as MessageV2.WithParts
      }
      const trimmed = input.arguments.trim()

      if (!trimmed) {
        // /mcps (no args): return actual runtime status directly
        const userMsg = await createUserMessage({
          sessionID: input.sessionID,
          messageID: input.messageID,
          parts: [{ type: "text", text: "/mcps" }],
        })
        const model = await lastModel(input.sessionID)
        const statusMap = await MCP.status()
        const rows = Object.entries(statusMap)
          .map(
            ([srv, s]) =>
              "| `" + srv + "` | " + formatMcpStatusForDisplay(srv, s, McpDiscover.unresolvedEnvVars(srv)) + " |",
          )
          .join("\n")
        // altimate_change start — upstream_fix (#701): `/mcps` showed only the per-server
        // unresolved variables from discovery, while `mcp list` also reported file-scoped blanks.
        // A server templated as `"url": "https://{env:MY_HOST}/mcp"` records against the config
        // file rather than the server, so it appeared in the CLI and not here — in the session
        // view, which is where someone is when a server will not connect.
        const blanked = formatBlankedEnvForDisplay(ConfigVariable.blankedEnvVars())
        const drift = formatConfigDriftForDisplay(McpDiscover.configDrift())
        const table = rows ? "MCP servers:\n\n| Server | Status |\n|---|---|\n" + rows : "No MCP servers configured."
        const responseText = [table, drift, blanked].filter(Boolean).join("\n\n")
        // altimate_change end

        return respond(userMsg.info.id, responseText, model)
      }

      const subMatch = trimmed.match(/^(enable|disable)\s+(\S+)/)
      if (subMatch) {
        const [, subCmd, name] = subMatch
        const isEnable = subCmd === "enable"

        const userMsg = await createUserMessage({
          sessionID: input.sessionID,
          messageID: input.messageID,
          parts: [{ type: "text", text: `/mcps ${subCmd} ${name}` }],
        })

        const model = await lastModel(input.sessionID)
        // The workspace-managed `datamate` key is derived per process: this
        // command must not close or restart that engine, nor persist `enabled`
        // for it. Asked before the config check — a refused engine has no
        // config entry at all, and "not found" would be the wrong answer.
        const managed = name === DATAMATE_KEY ? await WorkspaceEngine.managedWorkspaceLoaded() : null
        if (managed) {
          return respond(
            userMsg.info.id,
            `MCP server **${name}** is managed by workspace **${managed.name}** in this project and cannot be ${subCmd}d here. Unlink the project, or restart with ALTIMATE_WORKSPACE unset, to manage it by hand.`,
            model,
          )
        }
        // MCP.connect/disconnect on an unknown name logs and returns silently, so
        // validate against config first and give the user a clear signal on a typo.
        const cfg = await Config.get()
        if (!cfg.mcp?.[name]) {
          const known = Object.keys(cfg.mcp ?? {})
          const suffix = known.length ? ` Known servers: ${known.join(", ")}.` : ""
          return respond(userMsg.info.id, `MCP server **${name}** not found in config.${suffix}`, model)
        }

        let responseText: string

        if (isEnable) {
          await MCP.connect(name)
          const statusMap = await MCP.status()
          const entry = statusMap[name]
          if (entry?.status === "connected") {
            responseText = `MCP server **${name}** enabled. Status: connected.`
          } else {
            const errSuffix = entry?.status === "failed" ? " — " + entry.error : ""
            responseText = `Attempted to enable MCP server **${name}**. Status: ${entry?.status ?? "unknown"}${errSuffix}.`
          }
        } else {
          await MCP.disconnect(name)
          responseText = `MCP server **${name}** disabled.`
        }

        return respond(userMsg.info.id, responseText, model)
      }
    }
    // altimate_change end

    const command = await Command.get(input.command)
    if (!command) {
      const all = await Command.list()
      const names = all
        .map((c: any) => c.name)
        .filter(Boolean)
        .sort()
      throw new NamedError.Unknown({
        message: `Command not found: "${input.command}". Available: ${names.join(", ") || "(none)"}`,
      })
    }
    const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    // altimate_change start — allow $$ARGUMENTS to produce literal $ARGUMENTS in output
    const ESCAPE_SENTINEL = "\x00ESCAPED_DOLLAR_ARGUMENTS\x00"
    let template = withArgs
      .replaceAll("$$ARGUMENTS", ESCAPE_SENTINEL)
      .replaceAll("$ARGUMENTS", input.arguments)
      .replaceAll(ESCAPE_SENTINEL, "$ARGUMENTS")
    // altimate_change end

    // If command doesn't explicitly handle arguments (no $N or $ARGUMENTS placeholders)
    // but user provided arguments, append them to the template
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      // altimate_change start — upstream_fix: command template shell
      // expansion must honor configured shell instead of Bun's default parser.
      const sh = Shell.preferred((await Config.get()).shell)
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            const proc = Bun.spawn([sh, ...Shell.args(sh, cmd, Instance.directory)], {
              // altimate_change start — upstream_fix: non-bash command-template shells need an explicit cwd.
              cwd: Instance.directory,
              // altimate_change end
              stdout: "pipe",
              stderr: "pipe",
            })
            const [stdout, stderr, exitCode] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ])
            return exitCode === 0 ? stdout : stdout || stderr
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      // altimate_change end
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const taskModelRaw = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()
    // altimate_change start — cmdAgent.model carries core ProviderV2.ID/ModelV2.ID brands; re-brand to fork ProviderID/ModelID (identity at runtime)
    const taskModel = {
      providerID: ProviderID.make(taskModelRaw.providerID),
      modelID: ModelID.make(taskModelRaw.modelID),
    }
    // altimate_change end

    try {
      await Provider.getModel(taskModel.providerID, taskModel.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    const templateParts = await resolvePromptParts(template)
    const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
    const parts = isSubtask
      ? [
          {
            type: "subtask" as const,
            agent: agent.name,
            description: command.description ?? "",
            command: input.command,
            model: {
              providerID: taskModel.providerID,
              modelID: taskModel.modelID,
            },
            // TODO: how can we make task tool accept a more complex input?
            prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...templateParts, ...(input.parts ?? [])]

    const userAgent = isSubtask ? (input.agent ?? (await Agent.defaultAgent())) : agentName
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await lastModel(input.sessionID)
      : taskModel

    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      variant: input.variant,
    })) as MessageV2.WithParts

    AppRuntime.runPromise(
      EventV2Bridge.Service.use((events) =>
        events.publish(Command.Event.Executed, {
          name: input.command,
          sessionID: input.sessionID,
          arguments: input.arguments,
          messageID: result.info.id,
        }),
      ),
    )

    return result
  }

  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: ProviderID
    modelID: ModelID
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return

    // Find first non-synthetic user message
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return

    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return

    // Gather all messages up to and including the first real user message for context
    // This includes any shell/subtask executions that preceded the user's first prompt
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      // altimate_change start — agent.model carries core ProviderV2.ID/ModelV2.ID brands; re-brand to fork ProviderID/ModelID (identity at runtime)
      if (agent.model)
        return await Provider.getModel(ProviderID.make(agent.model.providerID), ModelID.make(agent.model.modelID))
      // altimate_change end
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    const result = await LLM.stream({
      agent,
      user: firstRealUser.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : await MessageV2.toModelMessages(contextMessages, model)),
      ],
    })
    const text = await Promise.resolve(result.text).catch((err: unknown) => {
      log.error("failed to generate title", { error: err })
      return undefined
    })
    if (text) {
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line: string) => line.trim())
        .find((line: string) => line.length > 0)
      if (!cleaned) return

      const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      return Session.setTitle({ sessionID: input.session.id, title })
    }
  }

  // altimate_change start — Effect Context.Service facade over the existing Promise namespace.
  //
  // Upstream v1.17.9 composes SessionPrompt into the Effect runtime as a
  // Context.Service; consumers do `yield* SessionPrompt.Service` and call the
  // resolved methods, plus reference `SessionPrompt.defaultLayer` / `.node`.
  // The fork keeps SessionPrompt as a Promise-based namespace (imperative callers
  // still use `SessionPrompt.prompt(...)` etc.), so this facade just delegates each
  // Service method to the existing namespace function — behavior is unchanged.
  //
  // Error channels are chosen to match how consumers compose the methods:
  //   - prompt: mapped to BadRequest by the HTTP handler (any error channel works).
  //   - shell:  wrapped by SessionError.mapBusy, which requires the error channel
  //             to be Session.BusyError (shell throws BusyError when the session is
  //             already running), so we surface it via Effect.tryPromise.
  export interface Interface {
    readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
    readonly loop: (input: z.infer<typeof LoopInput>) => Effect.Effect<MessageV2.WithParts>
    readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
    readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
    readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

  export const layer = Layer.succeed(
    Service,
    Service.of({
      prompt: (input) => Effect.promise(() => prompt(input)),
      loop: (input) => Effect.promise(() => loop(input)),
      cancel: (sessionID) => Effect.promise(() => cancel(sessionID)),
      shell: (input) =>
        Effect.tryPromise({
          try: () => shell(input),
          catch: (e) => (e instanceof Session.BusyError ? e : new Session.BusyError(input.sessionID)),
        }),
      command: (input) => Effect.promise(() => command(input)),
    }),
  )

  export const defaultLayer = layer

  export const node = LayerNode.make(layer, [])
  // altimate_change end
}
