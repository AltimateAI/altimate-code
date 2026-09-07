import { Schema } from "effect"
import z from "zod"

import { withStatics } from "@/util/schema"

const providerIdSchema = Schema.String.pipe(Schema.brand("ProviderID"))

export type ProviderID = typeof providerIdSchema.Type

export const ProviderID = providerIdSchema.pipe(
  withStatics((schema: typeof providerIdSchema) => ({
    make: (id: string) => schema.make(id),
    zod: z.string().pipe(z.custom<ProviderID>()),
    // Well-known providers
    opencode: schema.make("opencode"),
    anthropic: schema.make("anthropic"),
    openai: schema.make("openai"),
    google: schema.make("google"),
    googleVertex: schema.make("google-vertex"),
    githubCopilot: schema.make("github-copilot"),
    githubCopilotEnterprise: schema.make("github-copilot-enterprise"),
    amazonBedrock: schema.make("amazon-bedrock"),
    azure: schema.make("azure"),
    openrouter: schema.make("openrouter"),
    mistral: schema.make("mistral"),
    // altimate_change start — snowflake cortex provider ID
    snowflakeCortex: schema.make("snowflake-cortex"),
    // altimate_change end
    // altimate_change start — databricks provider ID
    databricks: schema.make("databricks"),
    // altimate_change end
  })),
)

const modelIdSchema = Schema.String.pipe(Schema.brand("ModelID"))

export type ModelID = typeof modelIdSchema.Type

export const ModelID = modelIdSchema.pipe(
  withStatics((schema: typeof modelIdSchema) => ({
    make: (id: string) => schema.make(id),
    zod: z.string().pipe(z.custom<ModelID>()),
  })),
)

// altimate_change start — expose the module through the repository's namespace projection convention
export * as ProviderSchema from "./schema"
// altimate_change end
