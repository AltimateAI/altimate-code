// altimate_change - new file
import { expect, test } from "bun:test"
import { seedMessage } from "../../../src/cli/cmd/link"

test("link names the retry when a memory seed left blocks behind", () => {
  expect(seedMessage({ status: "incomplete", sent: 1, pending: 3 })).toContain("3 saved memories did not reach")
  expect(seedMessage({ status: "incomplete", sent: 0, pending: 1 })).toContain("1 saved memory did not reach")
  expect(seedMessage({ status: "incomplete", sent: 0, pending: 0 })).toContain("Sync")
})

test("link reports a completed seed and memory that is off without a retry hint", () => {
  expect(seedMessage({ status: "seeded", sent: 2, pending: 0 })).toBe("Sent 2 saved memories to the workspace.")
  expect(seedMessage({ status: "seeded", sent: 0, pending: 0 })).toBe("Saved memory is in sync with the workspace.")
  expect(seedMessage({ status: "off", sent: 0, pending: 0 })).toBe(
    "Workspace memory is off, so saved memory stays on this machine.",
  )
  expect(seedMessage({ status: "already", sent: 0, pending: 0 })).toBe("Saved memory was already sent to this workspace.")
  expect(seedMessage({ status: "local-off", sent: 0, pending: 0 })).toContain("turned off on this machine")
  // A seed that could not run is not "memory is off".
  expect(seedMessage(null)).not.toContain("is off")
  expect(seedMessage(null)).toContain("Sync")
})

test("a 409 that withholds the workspace name is explained as a teammate's private workspace, not a race", async () => {
  const { ConflictError, isHiddenBindingConflict, HIDDEN_BINDING_MESSAGE } = await import(
    "../../../src/altimate/workspace/api-client"
  )
  expect(isHiddenBindingConflict(new ConflictError({ existing_datamate_id: 7, existing_datamate_name: null } as any))).toBe(true)
  expect(isHiddenBindingConflict(new ConflictError({ existing_datamate_id: 7 } as any))).toBe(true)
  expect(isHiddenBindingConflict(new ConflictError({ existing_datamate_id: 7, existing_datamate_name: "team" } as any))).toBe(false)
  // A 409 that is not a binding conflict (no workspace id) keeps its own message.
  expect(isHiddenBindingConflict(new ConflictError({ message: "conflict" } as any))).toBe(false)
  expect(isHiddenBindingConflict(new Error("x"))).toBe(false)
  expect(HIDDEN_BINDING_MESSAGE).toContain("share it with you")
})
