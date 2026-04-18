import { Hono } from "hono"

export function TraceManagerRoutes() {
  const app = new Hono()

  let cachedApp: Awaited<ReturnType<typeof import("@altimateai/trace-manager/src/web/server").createApp>> | null = null

  async function getApp() {
    if (cachedApp) return cachedApp

    const { createApp } = await import("@altimateai/trace-manager/src/web/server")

    let lake: import("@altimateai/trace-manager/src/lake/lake-manager").LakeManager | undefined
    try {
      const { LakeManager } = await import("@altimateai/trace-manager/src/lake/lake-manager")
      const { loadOrCreateConfig } = await import("@altimateai/trace-manager/src/consent/consent-store")
      const { loadAllTraces } = await import("@altimateai/trace-manager/src/traces")
      const config = await loadOrCreateConfig()
      lake = await LakeManager.create(config.lake.path)
      const traces = await loadAllTraces()
      for (const t of traces) await lake.ingest(t)
    } catch {}

    cachedApp = await createApp({ lake })
    return cachedApp
  }

  app.all("/*", async (c) => {
    const traceApp = await getApp()
    const url = new URL(c.req.url)
    url.pathname = url.pathname.replace(/^\/trace-manager/, "") || "/"
    const rewritten = new Request(url.toString(), c.req.raw)
    return traceApp.fetch(rewritten)
  })

  return app
}
