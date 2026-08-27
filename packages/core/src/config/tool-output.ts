export * as ConfigToolOutput from "./tool-output"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.ToolOutput")({
  max_lines: PositiveInt.pipe(Schema.optional),
  max_bytes: PositiveInt.pipe(Schema.optional),
  // altimate_change start — V2 parity for the per-tool-result dispatch cap
  dispatch_max_tokens: PositiveInt.pipe(Schema.optional),
  // altimate_change end
}) {}
