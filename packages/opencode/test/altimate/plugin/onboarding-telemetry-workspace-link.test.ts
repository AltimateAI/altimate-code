// altimate_change — checkpoint 8i. The other half of "no double-prompt in either ordering":
// a directory already bound (via either consent flow) must never be re-offered by
// onboarding-telemetry.ts's own project_scan hook. Covers offerWorkspaceLink directly rather
// than the whole plugin's telemetry-inference machinery (out of scope here) — a scan-cache
// write is the observable side effect that "did the offer actually proceed" hinges on.
import { expect, test } from "bun:test"
import { offerWorkspaceLink } from "../../../src/altimate/plugin/onboarding-telemetry"
import { persistApprovedBinding } from "../../../src/altimate/workspace-link/flow"
import { readFreshScanCache } from "../../../src/altimate/workspace-link/scan-cache"
import { recordApproved } from "../../../src/altimate/workspace-link/state"
import { Filesystem } from "../../../src/util/filesystem"

function fakeBinding(overrides: Partial<Parameters<typeof recordApproved>[1]> = {}) {
  return {
    linkId: "wsl_x",
    workspaceId: "wks_x",
    workspaceName: "Analytics",
    workspaceSlug: "analytics",
    manageUrl: "/workspaces/analytics",
    approvedBy: "hoshang@acme.com",
    linkedAt: Date.now(),
    token: "tok_x",
    detectedRemote: null,
    detectedProjectName: null,
    ...overrides,
  }
}

test("offerWorkspaceLink skips entirely (no scan-cache write) when the directory is already bound", async () => {
  const directory = "/fake/onboarding-dir/" + crypto.randomUUID()
  const projectId = "proj_" + crypto.randomUUID()
  await recordApproved(Filesystem.resolve(directory), fakeBinding())

  await offerWorkspaceLink(directory, projectId, { dbt: { found: true, name: "some_project", modelCount: 3 } })

  expect(readFreshScanCache(projectId)).toBeUndefined()
})

// checkpoint 8i — "no double-prompt in either ordering." This is the launch-time-first
// ordering: the directory is bound entirely through resolve.ts's own persistApprovedBinding
// (an already-onboarded user hitting the unbound launch-time prompt), with the post-scan dialog
// never having run for it. If onboarding's project_scan hook ever fires for this same
// directory afterward (a re-scan mid-session, or a later onboarding attempt), it must not
// re-offer — proving the two consent flows share one source of truth, not two independent ones.
test("offerWorkspaceLink never re-offers a directory the launch-time flow already bound", async () => {
  const directory = "/fake/ordering-launch-time-first/" + crypto.randomUUID()
  await persistApprovedBinding(
    directory,
    { remote: "github.com/acme/ordering-b.git", name: "ordering_b" },
    "wsl_ordering_b",
    {
      status: "approved",
      approved_by: "b@acme.com",
      workspace: { id: "wks_ordering_b", name: "OrderingB", slug: "ordering-b", manage_url: "/workspaces/ordering-b", token: "tok_ordering_b" },
    },
  )
  const projectId = "proj_ordering_b_" + crypto.randomUUID()

  await offerWorkspaceLink(directory, projectId, { dbt: { found: true, name: "ordering_b", modelCount: 5 } })

  expect(readFreshScanCache(projectId)).toBeUndefined()
})

test("offerWorkspaceLink proceeds (writes the scan cache) when the directory is unbound", async () => {
  const directory = "/fake/onboarding-dir/" + crypto.randomUUID()
  const projectId = "proj_" + crypto.randomUUID()

  await offerWorkspaceLink(directory, projectId, { dbt: { found: true, name: "some_project", modelCount: 3 } })

  const cached = readFreshScanCache(projectId)
  expect(cached).toBeDefined()
  expect(cached?.modelCount).toBe(3)
})
