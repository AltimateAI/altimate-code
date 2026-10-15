# fix(core): honor model.request baseURL for AI SDK providers

> Local draft only. Nothing has been posted. Network access is unavailable; an upstream duplicate search is still required before filing.

### Description

On v2.0.29, setting `event.baseURL` in `session.hook("model.request")` does not change the HTTP destination for the OpenAI-compatible SDK on the AI SDK path. The hook runs and its header changes apply, but requests still use the URL supplied when the SDK was initialized. This prevents a plugin from selecting an endpoint per request, including after a user changes their connection settings.

Expected: the request uses the hook's API root. Actual: it uses the original SDK API root. This report concerns the AI SDK path; it does not establish the same behavior for native provider routes.

### Plugins

The minimal `url-probe` plugin below; no other plugin is required.

### OpenCode version

v2.0.29. Existing local transport verification used Bun 1.4.2.

### Steps to reproduce

At the root of a v2.0.29 checkout with dependencies installed, save this as `url-probe/server.ts`. It resolves the installed SDK directly to avoid a managed package download. The root-level server entry avoids relying on package exports for a directory plugin.

```ts
import { Model, Plugin, Provider } from "@opencode/plugin"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

export default Plugin.define({
  id: "url-probe",
  async setup(ctx) {
    const providerID = Provider.ID.make("url-probe")
    const installed = createRequire(`${ctx.location.directory}/packages/core/package.json`)
      .resolve("@ai-sdk/openai-compatible")
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          activation: "enabled",
          package: `aisdk:${pathToFileURL(installed).href}`,
          settings: { baseURL: "https://original.example.invalid/v1", apiKey: "test-only" },
        },
        models: [{
          ...Model.Info.default(providerID, Model.ID.make("probe")),
          limit: { context: 32768, output: 1024 },
        }],
      })
    })
    await ctx.session.hook("model.request", async (event) => {
      event.baseURL = "https://replacement.example.invalid/v1"
      event.headers["x-url-probe"] = "hook-ran"
    }, { providerID })
    await ctx.session.hook("http.request", async (event) => {
      await Bun.write(`${ctx.location.directory}/url-probe-capture.json`, JSON.stringify({
        url: event.request.url,
        marker: event.request.headers.get("x-url-probe"),
      }))
      const chunk = {
        id: "probe", object: "chat.completion.chunk", created: 1, model: "probe",
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
      const sse = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
      event.request = new Request(`data:text/event-stream,${encodeURIComponent(sse)}`, event.request)
    }, { providerID })
  },
})
```

Add these fields to the checkout's `opencode.jsonc`:

```json
{ "plugins": ["./url-probe"], "agents": { "title": { "disabled": true } } }
```

Run `bun run packages/cli/src/index.ts --standalone .` from the checkout root, select `url-probe/probe`, and submit `Hi`. Inspect `url-probe-capture.json` at that root: the expected URL is `https://replacement.example.invalid/v1/chat/completions`; the affected path produces `https://original.example.invalid/v1/chat/completions` with `marker: "hook-ran"`. The final hook captures the assembled request and redirects it to an inline response, so neither test hostname is contacted. Title generation is disabled to keep this capture to the prompted call.

This reduced recipe is based on existing offline transport tests using the installed OpenAI-compatible SDK. Those tests verified endpoint changes through `http.request`; removing only that rewrite while keeping `model.request` reproduced the original URL. The reduced recipe itself has not been executed separately.

**Workaround:** in a provider-scoped `http.request` hook, set `event.request = new Request("https://replacement.example.invalid/v1/chat/completions", event.request)`. Resolve the destination at request time and update any associated headers there. This works for the tested OpenAI-compatible chat endpoint; other protocols need their own path handling, and this is not a WebSocket-routing workaround.

### Screenshot and/or share link

No screenshot or share link; the request capture above shows the relevant behavior.

### Operating System

macOS; the local test receipt does not record the OS version.

### Terminal

Not applicable to the SDK transport fixture.

### Code references (v2.0.29)

- `packages/plugin/src/promise/session.ts:63`: the public hook exposes mutable `baseURL` and headers.
- `packages/core/src/session/model-request.ts:304`: invokes the hook; `:312` applies the URL through `route.with`; `:318` applies headers separately.
- `packages/core/src/aisdk.ts:344`: initializes/caches the SDK before the request hook; `:381` supplies a placeholder route endpoint; `:408` makes `with` a no-op; `:413` streams through the captured language model.
- `packages/core/src/session/model-request.ts:343`: `http.request` receives the actual request and its replacement is sent at `:354`.

### Open questions for maintainers

- Should `model.request.baseURL` consistently mean the provider API root across native and AI SDK providers?
- If an SDK cannot support a per-request URL override, should the hook reject it explicitly rather than silently ignore it?
