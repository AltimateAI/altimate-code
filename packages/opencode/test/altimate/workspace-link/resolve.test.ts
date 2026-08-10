// altimate_change — checkpoint 8d. Unit coverage for the pure logic pieces of the launch-time
// --workspace resolution: name matching (the explicit-flag path) and drift detection (the
// implicit path). The interactive prompt flows themselves (promptUnbound/promptDrift) are
// exercised live, not here — see the checkpoint's own verification report. Global
// XDG_STATE_HOME isolation for this whole suite comes from test/preload.ts; unique fake
// directory keys per test avoid collisions within that shared location.
import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import { hasDrifted, isLikelyOnboarded, nameMatches, resolveWorkspaceForLaunch } from "../../../src/altimate/workspace-link/resolve"
import { persistApprovedBinding } from "../../../src/altimate/workspace-link/flow"
import { persistIfApproved } from "../../../src/server/routes/instance/httpapi/handlers/workspace-link"
import { readBinding } from "../../../src/altimate/workspace-link/state"
import { setResolvedWorkspace, getResolvedWorkspace } from "../../../src/altimate/workspace-link/session-context"
import type { WorkspaceLinkBinding } from "../../../src/altimate/workspace-link/state"
import { AltimateApi } from "../../../src/altimate/api/client"
import { Auth } from "../../../src/auth"

function fakeBinding(overrides: Partial<WorkspaceLinkBinding> = {}): WorkspaceLinkBinding {
  return {
    projectId: "/fake/dir",
    linkId: "wsl_x",
    workspaceId: "wks_x",
    workspaceName: "Analytics",
    workspaceSlug: "analytics",
    manageUrl: "/workspaces/analytics",
    approvedBy: "hoshang@acme.com",
    linkedAt: Date.now(),
    token: "tok_x",
    detectedRemote: "github.com/acme/analytics-dbt",
    detectedProjectName: "analytics_dbt",
    ...overrides,
  }
}

async function clearOnboardingSignals() {
  await fs.rm(AltimateApi.credentialsPath(), { force: true })
  const all = await Auth.all()
  for (const key of Object.keys(all)) await Auth.remove(key)
}

// Both directions: some other file in the shared suite may have left auth state behind before
// this file's first test runs (isLikelyOnboarded reads real, XDG-isolated-but-suite-wide state,
// not per-test-file state) — beforeEach makes "nothing configured" true on entry, not assumed.
beforeEach(clearOnboardingSignals)
afterEach(clearOnboardingSignals)

test("isLikelyOnboarded: false when nothing is configured", async () => {
  expect(await isLikelyOnboarded()).toBe(false)
})

test("isLikelyOnboarded: true when the Altimate gateway credentials file exists", async () => {
  const p = AltimateApi.credentialsPath()
  await fs.mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true })
  await fs.writeFile(p, JSON.stringify({ altimateUrl: "https://x", altimateInstanceName: "x", altimateApiKey: "x" }))
  expect(await isLikelyOnboarded()).toBe(true)
})

test("isLikelyOnboarded: true when any provider auth is stored, even without altimate gateway credentials", async () => {
  await Auth.set("anthropic", { type: "api", key: "sk-test" })
  expect(await isLikelyOnboarded()).toBe(true)
})

test("nameMatches: matches the workspace name or slug, case-insensitively", () => {
  const binding = fakeBinding()
  expect(nameMatches("Analytics", binding)).toBe(true)
  expect(nameMatches("analytics", binding)).toBe(true)
  expect(nameMatches("ANALYTICS", binding)).toBe(true)
  expect(nameMatches("analytics ", binding)).toBe(true) // trimmed
  expect(nameMatches("Marketing", binding)).toBe(false)
})

test("hasDrifted: no drift when detected values match the binding", () => {
  const binding = fakeBinding()
  expect(hasDrifted({ remote: "github.com/acme/analytics-dbt", name: "analytics_dbt" }, binding)).toBe(false)
})

test("hasDrifted: no drift when detection returns no signal (null) — missing data is not evidence of a different project", () => {
  const binding = fakeBinding()
  expect(hasDrifted({ remote: null, name: null }, binding)).toBe(false)
})

test("hasDrifted: drift when the remote disagrees", () => {
  const binding = fakeBinding()
  expect(hasDrifted({ remote: "github.com/acme/DIFFERENT-repo", name: "analytics_dbt" }, binding)).toBe(true)
})

test("hasDrifted: drift when the dbt project name disagrees, even if the remote matches — keyed on BOTH, not remote alone", () => {
  const binding = fakeBinding()
  // Same git remote (a monorepo scenario: one repo, multiple dbt projects) but a different
  // detected project name — a remote-only check would wrongly say "no drift" here.
  expect(hasDrifted({ remote: "github.com/acme/analytics-dbt", name: "a_completely_different_project" }, binding)).toBe(true)
})

test("hasDrifted: a branch is never part of the comparison at all — the hint has no branch field to disagree on", () => {
  // WorkspaceLinkProjectHint has no branch field (checked at the type level) — this test exists
  // to document that fact, not to exercise a code path: there is no way to FEED a branch into
  // hasDrifted even if one wanted to, which is the point ("branch switches are not drift").
  const binding = fakeBinding()
  expect(hasDrifted({ remote: binding.detectedRemote, name: binding.detectedProjectName }, binding)).toBe(false)
})

test("session-context: set then get returns exactly what was set, and clearing it (undefined) is respected", () => {
  setResolvedWorkspace({ workspaceId: "wks_abc", token: "tok_abc" })
  expect(getResolvedWorkspace()).toEqual({ workspaceId: "wks_abc", token: "tok_abc" })
  setResolvedWorkspace(undefined)
  expect(getResolvedWorkspace()).toBeUndefined()
})

test("persistApprovedBinding stores the detected remote/project name pair alongside the rest of the binding", async () => {
  const directory = "/fake/dir/" + crypto.randomUUID()
  await persistApprovedBinding(
    directory,
    { remote: "github.com/acme/marketing-dbt", name: "marketing_dbt" },
    "wsl_new",
    { status: "approved", approved_by: "a@acme.com", workspace: { id: "wks_new", name: "Marketing", slug: "marketing", manage_url: "/workspaces/marketing", token: "tok_new" } },
  )
  const stored = await readBinding(directory)
  expect(stored).toEqual({
    projectId: directory,
    linkId: "wsl_new",
    workspaceId: "wks_new",
    workspaceName: "Marketing",
    workspaceSlug: "marketing",
    manageUrl: "/workspaces/marketing",
    approvedBy: "a@acme.com",
    linkedAt: stored!.linkedAt,
    token: "tok_new",
    detectedRemote: "github.com/acme/marketing-dbt",
    detectedProjectName: "marketing_dbt",
  })
})

// checkpoint 8i — "no double-prompt in either ordering." This is the post-scan-dialog-first
// ordering: the directory is bound entirely through persistIfApproved (the httpapi poll
// handler's own fix, exercised in test/server/.../workspace-link.test.ts), with resolve.ts's
// own launch-time flow never having run for it at all. A later launch must attach silently —
// no unbound-prompt, no drift-prompt (nothing detected for a fake directory reads as "no
// signal", never as drift) — proving the binding IS what the two paths actually share.
test("resolveWorkspaceForLaunch: a directory bound via the post-scan dialog is silently attached on the next launch, never re-prompted", async () => {
  process.env["ALTIMATE_WORKSPACE_LINK"] = "1"
  try {
    const directory = "/fake/ordering-post-scan-first/" + crypto.randomUUID()
    await persistIfApproved(
      { directory, project: { id: "proj_ordering_a", name: "ordering_a" } },
      "wsl_ordering_a",
      {
        status: "approved",
        approved_by: "a@acme.com",
        workspace: { id: "wks_ordering_a", name: "OrderingA", slug: "ordering-a", manage_url: "/workspaces/ordering-a", token: "tok_ordering_a" },
      },
    )
    setResolvedWorkspace(undefined)
    // If this reached promptUnbound/promptDrift it would hang on real stdin in this
    // non-interactive test — completing at all is part of what proves no prompt fired.
    await resolveWorkspaceForLaunch(directory, undefined)
    expect(getResolvedWorkspace()).toEqual({ workspaceId: "wks_ordering_a", token: "tok_ordering_a" })
  } finally {
    delete process.env["ALTIMATE_WORKSPACE_LINK"]
    setResolvedWorkspace(undefined)
  }
})
