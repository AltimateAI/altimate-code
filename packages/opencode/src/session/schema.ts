import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/id/id"
import { SessionV2 } from "@opencode-ai/core/session"
import { withStatics } from "@opencode-ai/core/schema"

// altimate_change start — restore fork ID statics (.make/.zod) on top of the core-aligned
// brands. Fork consumers (session/index.ts, server/routes/session.ts, permission/next.ts,
// session/{compaction,message-v2,prompt}.ts) validate request payloads with `*.zod` and
// construct branded IDs via `*.make`. Core's brands only ship `create/descending`/`ascending`.
export const SessionID = SessionV2.ID.pipe(
  withStatics((s) => ({
    make: (id: string) => s.make(id),
    zod: z.string().pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)
export type SessionID = Schema.Schema.Type<typeof SessionID>

export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(
  Schema.brand("MessageID"),
  withStatics((s) => ({
    make: (id: string) => s.make(id),
    ascending: (id?: string) => s.make(Identifier.ascending("message", id)),
    zod: z.string().pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>

export const PartID = Schema.String.check(Schema.isStartsWith("prt")).pipe(
  Schema.brand("PartID"),
  withStatics((s) => ({
    make: (id: string) => s.make(id),
    ascending: (id?: string) => s.make(Identifier.ascending("part", id)),
    zod: z.string().pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)

export type PartID = Schema.Schema.Type<typeof PartID>
// altimate_change end
