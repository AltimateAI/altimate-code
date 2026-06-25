# CODEX AUDIT 2 - Security/Branding + Behavioral Diff

Scope: OpenCode v1.4.0 -> v1.17.9 fork merge, HEAD of `upstream/merge-v1.17.9`.

Baselines checked:
- `main` fork pre-merge
- `v1.17.9` upstream target

Commands used:
- `rg` over shipped `packages/opencode/src` and `packages/core/src` excluding tests/generated output
- `git diff main..HEAD -- packages/opencode/src/{auth,provider,permission} packages/opencode/src/session/processor.ts packages/opencode/src/session/prompt packages/opencode/src/session/prompt.ts packages/opencode/src/tool/registry.ts`
- `git diff v1.17.9..HEAD -- ...same paths...`
- `git show v1.17.9:<path>` for RESTORE parity checks
- `cd packages/opencode && bun run typecheck`
- `cd packages/opencode && bun test test/upstream test/altimate/carry-forward 2>&1|tail`

## Severity counts

- Critical: 0
- High: 0
- Medium: 3
- Low: 1

## Findings

### MEDIUM: shipped provider/tool code still sends OpenCode branding to third parties

This is a real shipped branding leak, not a comment or test artifact. Runtime provider transforms still set OpenCode/opencode identifiers on outbound requests:

- `packages/core/src/plugin/provider/llmgateway.ts:18-20` sends `HTTP-Referer: https://opencode.ai/`, `X-Title: opencode`, `X-Source: opencode`.
- `packages/core/src/plugin/provider/nvidia.ts:14-16` sends `HTTP-Referer: https://opencode.ai/`, `X-Title: opencode`, `X-BILLING-INVOKE-ORIGIN: OpenCode`.
- `packages/core/src/plugin/provider/vercel.ts:13-14` sends `http-referer: https://opencode.ai/`, `x-title: opencode`.
- `packages/core/src/plugin/provider/openrouter.ts:14-15`, `packages/core/src/plugin/provider/kilo.ts:14-15`, and `packages/core/src/plugin/provider/zenmux.ts:14-15` do the same OpenCode referer/title pattern.
- `packages/core/src/tool/websearch.ts:232` sends `User-Agent: opencode/<version>` to the Parallel MCP path.
- `packages/core/src/tool/webfetch.ts:159` retries Cloudflare-challenged fetches with `opencode` as the user agent.

Impact: external providers/tools see the upstream brand instead of Altimate. This also makes the currently passing branding guard misleading because that guard is still `todo`.

### MEDIUM: shipped user/LLM-facing surfaces still identify as opencode/OpenCode

These are shipped prompt/UI/schema paths, not tests:

- Model system prompts still identify as opencode:
  - `packages/opencode/src/session/prompt/beast.txt:1`
  - `packages/opencode/src/session/prompt/gemini.txt:1`
  - `packages/opencode/src/session/prompt/trinity.txt:1`
  - `packages/opencode/src/session/prompt/copilot-gpt-5.txt:2`
  - `packages/opencode/src/session/prompt/qwen.txt:1,8,11`
- `qwen.txt` is reachable: `packages/opencode/src/session/system.ts:9-10` imports it as `PROMPT_ANTHROPIC_WITHOUT_TODO`, and `packages/opencode/src/session/system.ts:68` returns it for fallback models. The prompt file itself has no `altimate_change` marker despite being a fork-only behavioral/branding fallback relative to `v1.17.9`.
- Built-in config guidance still points at upstream docs/schema:
  - `packages/core/src/v1/config/config.ts:42,106`
  - `packages/core/src/plugin/skill/customize-opencode.md:19,27,61,426-444`
- Local/user-facing UI still says OpenCode/opencode:
  - `packages/core/src/plugin/provider/openai-auth.ts:255-257`
  - `packages/opencode/src/temporary.ts:7`
  - OpenAPI group titles such as `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts:72`

Impact: users and model providers receive upstream brand identity and docs. This is not just package-scope residue like `@opencode-ai/*`.

### MEDIUM: aborted tool cleanup lost upstream interrupted metadata, weakening restored partial-output behavior

The MessageV2 partial-output RESTORE itself is present at `packages/opencode/src/session/message-v2.ts:825-847`: it converts errored tool parts with `state.metadata.interrupted === true` and `metadata.output` into `output-available`, matching the core upstream intent from `v1.17.9`.

However, the processor cleanup path that should create those interrupted errored tool parts does not preserve upstream behavior:

- HEAD `packages/opencode/src/session/processor.ts:626-640` sets pending/running tools to `status: "error"` with `error: "Tool execution aborted"`, but does not add `metadata.interrupted = true`, does not preserve `metadata.output`, and resets `time.start` to `Date.now()`.
- Upstream `v1.17.9:packages/opencode/src/session/processor.ts:899-908` explicitly merges existing state metadata, sets `metadata: { ...metadata, interrupted: true }`, and preserves the original start time when present.
- The local TODO tests document the same regression class at `packages/opencode/test/session/processor-effect.test.ts:753-810`.

Impact: aborted running/pending tool output can be downgraded to `output-error` instead of the restored partial-output form, and original tool timing is lost. This is an unmarked behavioral regression in a critical path.

### LOW: observability viewer catch path interpolates raw error text into `innerHTML`

Most OAuth/local HTML error pages use `escapeHtml`, for example `packages/opencode/src/plugin/openai/codex.ts:228` and `packages/opencode/src/mcp/oauth-callback.ts:47`.

One shipped viewer path does not:

- `packages/opencode/src/altimate/observability/viewer.ts:1239` writes `err.message || err` directly into `el.innerHTML`.

Impact: likely local/diagnostic scope, but this is exactly the missing-escape pattern the audit requested. If a trace-derived render error ever carries attacker-controlled text, this becomes local HTML injection in the trace viewer.

## Non-findings

- No hardcoded private API keys, private keys, GitHub tokens, AWS keys, or provider secrets found in shipped `src`. The App Insights connection string in `packages/opencode/src/altimate/telemetry/index.ts:1275` appears to be a public instrumentation key by code comment/context, not a secret.
- `anomalyco` matches in shipped `src` are only comments in `packages/opencode/src/mcp/index.ts:51-57`; not counted as shipped branding behavior.
- The `new Function(...)` fallback at `packages/opencode/src/cli/cmd/debug/agent.handler.ts:122` is local developer-supplied `--params` parsing for a debug command. I do not see a remote or privilege-crossing exploit path, so I did not count it as a real shipped security issue.
- The `exec(command)` browser opener at `packages/opencode/src/cli/cmd/github.handler.ts:303` uses a constant install URL, not user-controlled shell content.
- No permission/auth bypass found in the requested critical path diffs. Permission deny/reject paths still throw/reject in `packages/opencode/src/permission/next.ts:141-150` and `:188-209`.

## RESTORE verification

- MessageV2 partial-output: partially correct end-to-end. The conversion logic in `packages/opencode/src/session/message-v2.ts:825-847` matches upstream intent, but the processor cleanup path no longer writes the `interrupted` metadata that this conversion depends on. Counted above.
- `provider/error.ts` `server_error` retryability: correct. `packages/opencode/src/provider/error.ts:210-217` preserves upstream `server_is_overloaded`/`server_error` as retryable API errors.
- Processor content-filter/overflow/snapshot: correct for the named ports. Snapshot pre-capture exists at `packages/opencode/src/session/processor.ts:83-87` and `:304-305`; content-filter error publication exists at `:327-337`; `compaction.auto=false` overflow handling exists at `:543-554`.
- Prompt shell expansion: correct for the named command-template expansion port. `packages/opencode/src/session/prompt.ts:2845-2868` uses configured shell via `Shell.preferred((await Config.get()).shell)` and `Shell.args(...)`. I did not count the separate interactive `prompt.shell()` custom invocation as a RESTORE failure; bash/zsh smoke checks passed, and local prompt tests cover configured-shell behavior.

## Spot-run results

- `bun run typecheck`: pass, exit 0 (`tsgo --noEmit`).
- `bun test test/upstream test/altimate/carry-forward 2>&1|tail`: pass, exit 0.

Tail output:

```text
3 tests todo:
(todo) v1.4.0 merge - global marker discipline > no branding leaks (opencode.ai / anomalyco / OpenCode in shipped src)
(todo) E2E: README mandated branding audit (script/upstream) > `analyze.ts --branding` reports zero leaks
(todo) UPI-21 usage and cost accounting across AI SDK v6 shapes > non-finite totalTokens is clamped consistently with component counts

 482 pass
 3 todo
 0 fail
 4444 expect() calls
Ran 485 tests across 22 files. [39.29s]
```

The required guards are green, but the branding checks are explicitly still `todo`, so they do not protect this merge from the shipped branding leaks above.
