// altimate_change — end-to-end proof that YOLO mode reaches SUBAGENTS.
//
// This is the behaviour the root-session normalization in src/util/yolo.ts exists
// for, and the claim the confirmation dialog makes ("Applies to subagents too").
// Until now it was only covered by unit tests over a synthetic parent map.
//
// Why it is not trivially covered: the task tool spawns the subagent in its OWN
// child session (packages/opencode/src/tool/task.ts creates one with parentID), so
// its permission requests arrive tagged with the CHILD id. A naive per-session
// lookup keyed on the id the user can see would leave subagents prompting forever.
//
// The `general` subagent inherits bash: "ask" from the agent defaults, so its bash
// call genuinely needs a permission decision. The off-control below is mandatory,
// not decorative: without it, a passing "marker exists" case would be equally
// consistent with "bash was allowed all along".
//
// Mock LLM queue is FIFO and shared across parent and child sessions; title requests
// are intercepted by the harness and do not consume queue items. Order is therefore:
//   1. parent turn      -> task(general)
//   2. subagent turn    -> bash(touch marker)
//   3. subagent closing -> text
//   4. parent closing   -> text
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { booted, submitPrompt, suiteEnabled, withJourney, type TmuxJourney } from "./harness"

const maybeDescribe = suiteEnabled() ? describe : describe.skip
const journeyOptions = { timeout: 120_000, retry: 1 }

const baseEnv = { env: { ALTIMATE_CLI_YOLO: "false" } }

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

async function scriptSubagentBash(tui: TmuxJourney, marker: string) {
  await tui.ctx.llm.tool("task", {
    subagent_type: "general",
    description: "create marker",
    prompt: "create the marker file",
  })
  await tui.ctx.llm.tool("bash", {
    command: `touch ${JSON.stringify(marker)}`,
    description: "create marker",
  })
  await tui.ctx.llm.text("subagent done")
  await tui.ctx.llm.text("parent done")
  await submitPrompt(tui, "delegate the marker creation")
}

maybeDescribe("real-binary TUI journeys: yolo reaches subagents", () => {
  test(
    "yolo on: a subagent's ask-gated command runs without prompting",
    async () => {
      await withJourney(
        "yolo subagent inherits",
        async (tui, ctx) => {
          const marker = path.join(ctx.workspace, "subagent-with-yolo.txt")
          await booted(tui)
          await enableYolo(tui)
          await scriptSubagentBash(tui, marker)
          await tui.waitFor(async () => await exists(marker), 60_000)
          expect(await exists(marker)).toBe(true)
        },
        baseEnv,
      )
    },
    journeyOptions,
  )

  test(
    "control — yolo off: the same subagent command does NOT run",
    async () => {
      // Proves the test above measures yolo inheritance rather than bash simply
      // being permitted for subagents.
      await withJourney(
        "yolo subagent control",
        async (tui, ctx) => {
          const marker = path.join(ctx.workspace, "subagent-without-yolo.txt")
          await booted(tui)
          await scriptSubagentBash(tui, marker)
          await Bun.sleep(25_000)
          expect(await exists(marker)).toBe(false)
        },
        baseEnv,
      )
    },
    journeyOptions,
  )
})
