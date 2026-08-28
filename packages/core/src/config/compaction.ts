export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
  // altimate_change start — V2 parity for the fork's verbatim-tail turn count
  // (V1 compaction.tail_turns; 0 disables the tail entirely).
  turns: NonNegativeInt.pipe(Schema.optional),
  // altimate_change end
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  // altimate_change start — V2 parity for the fork compaction keys (estimator
  // safety margin, state ledger/summary carry, task pin). Same names as V1 so
  // ConfigMigrateV1 can carry them through without renames.
  context_safety_fraction: Schema.Number.pipe(Schema.optional),
  state_ledger: Schema.Boolean.pipe(Schema.optional),
  ledger_max_tokens: NonNegativeInt.pipe(Schema.optional),
  ledger_recent_calls: NonNegativeInt.pipe(Schema.optional),
  summary_carry: Schema.Boolean.pipe(Schema.optional),
  summary_first_person: Schema.Boolean.pipe(Schema.optional),
  pin_task: Schema.Boolean.pipe(Schema.optional),
  pin_max_tokens: NonNegativeInt.pipe(Schema.optional),
  pin_window_fraction: Schema.Number.pipe(Schema.optional),
  pin_card_max_tokens: NonNegativeInt.pipe(Schema.optional),
  // altimate_change end
}) {}
