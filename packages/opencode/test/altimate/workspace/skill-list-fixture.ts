// altimate_change - new file
//
// Recording a link starts a skill sync, and a test that awaits it (`awaitBackfill`) waits on that
// sync's skill-list request. Against a stubbed Altimate host with no fetch stub, that request goes
// to the real network and holds the test for as long as the host takes to fail — up to the API
// client's 15s timeout. This answers it offline instead.

/** Answer `host`'s skill-list request with an empty page, and anything else on it with a 404.
 * Other hosts pass through to the fetch that was installed before. Returns the restore. */
export function stubEmptySkillList(host: string): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.host !== host) return original(input, init)
    const skills = url.pathname.endsWith("/skills")
    // The page is echoed back: the skill-list parser rejects a page that does not match its request.
    const body = skills
      ? { items: [], page: Number(url.searchParams.get("page") ?? "1"), pages: 1, total: 0 }
      : { detail: "not found" }
    return new Response(JSON.stringify(body), {
      status: skills ? 200 : 404,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}
