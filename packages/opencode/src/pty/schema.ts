// altimate_change start — restore fork ID statics (.make/.zod) on top of the core-aligned
// PtyID brand. The fork keeps its own Pty implementation (src/pty/index.ts) and HTTP routes
// (server/routes/pty.ts) which validate params via `PtyID.zod` and construct branded IDs via
// `PtyID.make`. Core's PtyID only ships `.ascending`, so re-brand here with the extra statics.
import { Schema } from "effect"
import z from "zod"
import { PtyID as CorePtyID } from "@opencode-ai/core/pty/schema"
import { Identifier } from "@/id/id"
import { withStatics } from "@opencode-ai/core/schema"

export const PtyID = CorePtyID.pipe(
  withStatics((s) => ({
    make: (id: string) => s.make(id),
    ascending: (id?: string) => s.make(Identifier.ascending("pty", id)),
    // altimate_change start — upstream_fix: restore pty-prefix validation for zod callers
    zod: z.string().startsWith("pty").pipe(z.custom<Schema.Schema.Type<typeof s>>()),
    // altimate_change end
  })),
)

export type PtyID = Schema.Schema.Type<typeof PtyID>
// altimate_change end
