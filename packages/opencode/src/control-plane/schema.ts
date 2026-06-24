// altimate_change start — WorkspaceID moved to core as WorkspaceV2.ID. Re-base the fork's
// WorkspaceID on the core brand so branded IDs stay assignable to WorkspaceContext, while
// preserving the imperative .make()/.zod statics the HTTP layer consumes.
import z from "zod"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"

import { withStatics } from "@/util/schema"

export type WorkspaceID = WorkspaceV2.ID

export const WorkspaceID = WorkspaceV2.ID.pipe(
  withStatics((schema: typeof WorkspaceV2.ID) => ({
    make: (id: string) => schema.make(id),
    ascending: (id?: string) => schema.ascending(id),
    zod: z.string().pipe(z.custom<WorkspaceID>()),
  })),
)
// altimate_change end
