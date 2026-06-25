# WS5 Tracing Verification

Date: 2026-06-25
Worktree: `/Users/anandgupta/codebase/altimate-code/.claude/worktrees/get_latest_upstream`
Binary: `packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate`
Binary version: `0.0.0-upstream/merge-v1.17.9-202606251017`

## Verdict: FAIL

`altimate run` successfully executed real `azure/gpt-4o-mini` agent work, including writing and reading `haiku.txt`, but no trace JSON artifact was created. A JSON-format diagnostic run emitted 9 session events from the real model/tool loop and 0 `trace_saved` events. The trace viewer could not open the run session because no trace file existed.

## How tracing is enabled

Tracing is intended to be enabled by default for `run`, with `--no-trace` as the per-run disable switch:

```ts
// packages/opencode/src/cli/cmd/run.ts:355
.option("trace", {
  type: "boolean",
  describe: "enable session tracing (default: true, disable with --no-trace)",
  default: true,
})
```

The tracer is gated by both the CLI flag and config:

```ts
// packages/opencode/src/cli/cmd/run.ts:597
const tracer = await (async () => {
  try {
    if (args.trace === false) return null

    const cfg = await Config.get()
    const tracingCfg = cfg.tracing
    if (tracingCfg?.enabled === false) return null

    const exporters: TraceExporter[] = [new FileExporter(tracingCfg?.dir)]
    ...
    return Tracer.withExporters(exporters, { maxFiles: tracingCfg?.maxFiles })
  } catch {
    // Config failure should never prevent the run command from working
    return null
  }
})()
```

Config schema supports `tracing.enabled`, `tracing.dir`, `tracing.maxFiles`, and HTTP exporters:

```ts
// packages/core/src/v1/config/config.ts:174
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
```

When non-null, `run` starts the trace after creating the session and finalizes it after the event loop reaches idle:

```ts
// packages/opencode/src/cli/cmd/run.ts:839
tracer?.startTrace(sessionID, {
  title: title() || message.slice(0, 80),
  model: args.model,
  agent,
  variant: args.variant,
  prompt: message,
})
if (tracer) Tracer.setActive(tracer)
```

```ts
// packages/opencode/src/cli/cmd/run.ts:902
if (tracer) {
  Tracer.setActive(null)
  const tracePath = await tracer.endTrace(error)
  if (tracePath) {
    emit("trace_saved", { path: tracePath })
```

The local file exporter should write JSON to the configured dir or the default `Global.Path.data/traces`:

```ts
// packages/opencode/src/altimate/observability/tracing.ts:174
const DEFAULT_TRACES_DIR = path.join(Global.Path.data, "traces")
```

```ts
// packages/opencode/src/altimate/observability/tracing.ts:221
await fs.mkdir(this.dir, { recursive: true })
const safeId = (trace.sessionId ?? "unknown").replace(/[/\\.:]/g, "_") || "unknown"
const filePath = path.join(this.dir, `${safeId}.json`)
...
await fs.writeFile(tmpPath, JSON.stringify(trace, null, 2))
...
await fs.rename(tmpPath, filePath)
```

## Commands run

Exact non-interactive run, with tracing explicitly enabled and a temp trace directory:

```bash
RUN_DIR=/tmp/ws5-trace-run.n9Fm3m
TRACE_DIR=/tmp/ws5-traces.o4hK08
OPENCODE_CONFIG_CONTENT='{"tracing":{"enabled":true,"dir":"/tmp/ws5-traces.o4hK08","maxFiles":0}}' \
  packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate \
  run "write a haiku about databases to haiku.txt then read it back" \
  --model azure/gpt-4o-mini --yolo --trace
```

Result:

- Exit status: 0
- Wrote `/tmp/ws5-trace-run.n9Fm3m/haiku.txt`
- `TRACE_DIR` contained 0 JSON files

Diagnostic JSON-format run with the same real task, used for event counts:

```bash
RUN_DIR=/tmp/ws5-trace-json-run.bejE6c
TRACE_DIR=/tmp/ws5-traces-json.HlL6XM
OPENCODE_CONFIG_CONTENT='{"tracing":{"enabled":true,"dir":"/tmp/ws5-traces-json.HlL6XM","maxFiles":0}}' \
  packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate \
  run "write a haiku about databases to haiku.txt then read it back" \
  --model azure/gpt-4o-mini --yolo --trace --format json
```

Result:

- Exit status: 0
- Session: `ses_101b30896ffefOYAJDlEguegx0`
- Log evidence: `service=llm providerID=azure modelID=gpt-4o-mini sessionID=ses_101b30896ffefOYAJDlEguegx0`
- Wrote `/tmp/ws5-trace-json-run.bejE6c/haiku.txt`
- Tool events completed for `write` and `read` on `private/tmp/ws5-trace-json-run.bejE6c/haiku.txt`

JSON event counts from `/tmp/ws5-trace-json-run.bejE6c/altimate-run.jsonl`:

```text
3 step_start
2 tool_use
3 step_finish
1 text
0 trace_saved
0 error
```

Trace directories checked:

```text
/tmp/ws5-traces.o4hK08             0 json files
/tmp/ws5-traces-json.HlL6XM        0 json files
/tmp/ws5-traces-localcfg.rU9tOZ    0 json files
/tmp/ws5-debug-config-traces       0 json files
```

I also checked the default trace directory for the run session IDs; neither `ses_101b42372ffe24wKllogypOSvH` nor `ses_101b30896ffefOYAJDlEguegx0` was present under `/Users/anandgupta/.local/share/altimate-code/traces`.

## Viewer / command status

The trace command exists:

```ts
// packages/opencode/src/cli/cmd/trace.ts:123
export const TraceCommand = cmd({
  command: "trace [action] [id]",
  aliases: ["recap"],
  describe: "list and view session traces (recordings of agent sessions)",
```

Viewer implementation exists and serves HTML plus `/api/trace` when a trace file is found:

```ts
// packages/opencode/src/cli/cmd/trace.ts:207
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/api/trace") {
      const content = await fs.readFile(tracePath, "utf-8")
```

But the current run trace could not be rendered:

```bash
OPENCODE_CONFIG_CONTENT='{"tracing":{"enabled":true,"dir":"/tmp/ws5-traces-json.HlL6XM","maxFiles":0}}' \
  packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate \
  trace view ses_101b30896ffefOYAJDlEguegx0 --port 43217
```

Result:

```text
status=1
Error: Trace not found: ses_101b30896ffefOYAJDlEguegx0
```

`trace list` does list old traces from the default directory, but did not honor the temp `tracing.dir` override in this standalone command; it printed:

```text
Showing 1-3 of 156 trace(s) in /Users/anandgupta/.local/share/altimate-code/traces
```

## Root cause

The immediate failure mode is that `run` silently disables tracing when config lookup throws. The likely underlying exception is `InstanceRef not provided`.

Evidence:

1. `run` uses the imperative `Config.get()` facade inside the tracer setup and returns `null` on any exception (`packages/opencode/src/cli/cmd/run.ts:597-619`).
2. That facade depends on `makeRuntime(...).attach(...)`:

```ts
// packages/opencode/src/config/config.ts:802
const { runPromise: runConfig } = makeRuntime(Service, defaultLayer)
export async function get() {
  return runConfig((svc) => svc.get())
}
```

3. `attach()` looks for `InstanceRef` in the current Effect fiber, then falls back to `Instance.current` from `project/instance`:

```ts
// packages/opencode/src/effect/run-service.ts:25
export function attach<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const workspace = WorkspaceContext.workspaceID
  const fiber = Fiber.getCurrent()
  const instance =
    fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : tryLegacyInstance()
```

4. The `run` command's `bootstrap()` provides a different context (`project/instance-context`), not `project/instance`'s `Instance.current`:

```ts
// packages/opencode/src/cli/bootstrap.ts:4
export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  const ctx = await InstanceRuntime.load({ directory })
  try {
    return await context.provide(ctx, cb)
```

5. `InstanceState` dies when `InstanceRef` is missing:

```ts
// packages/opencode/src/effect/instance-state.ts:14
export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})
```

6. Source-level reproduction of `bootstrap(tempDir, async () => Config.get())` printed:

```json
{"ok":false,"name":"Error","message":"InstanceRef not provided"}
```

Because `run` catches that exception and returns `null`, `tracer?.startTrace(...)` and `tracer.endTrace(...)` are skipped, so no snapshots, no final trace JSON, no `trace_saved` event, and no viewer-renderable artifact.

## Notes

- The real `azure/gpt-4o-mini` task itself passed: the agent wrote and read `haiku.txt`.
- A separate title-generation call attempted `azure/claude-haiku-4-5` and failed due an unresolved Azure resource URL placeholder; this did not stop the main `gpt-4o-mini` task and is not the trace artifact root cause.
- No commits or pushes were made.
