import { expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SchemaAST } from "effect"

test("retrieved lesson configuration describes the session-start limit", () => {
  const learn = ConfigV1.Info.fields.learn.schema.members[0]
  const description = SchemaAST.resolveDescription(learn.fields.retrieved_lessons.ast)
  expect(description).toContain("at session start")
  expect(description).not.toContain("per user message")
})
