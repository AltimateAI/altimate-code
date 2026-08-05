// Adversarial / regression tests for the v0.8.0 release.
//
// Primary focus: the `reviewer` agent (new in #856). A v0.8.0 release review
// found a P0 — the agent advertised "read-only / cannot modify files" but its
// bash allowlist (`git log *`, `cat *`, `ls *`) was bypassable to arbitrary
// file READ (exfil) and WRITE (shell redirects ride inside the matched
// command). The v0.8.0 fix denied bash entirely; #978 relaxed that to "ask"
// (every command requires explicit user approval — nothing auto-runs) so the
// reviewer can `gh pr view` a PR URL. These tests pin the security intent:
// NO bash pattern auto-runs (nothing evaluates to "allow"), and destructive
// DDL stays hard-denied.
import { test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"

function bashAction(agent: Agent.Info, command: string) {
  return PermissionNext.evaluate("terminal", command, agent.permission).action
}

// The reviewer agent advertises read-only; these pin that NO bash command is
// auto-approved and arbitrary read/write cannot run silently. (Previously
// test.todo'd for a dual-DB migration race in Instance.provide — legacy
// src/storage/db.ts vs core Effect-SQL migration both creating `project` —
// now resolved by the fresh-install core-schema adoption fix in
// src/storage/db.ts; re-enabled and passing.)
test("reviewer agent: bash requires approval (base) — never auto-allowed", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const reviewer = await Agent.get("reviewer")
      expect(reviewer).toBeDefined()
      // #978: "ask" instead of "deny" so `gh pr view <url>` is possible with
      // explicit user approval. The P0 was auto-run via a bypassable allowlist;
      // "ask" never auto-runs.
      expect(PermissionNext.evaluate("terminal", "*", reviewer!.permission).action).toBe("ask")
    },
  })
})

test("reviewer agent: redirect-write and arbitrary-read bash commands never auto-run", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const reviewer = (await Agent.get("reviewer"))!
      // Write via redirect riding inside a once-allowed `git log *` pattern.
      // These surfaced the v0.8.0 P0 as silent auto-runs; they must never be "allow".
      expect(bashAction(reviewer, "git log -p HEAD > ~/.ssh/authorized_keys")).toBe("ask")
      expect(bashAction(reviewer, "git diff HEAD >> ~/.bashrc")).toBe("ask")
      expect(bashAction(reviewer, "ls > /etc/cron.d/pwn")).toBe("ask")
      // Arbitrary file read (credential exfil) that `cat *` used to auto-allow.
      expect(bashAction(reviewer, "cat ~/.altimate/altimate.json")).toBe("ask")
      expect(bashAction(reviewer, "cat .env")).toBe("ask")
      // Read-only git inspection also prompts (no allowlist at all).
      expect(bashAction(reviewer, "git log --oneline")).toBe("ask")
      // Destructive DDL stays hard-denied regardless of the ask default.
      expect(bashAction(reviewer, "DROP DATABASE prod")).toBe("deny")
      expect(bashAction(reviewer, "truncate users")).toBe("deny")
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
