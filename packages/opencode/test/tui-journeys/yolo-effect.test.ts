// altimate_change — functional end-to-end coverage for YOLO mode.
//
// yolo.test.ts proves the UI states. This file proves the thing the UI is a
// control for: that enabling yolo actually stops the agent asking, that disabling
// restores asking, and that the guardrails the confirmation dialog promises are
// real rather than aspirational.
//
// Assertions are on OBSERVABLE SIDE EFFECTS (did the command run? does the marker
// file exist?) rather than on the permission dialog's text. journeys.test.ts
// documents that the permission prompt does not render reliably under the mock-model
// harness, so dialog-text assertions are flaky — but whether a tool actually EXECUTED
// is unambiguous, and is the property that matters for a permission bypass.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { booted, submitPrompt, suiteEnabled, withJourney, type TmuxJourney } from "./harness"

const maybeDescribe = suiteEnabled() ? describe : describe.skip
const journeyOptions = { timeout: 90_000, retry: 1 }

// bash must be "ask" for this suite to mean anything: the harness default is
// `"*": "allow"`, under which nothing ever prompts and yolo would be a no-op.
const askForBash = {
  env: { ALTIMATE_CLI_YOLO: "false" },
  config: (base: Record<string, unknown>) => {
    const agent = (base.agent ?? {}) as Record<string, Record<string, unknown>>
    return {
      ...base,
      agent: {
        ...agent,
        builder: {
          ...agent.builder,
          permission: { "*": "allow", question: "allow", plan_enter: "allow", bash: "ask" },
        },
      },
    }
  },
}

async function exists(file: string) {
  return await fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function enableYolo(tui: TmuxJourney) {
  tui.send("C-y")
  await tui.waitFor((plain) => /Turn on YOLO mode for this session\?/i.test(plain), 20_000)
  tui.send("y")
  await tui.waitFor((plain) => /YOLO ON/i.test(plain), 20_000)
}

maybeDescribe("real-binary TUI journeys: yolo mode behaviour", () => {
  test(
    "yolo off: an ask-gated command does NOT run on its own",
    async () => {
      // Control case. If this ever starts passing trivially (the command runs with
      // yolo off), the suite below proves nothing and the permission gate has broken.
      await withJourney(
        "yolo effect control",
        async (tui, ctx) => {
          const marker = path.join(ctx.workspace, "ran-without-yolo.txt")
          await booted(tui)
          await tui.ctx.llm.tool("bash", {
            command: `touch ${JSON.stringify(marker)}`,
            description: "create marker",
          })
          await tui.ctx.llm.text("done")
          await submitPrompt(tui, "create the marker")
          await Bun.sleep(12_000)
          expect(await exists(marker)).toBe(false)
        },
        askForBash,
      )
    },
    journeyOptions,
  )

  test(
    "yolo on: an ask-gated command runs without prompting",
    async () => {
      await withJourney(
        "yolo effect enabled",
        async (tui, ctx) => {
          const marker = path.join(ctx.workspace, "ran-with-yolo.txt")
          await booted(tui)
          await enableYolo(tui)
          await tui.ctx.llm.tool("bash", {
            command: `touch ${JSON.stringify(marker)}`,
            description: "create marker",
          })
          await tui.ctx.llm.text("done")
          await submitPrompt(tui, "create the marker")
          await tui.waitFor(async () => await exists(marker), 40_000)
          expect(await exists(marker)).toBe(true)
        },
        askForBash,
      )
    },
    journeyOptions,
  )

  test(
    "guardrails hold under yolo: a denied DDL command never executes",
    async () => {
      // The claim printed in the confirmation dialog. DROP DATABASE is a hard "deny"
      // in agent.ts safetyDenials, and Permission.ask refuses deny matches before any
      // event reaches the TUI — so yolo must have no way to auto-approve it.
      //
      // The command is `DROP DATABASE x ; touch <marker>`: the whole string matches the
      // "DROP DATABASE *" deny pattern, so bash should never run. If the guardrail
      // leaked, bash WOULD run and the trailing touch would land the marker even though
      // the DDL itself is not a shell builtin. Marker present == guardrail bypassed.
      await withJourney(
        "yolo effect guardrail",
        async (tui, ctx) => {
          const marker = path.join(ctx.workspace, "ddl-bypassed.txt")
          await booted(tui)
          await enableYolo(tui)
          await tui.ctx.llm.tool("bash", {
            command: `DROP DATABASE prod ; touch ${JSON.stringify(marker)}`,
            description: "drop the database",
          })
          await tui.ctx.llm.text("done")
          await submitPrompt(tui, "drop the prod database")
          await Bun.sleep(15_000)
          expect(await exists(marker)).toBe(false)
        },
        askForBash,
      )
    },
    journeyOptions,
  )

  test(
    "control for the guardrail test: the same semicolon-chained shape DOES run under yolo",
    async () => {
      // Without this, the guardrail test above is vacuous: a missing marker file would
      // be equally consistent with "the deny rule worked" and with "semicolon-chained
      // commands never execute under this harness at all". This runs the identical
      // shape with the DDL prefix replaced by a harmless echo, so the ONLY difference
      // between the two cases is the denied pattern.
      await withJourney(
        "yolo effect guardrail control",
        async (tui, ctx) => {
          const marker = path.join(ctx.workspace, "chained-ran.txt")
          await booted(tui)
          await enableYolo(tui)
          await tui.ctx.llm.tool("bash", {
            command: `echo prod ; touch ${JSON.stringify(marker)}`,
            description: "harmless chained command",
          })
          await tui.ctx.llm.text("done")
          await submitPrompt(tui, "run the harmless chained command")
          await tui.waitFor(async () => await exists(marker), 40_000)
          expect(await exists(marker)).toBe(true)
        },
        askForBash,
      )
    },
    journeyOptions,
  )

  test(
    "turning yolo back off restores prompting",
    async () => {
      await withJourney(
        "yolo effect toggled back off",
        async (tui, ctx) => {
          const allowed = path.join(ctx.workspace, "while-on.txt")
          const blocked = path.join(ctx.workspace, "after-off.txt")
          await booted(tui)
          await enableYolo(tui)

          await tui.ctx.llm.tool("bash", {
            command: `touch ${JSON.stringify(allowed)}`,
            description: "create marker",
          })
          await tui.ctx.llm.text("done")
          await submitPrompt(tui, "first marker")
          await tui.waitFor(async () => await exists(allowed), 40_000)

          // Off again — no confirmation expected on the way out.
          tui.send("C-y")
          await tui.waitFor((plain) => !/YOLO ON/i.test(plain), 20_000)

          await tui.ctx.llm.tool("bash", {
            command: `touch ${JSON.stringify(blocked)}`,
            description: "create marker",
          })
          await tui.ctx.llm.text("done")
          await submitPrompt(tui, "second marker")
          await Bun.sleep(12_000)
          expect(await exists(blocked)).toBe(false)
        },
        askForBash,
      )
    },
    journeyOptions,
  )
})
