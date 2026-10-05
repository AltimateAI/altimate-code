// altimate_change - new file
import { expect, test } from "bun:test"
import { buildTrajectoryExport } from "../../src/cli/cmd/trajectory"
import { buildDigest, sourceFromTrajectory } from "../../src/altimate/learn/digest"

const session = { id: "ses_test", title: "test", time: { created: 0, updated: 10 } } as never
const messages = [{ info: { role: "user", agent: "build" }, parts: [
  { type: "text", text: "Inspect orders with password=hunter2 for alice@example.com" },
  { type: "text", text: "synthetic text", synthetic: true },
  { type: "text", text: "ignored text", ignored: true },
] }] as never

test("trajectory export omits user prompts by default", () => {
  const exported = buildTrajectoryExport(session, messages)
  expect(exported).not.toHaveProperty("user_prompts")
  expect(JSON.stringify(exported)).not.toContain("hunter2")
  expect(sourceFromTrajectory(exported).prompts).toEqual([])
})

test("trajectory export includes redacted prompts only when requested and remains usable by learn", () => {
  const exported = buildTrajectoryExport(session, messages, { includePrompts: true })
  expect(exported.user_prompts).toEqual(["Inspect orders with password=[REDACTED] for [REDACTED]"])
  expect(buildDigest(sourceFromTrajectory(exported))).toContain("Inspect orders")
  expect(JSON.stringify(exported)).not.toContain("hunter2")
})
