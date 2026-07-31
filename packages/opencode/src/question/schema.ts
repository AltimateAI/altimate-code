// altimate_change start — upstream_fix: QuestionID zod validators must preserve the que prefix
import z from "zod"
// altimate_change end
import { QuestionV1 } from "@opencode-ai/schema/question-v1"

// altimate_change start — upstream_fix: restore que-prefix validation for zod callers
// (QuestionV1.ID has no zod-compatible validator; server/routes/question.ts uses QuestionID.zod
// directly inside a zod object at the Hono edge).
export const QuestionID = Object.assign(QuestionV1.ID, {
  zod: z
    .string()
    .startsWith("que")
    .transform((value) => QuestionV1.ID.make(value)),
})
// altimate_change end
export type QuestionID = typeof QuestionID.Type
