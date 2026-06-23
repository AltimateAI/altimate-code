// Adversarial / regression tests for the v0.8.0 release.
//
// Primary focus: the `reviewer` agent (new in #856). A v0.8.0 release review
// found a P0 — the agent advertised "read-only / cannot modify files" but its
// bash allowlist (`git log *`, `cat *`, `ls *`) was bypassable to arbitrary
// file READ (exfil) and WRITE (shell redirects ride inside the matched
// command). The fix denies bash entirely for the reviewer; these tests pin that
// it stays denied and that the read-only intent holds.
import { test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"

function bashAction(agent: Agent.Info, command: string) {
  return PermissionNext.evaluate("bash", command, agent.permission).action
}

test("reviewer agent: bash is denied (base)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const reviewer = await Agent.get("reviewer")
      expect(reviewer).toBeDefined()
      expect(PermissionNext.evaluate("bash", "*", reviewer!.permission).action).toBe("deny")
    },
  })
})

test("reviewer agent: redirect-write and arbitrary-read bash commands are denied", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const reviewer = (await Agent.get("reviewer"))!
      // Write via redirect riding inside a once-allowed `git log *` pattern.
      expect(bashAction(reviewer, "git log -p HEAD > ~/.ssh/authorized_keys")).toBe("deny")
      expect(bashAction(reviewer, "git diff HEAD >> ~/.bashrc")).toBe("deny")
      expect(bashAction(reviewer, "ls > /etc/cron.d/pwn")).toBe("deny")
      // Arbitrary file read (credential exfil) that `cat *` used to allow.
      expect(bashAction(reviewer, "cat ~/.altimate/altimate.json")).toBe("deny")
      expect(bashAction(reviewer, "cat .env")).toBe("deny")
      // Even the previously-allowed read-only git inspection is now denied.
      expect(bashAction(reviewer, "git log --oneline")).toBe("deny")
    },
  })
})

test("reviewer agent: write/edit tools are denied, engine + read-only tools allowed", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const reviewer = (await Agent.get("reviewer"))!
      const action = (perm: string) => PermissionNext.evaluate(perm, "*", reviewer.permission).action
      // Mutation denied — the verdict engine never writes.
      expect(action("edit")).toBe("deny")
      expect(action("write")).toBe("deny")
      expect(action("sql_execute_write")).toBe("deny")
      // The verdict engine + read-only analysis tools remain available.
      expect(action("dbt_pr_review")).toBe("allow")
      expect(action("read")).toBe("allow")
      expect(action("grep")).toBe("allow")
      expect(action("glob")).toBe("allow")
    },
  })
})

test("reviewer agent is a selectable primary agent (not the default)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const names = (await Agent.list()).map((a) => a.name)
      expect(names).toContain("reviewer")
      // reviewer is selectable but must NOT hijack the default agent.
      expect(await Agent.defaultAgent()).not.toBe("reviewer")
    },
  })
})
