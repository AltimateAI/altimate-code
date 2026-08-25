// altimate_change — THE credential schema. Both Auth implementations decode `auth.json` with it.
//
// There were two copies, and they had silently diverged: `auth/service.ts` declared `Api` WITHOUT
// the `metadata` field. Decoding narrows to the declared shape, and both implementations
// read-modify-write the WHOLE file, so any provider added or removed through `AuthService`
// rewrote every other entry through the narrower schema and dropped `metadata` from all of them.
// For the free tier that means `install_secret` and `base_url` vanish: the provider stops loading
// and, worse, loses the install secret the gateway derives its budget principal from — so the
// next registration mints a SECOND principal instead of rotating the existing one.
//
// Nothing about that is visible from either file alone, which is why two review rounds missed it.
// One schema, imported by both, is the only version of this that cannot drift again.
import { Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  // Load-bearing for the free tier: `install_secret` is the gateway's budget-principal identity
  // and `base_url` is where inference is routed. Dropping either breaks the provider.
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({
  discriminator: "type",
  identifier: "Auth",
})
export type Info = Schema.Schema.Type<typeof Info>
