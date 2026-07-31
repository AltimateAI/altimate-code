// altimate_change start — re-export shim: permission/schema moved to @opencode-ai/core.
// upstream_fix: the target moved again from `permission/schema` to the top-level `permission`
// module (`packages/core/src/permission.ts`) during the v1.18.10 makeGlobalNode migration.
export * from "@opencode-ai/core/permission"

// Restore the fork's PermissionID brand. Core's permission/schema only ships the
// PermissionV2 rule/effect schemas, not the request ID. Fork consumers
// (permission/next.ts, server/routes/{permission,session}.ts, tests) construct branded
// IDs via `.make`/`.ascending` and validate request payloads with `.zod`.
import { Schema } from "effect"
import z from "zod"
import { Identifier } from "@/id/id"
import { withStatics } from "@opencode-ai/core/schema"

export const PermissionID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("PermissionID"),
  withStatics((s) => ({
    make: (id: string) => s.make(id),
    ascending: (id?: string) => s.make(Identifier.ascending("permission", id)),
    zod: z.string().pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)
export type PermissionID = Schema.Schema.Type<typeof PermissionID>
// altimate_change end
