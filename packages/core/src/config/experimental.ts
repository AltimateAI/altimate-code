export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"
import { Catalog } from "../catalog"
import { Policy as PolicyV2 } from "../policy"
// altimate_change start — V2 parity for the write-starvation breaker
import { PositiveInt } from "../schema"
// altimate_change end

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Union([Catalog.PolicyActions])

export class Policy extends Schema.Class<Policy>("ConfigV2.Experimental.Policy")({
  ...PolicyV2.Info.fields,
  action: PolicyAction,
}) {}

// altimate_change start — V2 parity for the write-starvation breaker keys.
// Same names as V1 (config.ts experimental.starvation_breaker) so
// ConfigMigrateV1 can carry them through without renames.
export class StarvationBreaker extends Schema.Class<StarvationBreaker>("ConfigV2.Experimental.StarvationBreaker")({
  mode: Schema.Literals(["off", "annotate", "armed"]).pipe(Schema.optional),
  max_turns_without_mutation: PositiveInt.pipe(Schema.optional),
  repeat_signature_threshold: PositiveInt.pipe(Schema.optional),
  doom_loop_threshold: PositiveInt.pipe(Schema.optional),
  polling_threshold_multiplier: PositiveInt.pipe(Schema.optional),
  polling_pattern: Schema.String.pipe(Schema.optional),
  exempt_agents: Schema.String.pipe(Schema.Array, Schema.optional),
  generated_path_patterns: Schema.String.pipe(Schema.Array, Schema.optional),
}) {}
// altimate_change end

export class Experimental extends Schema.Class<Experimental>("ConfigV2.Experimental")({
  policies: Policy.pipe(Schema.Array, Schema.optional),
  // altimate_change start — V2 parity for the write-starvation breaker
  starvation_breaker: StarvationBreaker.pipe(Schema.optional),
  // altimate_change end
}) {}
