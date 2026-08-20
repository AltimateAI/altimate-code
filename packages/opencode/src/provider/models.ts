import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import z from "zod"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem } from "../util/filesystem"
import { Flock } from "@/util/flock"
import { Hash } from "@/util/hash"
import { ModelsCatalog } from "./models-catalog"

// Try to import bundled snapshot (generated at build time)
// Falls back to undefined in dev mode when snapshot doesn't exist
/* @ts-ignore */

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const source = url()
  const filepath = path.join(
    Global.Path.cache,
    source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
  )
  const ttl = 5 * 60 * 1000

  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        context_over_200k: z
          .object({
            input: z.number(),
            output: z.number(),
            cache_read: z.number().optional(),
            cache_write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    experimental: z.boolean().optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  })
  export type Model = z.infer<typeof Model>

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })

  export type Provider = z.infer<typeof Provider>

  function url() {
    return Flag.OPENCODE_MODELS_URL || "https://models.dev"
  }

  function fresh() {
    return Date.now() - Number(Filesystem.stat(filepath)?.mtimeMs ?? 0) < ttl
  }

  function skip(force: boolean) {
    return !force && fresh()
  }

  const fetchApi = async () => {
    const result = await fetch(`${url()}/api.json`, {
      headers: { "User-Agent": Installation.USER_AGENT },
      signal: AbortSignal.timeout(10000),
    })
    return { ok: result.ok, text: await result.text() }
  }

  // altimate_change start — bot-review fix: catalog validation lives in
  // ./models-catalog so it can be tested directly; see that file for why it is
  // structural rather than schema-based.
  const isCatalog = ModelsCatalog.isCatalog
  const parseCatalog = ModelsCatalog.parseCatalog
  // altimate_change end

  export const Data = lazy(async () => {
    // Bot-review fix: a cache poisoned by an older build must not be trusted on
    // read either, or the bad entry survives until the TTL expires.
    const cached: unknown = await Filesystem.readJson(Flag.OPENCODE_MODELS_PATH ?? filepath).catch(() => {})
    if (isCatalog(cached)) return cached
    // @ts-ignore
    const snapshot = await import("./models-snapshot.js")
      .then((m) => m.snapshot as Record<string, unknown>)
      .catch(() => undefined)
    if (snapshot) return snapshot
    if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return {}
    return Flock.withLock(`models-dev:${filepath}`, async () => {
      const cachedUnderLock: unknown = await Filesystem.readJson(Flag.OPENCODE_MODELS_PATH ?? filepath).catch(() => {})
      if (isCatalog(cachedUnderLock)) return cachedUnderLock
      const result2 = await fetchApi()
      // altimate_change — #1052 D14 review-fix (M3): fetchApi returning a non-2xx
      // (e.g. 5xx with an HTML error body) previously fell through to
      // `JSON.parse(<HTML>)` and crashed with SyntaxError. Return an empty
      // catalog instead — callers already tolerate empty results (Provider.state
      // just yields no models.dev-derived providers, which is the same UX as
      // running with OPENCODE_DISABLE_MODELS_FETCH=1). Pre-D14 this rarely
      // fired because the eager refresh usually warmed the disk cache; post-D14
      // more first-calls fall through to fetch, so more chances to hit the crash.
      //
      // Bot-review follow-up: a 2xx can still carry HTML or truncated JSON
      // (proxies, load-balancer error pages that respond 200, mid-stream
      // truncation). Try to parse first; only cache + return on success. On
      // parse failure, log and return empty — same graceful-degradation path
      // as the non-2xx branch, and we don't poison the disk cache with junk.
      if (!result2.ok) return {}
      const parsed = parseCatalog(result2.text)
      if (!parsed) {
        log.error("models.dev body is not a catalog; not caching", { firstBytes: result2.text.slice(0, 120) })
        return {}
      }
      await Filesystem.write(filepath, result2.text).catch((e) => {
        log.error("Failed to write models cache", { error: e })
      })
      return parsed
    })
  })

  export async function get() {
    const result = await Data()
    return result as Record<string, Provider>
  }

  export async function refresh(force = false) {
    if (skip(force)) return ModelsDev.Data.reset()
    await Flock.withLock(`models-dev:${filepath}`, async () => {
      if (skip(force)) return ModelsDev.Data.reset()
      const result = await fetchApi()
      if (!result.ok) return
      // Bot-review fix: this path wrote the body straight to the cache with no
      // validation at all, so the hourly refresh could poison a cache the
      // cold-fetch path was careful to protect.
      if (!parseCatalog(result.text)) {
        log.error("models.dev refresh body is not a catalog; not caching", {
          firstBytes: result.text.slice(0, 120),
        })
        return
      }
      await Filesystem.write(filepath, result.text)
      ModelsDev.Data.reset()
    }).catch((e) => {
      log.error("Failed to fetch models.dev", {
        error: e,
      })
    })
  }
}

if (!Flag.OPENCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
  // altimate_change start — #1052 D14: drop the eager import-time ModelsDev.refresh().
  //
  // The previous `setTimeout(() => ModelsDev.refresh(), 0)` fired a fetch to
  // https://models.dev/api.json at module import. Its `AbortSignal.timeout(10000)`
  // cannot cancel a synchronous `getaddrinfo()` — under Linux `unshare --net`
  // (Verdaccio sanity Phase 3 [10/10] on Ubuntu CI runners) the DNS call blocked
  // long enough that the pending fetch held the event loop past command
  // completion and SIGTERM landed before any bytes flushed. That blocked the
  // v0.9.4 release.
  //
  // Callers that need model data use `ModelsDev.Data()`, which resolves in this
  // priority order: (1) local disk cache, (2) bundled snapshot at
  // `models-snapshot.ts` (embedded in release binaries — regenerated at each
  // build; dev-mode builds without the snapshot fall through to fetch), (3)
  // `Flock.withLock(...) → fetchApi()` only when both are absent. Release
  // binaries therefore have release-time model metadata even on a cold-start
  // with no network. Long-running processes (TUI, serve) still receive updates
  // via the hourly `setInterval` below (`.unref()`'d so it never blocks exit).
  //
  // Trade-off: without an eager fetch, models added to models.dev between
  // releases do not appear until a long-running process's hourly interval
  // fires, or until the disk cache expires and a caller loads on demand. That
  // is accepted deliberately.
  //
  // An earlier revision tried to narrow that window with
  // `Promise.resolve().then(() => ModelsDev.refresh())`, reasoning that a
  // microtask cannot keep Bun alive. The microtask cannot — but the `fetch()`
  // it starts can, and that is the whole failure. On a cold cache `refresh()`
  // reaches `fetchApi()`, whose `AbortSignal.timeout(10000)` still cannot
  // cancel a blocking `getaddrinfo()`. That is the D14 shape exactly, so the
  // eager refresh is gone rather than rescheduled.
  setInterval(
    async () => {
      await ModelsDev.refresh()
    },
    60 * 60 * 1000,
  ).unref()
  // altimate_change end
}
