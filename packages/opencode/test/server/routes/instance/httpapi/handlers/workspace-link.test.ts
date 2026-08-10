// altimate_change — checkpoint 8i. persistIfApproved is the fix for a real gap: the wire
// response to the TUI's post-scan Path B dialog is schema-stripped of workspace.token
// (WorkspaceLinkPollResult in groups/workspace-link.ts), so dialog-workspace-link.tsx cannot
// itself persist a working binding on approval. This is the one place with both the real token
// and the resolved directory in scope — a plain async function, not an Effect generator, so it's
// testable directly without the httpapi/InstanceState harness.
import { expect, test } from "bun:test"
import { persistIfApproved } from "../../../../../../src/server/routes/instance/httpapi/handlers/workspace-link"
import { readBinding } from "../../../../../../src/altimate/workspace-link/state"
import { writeScanCache } from "../../../../../../src/altimate/workspace-link/scan-cache"
import { Filesystem } from "../../../../../../src/util/filesystem"
import type { WorkspaceLinkPollResponse } from "../../../../../../src/altimate/workspace-link/types"

test("persistIfApproved records the binding, keyed on the same resolved directory resolve.ts uses", async () => {
  const directory = "/fake/post-scan-dir/" + crypto.randomUUID()
  const result: WorkspaceLinkPollResponse = {
    status: "approved",
    approved_by: "hoshang@acme.com",
    workspace: { id: "wks_post_scan", name: "Analytics", slug: "analytics", manage_url: "/workspaces/analytics", token: "tok_post_scan" },
  }

  await persistIfApproved({ directory, project: { id: "proj_" + crypto.randomUUID(), name: "Analytics" } }, "wsl_post_scan", result)

  const stored = await readBinding(Filesystem.resolve(directory))
  expect(stored?.workspaceId).toBe("wks_post_scan")
  expect(stored?.token).toBe("tok_post_scan")
  expect(stored?.linkId).toBe("wsl_post_scan")
})

// checkpoint 8k bug fix: the scan cache's own detected `name` used to be discarded — resolveHint's
// cached branch fell back straight to instance.project.name (usually unset), which is how a
// project scan of a real jaffle_shop-named dbt project still produced a workspace literally named
// "Workspace". Prove the cached name now wins, exactly the way the non-cached (buildProjectHint)
// branch already preferred a real detected name over instance.project.name.
test("persistIfApproved's hint resolution prefers the scan cache's own detected name over instance.project.name", async () => {
  const directory = "/fake/post-scan-dir/" + crypto.randomUUID()
  const projectId = "proj_" + crypto.randomUUID()
  writeScanCache(projectId, {
    name: "jaffle_shop",
    adapter: null,
    modelCount: 12,
    sourceCount: null,
    testCount: null,
    gitRemote: "git@github.com:example/jaffle-shop.git",
    gitBranch: "main",
    hasWarehouse: false,
  })
  const result: WorkspaceLinkPollResponse = {
    status: "approved",
    approved_by: "hoshang@acme.com",
    workspace: { id: "wks_jaffle", name: "jaffle_shop", slug: "jaffle-shop", manage_url: "/workspaces/jaffle-shop", token: "tok_jaffle" },
  }

  // instance.project.name is deliberately something ELSE (or unset) — if the cached name didn't
  // win, this would end up as the persisted detectedProjectName instead of "jaffle_shop".
  await persistIfApproved({ directory, project: { id: projectId, name: null } }, "wsl_jaffle", result)

  const stored = await readBinding(Filesystem.resolve(directory))
  expect(stored?.detectedProjectName).toBe("jaffle_shop")
  expect(stored?.detectedRemote).toBe("git@github.com:example/jaffle-shop.git")
})

test("persistIfApproved is a no-op for pending/declined/expired — never overwrites or creates a binding on anything but approved", async () => {
  const directory = "/fake/post-scan-dir/" + crypto.randomUUID()
  await persistIfApproved({ directory, project: { id: "proj_x", name: null } }, "wsl_x", { status: "pending" })
  await persistIfApproved({ directory, project: { id: "proj_x", name: null } }, "wsl_x", { status: "declined" })
  await persistIfApproved({ directory, project: { id: "proj_x", name: null } }, "wsl_x", { status: "expired" })

  expect(await readBinding(Filesystem.resolve(directory))).toBeUndefined()
})
