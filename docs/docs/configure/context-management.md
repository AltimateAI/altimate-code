# Context Management

altimate automatically manages conversation context so you can work through long sessions without hitting model limits. When a conversation grows large, the CLI summarizes older messages, prunes stale tool outputs, and recovers from provider overflow errors — all without losing the important details of your work.

## How It Works

Every LLM has a finite context window. As you work, each message, tool call, and tool result adds tokens to the conversation. When the conversation approaches the model's limit, altimate takes action:

1. **Prune** — Old tool outputs (file reads, command results, query results) are replaced with compact summaries
2. **Compact** — The entire conversation history is summarized into a continuation prompt
3. **Continue** — The agent picks up where it left off using the summary

This happens automatically by default. You do not need to manually manage context.

## Auto-Compaction

When enabled (the default), altimate monitors token usage after each model response. If the conversation is approaching the context limit, it triggers compaction automatically.

During compaction:

- A dedicated compaction agent summarizes the full conversation
- The summary captures goals, progress, discoveries, relevant files, and next steps
- The original messages are retained in session history but the model continues from the summary
- After compaction, the agent automatically continues working if there are clear next steps

You will see a compaction indicator in the TUI when this happens. The conversation continues seamlessly.

!!! tip
    If you notice compaction happening frequently, consider using a model with a larger context window or breaking your task into smaller sessions.

## Observation Masking (Pruning)

Before compaction, altimate prunes old tool outputs to reclaim context space. This is called "observation masking."

When a tool output is pruned, it is replaced with a brief fingerprint:

```
[Tool output cleared — read_file(file: src/main.ts) returned 42 lines, 1.2 KB — "import { App } from './app'"]
```

This tells the model what tool was called, what arguments were used, how much output it produced, and the first line of the result — enough to maintain continuity without consuming tokens.

**Pruning rules:**

- Only tool outputs older than the most recent 2 turns are eligible
- The most recent ~40,000 tokens of tool outputs are always preserved
- Pruning only fires when at least 20,000 tokens can be reclaimed
- `skill` tool outputs are never pruned (they contain critical session context)

## Data Engineering Context

Compaction is aware of data engineering workflows. When summarizing a conversation, the compaction prompt preserves:

- **Warehouse connections** — which databases or warehouses are connected
- **Schema context** — discovered tables, columns, and relationships
- **dbt project state** — models, sources, tests, and project structure
- **Lineage findings** — upstream and downstream dependencies
- **Query patterns** — SQL dialects, anti-patterns, and optimization opportunities
- **FinOps context** — cost findings and warehouse sizing recommendations

This means you can run a long data exploration session and compaction will not lose track of what schemas you discovered, what dbt models you were working with, or what cost optimizations you identified.

## Provider Overflow Detection

If compaction does not trigger in time and the model returns a context overflow error, altimate detects it and automatically compacts the conversation.

Overflow detection works with all major providers:

| Provider | Detection |
|----------|-----------|
| Anthropic | "prompt is too long" |
| OpenAI | "exceeds the context window" |
| AWS Bedrock | "input is too long for requested model" |
| Google Gemini | "input token count exceeds the maximum" |
| Azure OpenAI | "the request was too long" |
| Groq | "reduce the length of the messages" |
| OpenRouter / DeepSeek | "maximum context length is N tokens" |
| xAI (Grok) | "maximum prompt length is N" |
| GitHub Copilot | "exceeds the limit of N" |
| Ollama / llama.cpp / LM Studio | Various local server messages |

When an overflow is detected, the CLI automatically compacts and retries. No action is needed on your part.

### Loop Protection

If compaction fails to reduce context sufficiently and overflow keeps recurring, altimate stops after 3 consecutive compaction attempts within the same turn. You will see a message asking you to start a new conversation. The counter resets after each successful processing step, so compactions spread across different turns do not count against the limit.

!!! note
    Some providers (such as z.ai) may accept oversized inputs silently. For these, the automatic token-based compaction trigger is the primary safeguard.

## Configuration

Control context management behavior in `altimate-code.json`:

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 20000
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auto` | `boolean` | `true` | Automatically compact when the context window is nearly full |
| `prune` | `boolean` | `true` | Prune old tool outputs before compaction |
| `reserved` | `number` | `20000` | Token buffer to reserve below the context limit. The actual headroom is `max(reserved, model_max_output)`, so this value only takes effect when it exceeds the model's output token limit. Increase if you see frequent overflow errors |

### Disabling Auto-Compaction

If you prefer to manage context manually (for example, by starting new sessions), disable auto-compaction:

```json
{
  "compaction": {
    "auto": false
  }
}
```

!!! warning
    With auto-compaction disabled, you may hit context overflow errors during long sessions. The CLI will still detect and recover from these, but the experience will be less smooth.

### Manual Compaction

You can trigger compaction at any time from the TUI by pressing `leader` + `c`, or by using the `/compact` command in conversation. This is useful when you want to create a checkpoint before switching tasks.

## Token Estimation

altimate uses content-aware heuristics to estimate token counts without calling a tokenizer. This keeps overhead low while maintaining accuracy.

The estimator detects content type and adjusts its ratio:

| Content Type | Characters per Token | Detection |
|--------------|---------------------|-----------|
| Code | ~3.0 | High density of `{}();=` characters |
| JSON | ~3.2 | Starts with `{` or `[`, high density of `{}[]:,"` |
| SQL | ~3.5 | Contains SQL keywords (`SELECT`, `FROM`, `JOIN`, etc.) |
| Plain text | ~4.0 | Default for prose and markdown |
| Mixed | ~3.7 | Fallback for content that does not match a specific type |

These ratios are tuned against the cl100k_base tokenizer used by Claude and GPT-4 models. The estimator samples the first 500 characters of content to classify it, so the overhead is negligible.

!!! note "Limitations"
    The heuristic uses JavaScript string length (UTF-16 code units), which over-estimates tokens for emoji (2 code units but ~1-2 tokens) and CJK characters. For precise token counting, a future update will integrate a native tokenizer.
