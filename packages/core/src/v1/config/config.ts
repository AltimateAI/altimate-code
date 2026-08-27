export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReference } from "../../config/reference"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigLSPV1 } from "./lsp"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigPluginV1 } from "./plugin"
import { ConfigProviderV1 } from "./provider"
import { ConfigServerV1 } from "./server"
import { ConfigSkillsV1 } from "./skills"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.optional(Schema.String).annotate({ description: "Default shell to use for terminal and bash tool" }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ConfigServerV1.Server).annotate({
    // altimate_change start — user-facing command branding
    description: "Server configuration for altimate-code serve and web commands",
    // altimate_change end
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    // altimate_change start — docs URL branding
    description: "Command configuration, see https://altimate.ai/docs/commands",
    // altimate_change end
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Additional skill folder paths" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Use 'references' field instead. Named git or local directory references",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPluginV1.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description:
      "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Use 'share' field instead. Share newly created sessions automatically",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({ build: Schema.optional(ConfigAgentV1.Info), plan: Schema.optional(ConfigAgentV1.Info) }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({
    // altimate_change start — docs URL branding
    description: "Agent configuration, see https://altimate.ai/docs/agents",
    // altimate_change end
  }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })])),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  lsp: Schema.optional(ConfigLSPV1.Info).annotate({
    description:
      "Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Attachment processing configuration, including image size limits and resizing behavior",
  }),
  enterprise: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }) }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)",
      }),
      // altimate_change start — harness plan W3.2: per-tool-result dispatch cap
      dispatch_max_tokens: Schema.optional(PositiveInt).annotate({
        description:
          "Hard cap on the estimated token size of a single tool result at dispatch time; oversized results are middle-truncated before entering the conversation (default: min(max_bytes-derived token estimate, 15% of the effective context limit))",
      }),
      // altimate_change end
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned.",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Enable pruning of old tool outputs (default: false)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction (default: 2)",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
      // altimate_change start — harness plan W3.1: estimator safety margin
      context_safety_fraction: Schema.optional(Schema.Number).annotate({
        description:
          "Fraction of the declared context limit treated as usable when estimated token counts are compared against it for compaction/overflow decisions (default: 0.65 — chars-based estimates undercount dense SQL/JSON by up to ~1.55x, and compaction must trigger with enough margin that the worst observed underestimate still fits). Env override: ALTIMATE_CONTEXT_SAFETY_FRACTION. Clamped to [0.1, 1].",
      }),
      // altimate_change end
      // altimate_change start — harness plan W2.3 / item 5: post-compaction state ledger + summary carry
      state_ledger: Schema.optional(Schema.Boolean).annotate({
        description:
          "Append a harness-computed state ledger (files written with timestamps, recent tool calls with exit codes) to the post-compaction continue message (default: true)",
      }),
      ledger_max_tokens: Schema.optional(NonNegativeInt).annotate({
        description:
          "Token cap for the state ledger and carry anchors, tail-truncated (default: 500 — harness plan W2.3 cap: the ledger must cost less than the duplicate re-reads it prevents; one mid-size file re-read is ~1-3k tokens)",
      }),
      ledger_recent_calls: Schema.optional(NonNegativeInt).annotate({
        description:
          "How many recent tool calls the state ledger lists, newest first (default: 10 — covers several median edit-verify cycles, ~1.8 calls/cycle corpus statistic, without dominating the ledger budget)",
      }),
      summary_carry: Schema.optional(Schema.Boolean).annotate({
        description:
          "Carry the previous summary's Accomplished items into the next summarization as anchors; items without a corroborating ledger event are tagged 'claimed, unverified' (default: true)",
      }),
      summary_first_person: Schema.optional(Schema.Boolean).annotate({
        description:
          "Ask the compaction summarizer to write in the first person, as the agent's own working memory (default: true)",
      }),
      // altimate_change end
      // altimate_change start — harness plan W2.2 / item 2: pin the original task verbatim through compaction
      pin_task: Schema.optional(Schema.Boolean).annotate({
        description:
          "Pin the original task instruction verbatim through compaction, hoisted as an authoritative reminder alongside the summary (default: true)",
      }),
      pin_max_tokens: Schema.optional(NonNegativeInt).annotate({
        description:
          "Hard token cap for the pinned original task (default: 4096 — harness plan W2.2 cap: min(4k, pin_window_fraction of the post-overhead usable window); larger tasks keep verbatim head+tail plus a contract card of extracted literals)",
      }),
      pin_window_fraction: Schema.optional(Schema.Number).annotate({
        description:
          "Fraction of the post-overhead usable context window the pinned task may occupy (default: 0.175 — midpoint of the harness plan W2.2 15-20% band; the pin must stay a small minority of the window so working context dominates)",
      }),
      pin_card_max_tokens: Schema.optional(NonNegativeInt).annotate({
        description:
          "Token cap for the contract card of regex-extracted task literals appended when the pinned task exceeds its cap (default: 500 — harness plan W2.2 contract-card budget)",
      }),
      // altimate_change end
    }),
  ),
  // altimate_change start - tracing config (re-applied from main during the v1.17.9 reconciliation)
  tracing: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description:
          "Enable session tracing (default: true). Traces are saved locally and can be viewed with `altimate-code trace`.",
      }),
      dir: Schema.optional(Schema.String).annotate({
        description: "Custom directory for trace files (default: ~/.local/share/altimate-code/traces/)",
      }),
      maxFiles: Schema.optional(NonNegativeInt).annotate({
        description:
          "Maximum number of trace files to keep. 0 for unlimited. Oldest files are removed when exceeded (default: 100).",
      }),
      exporters: Schema.optional(
        Schema.mutable(
          Schema.Array(
            Schema.Struct({
              name: Schema.String.annotate({ description: "Exporter identifier" }),
              endpoint: Schema.String.annotate({ description: "HTTP endpoint to POST trace data to" }),
              headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
                description: "Custom headers (e.g., Authorization)",
              }),
            }),
          ),
        ),
      ).annotate({ description: "Additional trace exporters. Each receives the full trace JSON via HTTP POST." }),
    }),
  ),
  // altimate_change end
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Policy statements applied to supported resources, such as provider access",
      }),
      // altimate_change start - fork experimental toggles re-applied during the v1.17.9 reconciliation
      auto_enhance_prompt: Schema.optional(Schema.Boolean).annotate({
        description:
          "Automatically enhance prompts with AI before sending (default: false). Uses a small model to rewrite rough prompts into clearer versions.",
      }),
      env_fingerprint_skill_selection: Schema.optional(Schema.Boolean).annotate({
        description:
          "Use environment fingerprint to select relevant skills once per session (default: false). Set to true to enable LLM-based skill filtering.",
      }),
      auto_mcp_discovery: Schema.optional(Schema.Boolean).annotate({
        description:
          "Auto-discover MCP servers from VS Code, Claude Code, Copilot, and Gemini configs at startup (default: true). Set to false to disable.",
      }),
      // altimate_change end
      // altimate_change start — W2.4: write-starvation circuit breaker + loop detection.
      // Ships ANNOTATE-ONLY by default: mode "annotate" logs breaker-would-fire events
      // and appends informational annotations; "armed" additionally injects outcome-neutral
      // directives (run mode only) and enables the doom-loop escalation ladder's hard stop.
      // Threshold defaults carry corpus-or-first-principles provenance (see
      // session/starvation.ts DEFAULTS) and are exposed here so they are never
      // constants fitted to any one evaluation run.
      starvation_breaker: Schema.optional(
        Schema.Struct({
          mode: Schema.optional(Schema.Literals(["off", "annotate", "armed"])).annotate({
            description:
              "off = disabled; annotate (default) = log would-fire events and append informational annotations only; armed = also inject directives in run mode and enable the doom-loop hard stop.",
          }),
          max_turns_without_mutation: Schema.optional(PositiveInt).annotate({
            description:
              "Consecutive assistant turns with zero corroborated file mutation before the write-starvation breaker fires (default: 12; first-principles, see session/starvation.ts).",
          }),
          repeat_signature_threshold: Schema.optional(PositiveInt).annotate({
            description:
              "Consecutive identical repeat signatures (tool + normalized args + touched files + failure message) before the loop detector fires (default: 3).",
          }),
          doom_loop_threshold: Schema.optional(PositiveInt).annotate({
            description:
              "Consecutive identical (tool + normalized args) calls before the escalation ladder's first rung (nudge). Rungs: threshold = nudge, 2x = forced status-check, 3x = stop (default: 3).",
          }),
          polling_threshold_multiplier: Schema.optional(PositiveInt).annotate({
            description:
              "Multiplier applied to doom_loop_threshold for recognizable polling commands (default: 5).",
          }),
          polling_pattern: Schema.optional(Schema.String).annotate({
            description:
              "Case-insensitive regex identifying polling-style bash commands whose repeat threshold is raised (default: \\b(sleep|watch|status)\\b).",
          }),
          exempt_agents: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
            description:
              "Agent names for which the breaker is skipped entirely — read-only deliverables are their normal outcome (default: plan, review).",
          }),
          generated_path_patterns: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
            description:
              "Path patterns exempt from unchanged-read annotation because they regenerate across builds (directory prefixes ending in '/', '*.ext' suffixes, or substrings).",
          }),
        }),
      ).annotate({
        description:
          "Write-starvation circuit breaker + loop detection (annotate-only by default; directives are run-mode-only).",
      }),
      // altimate_change end
    }),
  ),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
