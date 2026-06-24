// altimate_change start — restore fork project/schema: core exports `ID` (branded "Project.ID"),
// but fork consumers (project.ts, server/routes/project.ts, permission/next.ts, session/index.ts)
// depend on the `ProjectID` brand plus the `.zod`/`.make`/`.global` statics. Restored from main.
import { Schema } from "effect"
import z from "zod"

import { withStatics } from "@/util/schema"

const projectIdSchema = Schema.String.pipe(Schema.brand("ProjectID"))

export type ProjectID = typeof projectIdSchema.Type

export const ProjectID = projectIdSchema.pipe(
  withStatics((schema: typeof projectIdSchema) => ({
    global: schema.make("global"),
    make: (id: string) => schema.make(id),
    zod: z.string().pipe(z.custom<ProjectID>()),
  })),
)
// altimate_change end
