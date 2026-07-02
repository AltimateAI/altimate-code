import { Schema } from "effect"
// altimate_change start — upstream_fix: QuestionID zod validators must preserve the que prefix
import z from "zod"
// altimate_change end

import { Identifier } from "@/id/id"
import { Newtype } from "@opencode-ai/core/schema"

export class QuestionID extends Newtype<QuestionID>()("QuestionID", Schema.String.check(Schema.isStartsWith("que"))) {
  static ascending(id?: string): QuestionID {
    return this.make(Identifier.ascending("question", id))
  }
  // altimate_change start — upstream_fix: restore que-prefix validation for zod callers
  static zod = z
    .string()
    .startsWith("que")
    .transform((value) => QuestionID.make(value))
  // altimate_change end
}
