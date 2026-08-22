// altimate_change - new file
// Unit coverage for the browser-based workspace-creation handoff.
// (packages/opencode/src/altimate/workspace/browser-handoff.ts.)
//
// Uses ``runHandoffWithOpener`` (dependency-injected browser-open callback)
// so tests fire a synthetic callback at the live loopback listener instead of
// launching a real browser. The listener itself binds to 127.0.0.1, walks
// 7317..7325, and processes real HTTP requests — this is genuine end-to-end
// coverage for the callback validation path.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer } from "node:net"

import { AltimateApi } from "../../../src/altimate/api/client"
import {
  openWorkspaceBrowserHandoff,
  resolveWorkspaceWebUrl,
  runHandoffWithOpener,
} from "../../../src/altimate/workspace/browser-handoff"

// ── credential stubbing ─────────────────────────────────────────────────────
const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
function stubCreds(tenant: string, apiUrl: string) {
  ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured =
    async () => true
  ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials =
    async () =>
      ({
        altimateInstanceName: tenant,
        altimateUrl: apiUrl,
        altimateApiKey: "dummy",
      }) as Creds
}
function unstubCreds() {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured =
    originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials =
    originalGetCreds
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Parse the authorize URL the CLI wants to open; extract the loopback port
 * and CSRF state so tests can fire the crafted callback at the right address. */
function parseHandoffUrl(url: string): { port: number; state: string; redirect: string } {
  const u = new URL(url)
  const redirect = u.searchParams.get("redirect")!
  const state = u.searchParams.get("state")!
  const port = Number(new URL(redirect).port)
  return { port, state, redirect }
}

async function fireCallback(redirect: string, params: Record<string, string>): Promise<void> {
  const target = new URL(redirect)
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)
  const res = await fetch(target.toString(), { method: "GET" })
  // Drain body so the connection can close and let the CLI's `close()`
  // proceed without hanging on lingering sockets.
  await res.text().catch(() => "")
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveWorkspaceWebUrl — the deployment-support gate
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveWorkspaceWebUrl", () => {
  test("freemium API host resolves to <tenant>.ws.myaltimate.com", () => {
    const url = resolveWorkspaceWebUrl("https://api.myaltimate.com", "acme")
    expect(url).not.toBeNull()
    expect(url!.toString()).toBe("https://acme.ws.myaltimate.com/")
  })

  test("localhost API returns null (browser flow not supported in dev)", () => {
    expect(resolveWorkspaceWebUrl("http://localhost:5001", "acme")).toBeNull()
  })

  test("enterprise API host returns null", () => {
    expect(resolveWorkspaceWebUrl("https://acme.getaltimate.com", "acme")).toBeNull()
  })

  test("malformed URL returns null instead of throwing", () => {
    expect(resolveWorkspaceWebUrl("not-a-url", "acme")).toBeNull()
    expect(resolveWorkspaceWebUrl("", "acme")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// openWorkspaceBrowserHandoff — pre-flight failures (do not open a browser)
// ─────────────────────────────────────────────────────────────────────────────

describe("openWorkspaceBrowserHandoff pre-flight", () => {
  afterEach(() => unstubCreds())

  test("returns {unavailable} for localhost credentials", async () => {
    stubCreds("acme", "http://localhost:5001")
    const result = await openWorkspaceBrowserHandoff({
      identifier: { repoRemote: "git@github.com:acme/x.git", projectPath: "/x" },
      projectName: "x",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unavailable")
  })

  test("returns {not_configured} when credentials are missing", async () => {
    ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured =
      async () => false
    const result = await openWorkspaceBrowserHandoff({
      identifier: { projectPath: "/x" },
      projectName: "x",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("not_configured")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end via runHandoffWithOpener — real loopback, injected browser-open
// ─────────────────────────────────────────────────────────────────────────────

describe("runHandoffWithOpener end-to-end", () => {
  beforeEach(() => stubCreds("acme", "https://api.myaltimate.com"))
  afterEach(() => unstubCreds())

  test("happy path: valid callback resolves with workspaceId + tenant", async () => {
    const result = await runHandoffWithOpener(
      {
        identifier: { repoRemote: "git@github.com:acme/x.git", projectPath: "/x" },
        projectName: "x",
      },
      async (url) => {
        const { state, redirect } = parseHandoffUrl(url)
        await fireCallback(redirect, { workspace_id: "42", state, tenant: "acme" })
      },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.workspaceId).toBe(42)
      expect(result.tenant).toBe("acme")
    }
  })

  test("tenant mismatch is refused", async () => {
    const result = await runHandoffWithOpener(
      { identifier: { projectPath: "/x" }, projectName: "x" },
      async (url) => {
        const { state, redirect } = parseHandoffUrl(url)
        await fireCallback(redirect, { workspace_id: "42", state, tenant: "not-acme" })
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("tenant_mismatch")
  })

  test("wrong CSRF state is silently rejected — legitimate callback still wins", async () => {
    // The state check (``pending.state !== state``) is the primary guard
    // against a local rogue process forging a callback with an
    // attacker-chosen workspace id. A wrong-state hit returns 400 and the
    // listener keeps waiting, so a legitimate follow-up callback can still
    // resolve the flow correctly. Fire the impersonation attempt first,
    // then the correct one, and verify the correct one wins — not the
    // attacker's workspace id 999.
    const result = await runHandoffWithOpener(
      { identifier: { projectPath: "/x" }, projectName: "x" },
      async (url) => {
        const { state, redirect } = parseHandoffUrl(url)
        // Rogue process attempts to inject workspace 999 with a guessed state.
        await fireCallback(redirect, {
          workspace_id: "999",
          state: "wrong-state",
          tenant: "acme",
        })
        // Legitimate callback with the real state — this one wins.
        await fireCallback(redirect, { workspace_id: "1", state, tenant: "acme" })
      },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      // The critical assertion: the attacker's workspace id (999) never
      // resolved the promise — only the legitimate callback's workspace
      // id (1) did.
      expect(result.workspaceId).toBe(1)
      expect(result.tenant).toBe("acme")
    }
  })

  test("?error=cancelled callback resolves as {cancelled}", async () => {
    const result = await runHandoffWithOpener(
      { identifier: { projectPath: "/x" }, projectName: "x" },
      async (url) => {
        const { state, redirect } = parseHandoffUrl(url)
        await fireCallback(redirect, { state, error: "cancelled", tenant: "acme" })
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("cancelled")
  })

  test("missing workspace_id in callback resolves as {error}", async () => {
    const result = await runHandoffWithOpener(
      { identifier: { projectPath: "/x" }, projectName: "x" },
      async (url) => {
        const { state, redirect } = parseHandoffUrl(url)
        await fireCallback(redirect, { state, tenant: "acme" })
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("error")
  })

  test("invalid workspace_id (non-numeric) resolves as {error}", async () => {
    const result = await runHandoffWithOpener(
      { identifier: { projectPath: "/x" }, projectName: "x" },
      async (url) => {
        const { state, redirect } = parseHandoffUrl(url)
        await fireCallback(redirect, { workspace_id: "not-a-number", state, tenant: "acme" })
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("error")
  })

  test("browser open failure resolves as {browser_open_failed} with authorizeUrl", async () => {
    const result = await runHandoffWithOpener(
      { identifier: { projectPath: "/x" }, projectName: "x" },
      async () => {
        throw new Error("mock: no browser available")
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("browser_open_failed")
      expect(result.authorizeUrl).toContain("/create-and-link")
      expect(result.authorizeUrl).toContain("client=altimate-code")
      expect(result.authorizeUrl).toContain("project_name=x")
    }
  })

  test("URL includes project_name in query and project_remote/project_path in fragment", async () => {
    // Per m6 in the consensus review: project_path + project_remote MUST NOT
    // be sent as query params (they'd land in browser history, SaaS/CDN/WAF
    // access logs, and REST-log aggregators). Move them to the URL fragment
    // instead — same reason cli_context lives in the fragment.
    let observed = ""
    await runHandoffWithOpener(
      {
        identifier: { repoRemote: "git@github.com:acme/foo.git", projectPath: "/w/foo" },
        projectName: "foo",
      },
      async (url) => {
        observed = url
        // fire callback so the flow doesn't hang for 15 min
        const { state, redirect } = parseHandoffUrl(url)
        await fireCallback(redirect, { workspace_id: "1", state, tenant: "acme" })
      },
    )
    const u = new URL(observed)
    // project_name is a display-safe label — the SaaS approval screen
    // renders it in the modal — so it stays in the query.
    expect(u.searchParams.get("project_name")).toBe("foo")
    // project_remote + project_path MUST NOT be in the query.
    expect(u.searchParams.get("project_remote")).toBeNull()
    expect(u.searchParams.get("project_path")).toBeNull()
    // They live in the fragment instead.
    const frag = new URLSearchParams(u.hash.replace(/^#/, ""))
    expect(frag.get("project_remote")).toBe("git@github.com:acme/foo.git")
    expect(frag.get("project_path")).toBe("/w/foo")
    expect(u.pathname).toBe("/create-and-link")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Port walk: a squatting listener on 7317 forces handoff to 7318+
// ─────────────────────────────────────────────────────────────────────────────

describe("port walk", () => {
  beforeEach(() => stubCreds("acme", "https://api.myaltimate.com"))
  afterEach(() => unstubCreds())

  test("stale listener on 7317 forces handoff to 7318", async () => {
    const squatter = createServer()
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject)
      squatter.listen(7317, "127.0.0.1", () => resolve())
    })

    try {
      let observedPort = -1
      const result = await runHandoffWithOpener(
        { identifier: { projectPath: "/x" }, projectName: "x" },
        async (url) => {
          const { port, state, redirect } = parseHandoffUrl(url)
          observedPort = port
          await fireCallback(redirect, { workspace_id: "1", state, tenant: "acme" })
        },
      )
      expect(result.ok).toBe(true)
      expect(observedPort).toBeGreaterThan(7317)
      expect(observedPort).toBeLessThanOrEqual(7325)
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()))
    }
  })
})
