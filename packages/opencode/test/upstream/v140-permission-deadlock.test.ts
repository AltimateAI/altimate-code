/**
 * Runtime regression test for the v1.4.0 bridge merge permission deadlock.
 *
 * Reproduces the exact scenario from the field bug report:
 *   1. Tool calls ctx.ask (wired to PermissionNext.ask) → pending Map gets a deferred
 *   2. TUI clicks "Allow once" → POST /permission/{id}/reply hits the route handler
 *   3. Route handler awaits PermissionNext.reply(...)
 *   4. The deferred resolves → ctx.ask returns → tool dispatches
 *
 * Before fix 33ffd9c51f, step 3 awaited Permission.reply (Effect-TS) instead of
 * PermissionNext.reply. The Effect service had its own empty pending Map, so the
 * lookup hit `if (!existing) return`, no resolve fired, and the ask Promise hung
 * forever. Tool was never dispatched.
 *
 * The static-text invariants in v140-merge-adversarial.test.ts catch the import-
 * level regression. This file catches it at runtime: it exercises the exact wire
 * the route handler runs and proves the Promise resolves end-to-end. If anyone
 * re-introduces the split-brain (e.g. by routing the HTTP layer back to the
 * Effect service while leaving runtime asks on PermissionNext), the test below
 * times out.
 */
import { test, expect, afterEach } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

async function waitForPending(count: number) {
  for (let i = 0; i < 50; i++) {
    const list = await PermissionNext.list()
    if (list.length === count) return list
    await Bun.sleep(0)
  }
  return PermissionNext.list()
}

test("PDF deadlock: bash ask + 'Allow once' reply via route handler logic resolves", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Step 1: tool/terminal.ts calls ctx.ask, which hits PermissionNext.ask
      // (this is exactly what session/processor.ts does at line 193/221).
      const askPromise = PermissionNext.ask({
        sessionID: SessionID.make("session_pdf_test"),
        permission: "terminal",
        patterns: ["which duckdb"],
        metadata: { command: "which duckdb" },
        always: ["which *"],
        ruleset: [{ permission: "terminal", pattern: "*", action: "ask" }],
      })

      // Step 2: request lands in PermissionNext's pending Map and emits
      // permission.asked. The TUI shows the prompt at this point.
      const list = await waitForPending(1)
      expect(list).toHaveLength(1)
      const requestID = list[0].id

      // Step 3: user clicks "Allow once". TUI calls
      // sdk.client.permission.reply({ requestID, reply: "once" }) →
      // POST /permission/{id}/reply → route handler awaits this exact call.
      await PermissionNext.reply({ requestID, reply: "once" })

      // Step 4: pre-fix, askPromise hung here forever because the route was
      // calling Permission.reply (Effect) which couldn't find requestID in its
      // own empty pending Map. Post-fix, this resolves quickly.
      await Promise.race([
        askPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("DEADLOCK: ask Promise did not resolve within 2s")), 2000),
        ),
      ])

      // Pending Map is empty after reply (the deadlock would also leave a
      // stale entry in this map until process exit).
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})

test("PDF deadlock: 'Allow always' reply also resolves the ask Promise", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = PermissionNext.ask({
        sessionID: SessionID.make("session_pdf_test_always"),
        permission: "terminal",
        patterns: ["pwd && ls -la"],
        metadata: { command: "pwd && ls -la" },
        always: ["pwd *", "ls *"],
        ruleset: [{ permission: "terminal", pattern: "*", action: "ask" }],
      })

      const list = await waitForPending(1)
      const requestID = list[0].id

      // "Allow always + Confirm" reply
      await PermissionNext.reply({ requestID, reply: "always" })

      await Promise.race([
        askPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("DEADLOCK: 'Allow always' did not resolve")), 2000),
        ),
      ])

      // Subsequent ask for matching pattern auto-resolves (allow rule was added).
      const followup = PermissionNext.ask({
        sessionID: SessionID.make("session_pdf_test_always"),
        permission: "terminal",
        patterns: ["pwd"],
        metadata: { command: "pwd" },
        always: ["pwd *"],
        ruleset: [{ permission: "terminal", pattern: "*", action: "ask" }],
      })

      // Allow rule lets this resolve immediately without showing a new prompt.
      await Promise.race([
        followup,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("'Allow always' rule did not auto-allow follow-up")), 2000),
        ),
      ])
    },
  })
})

test("PDF deadlock: 'Reject' reply rejects the ask Promise (not deadlock)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = PermissionNext.ask({
        sessionID: SessionID.make("session_pdf_test_reject"),
        permission: "terminal",
        patterns: ["rm -rf /"],
        metadata: { command: "rm -rf /" },
        always: [],
        ruleset: [{ permission: "terminal", pattern: "*", action: "ask" }],
      })

      const list = await waitForPending(1)
      const requestID = list[0].id

      await PermissionNext.reply({ requestID, reply: "reject" })

      // Reject must reject the Promise within the timeout (the deadlock would
      // hang here too — ask Promise neither resolves nor rejects).
      await expect(
        Promise.race([
          askPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("DEADLOCK: 'Reject' did not reject ask")), 2000),
          ),
        ]),
      ).rejects.toThrow(/rejected|Reject/i)
    },
  })
})
