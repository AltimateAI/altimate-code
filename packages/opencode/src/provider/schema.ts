import { Schema } from "effect"
import z from "zod"

import { withStatics } from "@/util/schema"

const providerIdSchema = Schema.String.pipe(Schema.brand("ProviderID"))

export type ProviderID = typeof providerIdSchema.Type

export const ProviderID = providerIdSchema.pipe(
  withStatics((schema: typeof providerIdSchema) => ({
    make: (id: string) => schema.makeUnsafe(id),
    zod: z.string().pipe(z.custom<ProviderID>()),
    // Well-known providers
    opencode: schema.makeUnsafe("opencode"),
    anthropic: schema.makeUnsafe("anthropic"),
    openai: schema.makeUnsafe("openai"),
    google: schema.makeUnsafe("google"),
    googleVertex: schema.makeUnsafe("google-vertex"),
    githubCopilot: schema.makeUnsafe("github-copilot"),
    githubCopilotEnterprise: schema.makeUnsafe("github-copilot-enterprise"),
    amazonBedrock: schema.makeUnsafe("amazon-bedrock"),
    azure: schema.makeUnsafe("azure"),
    openrouter: schema.makeUnsafe("openrouter"),
    mistral: schema.makeUnsafe("mistral"),
    // altimate_change start — snowflake cortex provider ID
    snowflakeCortex: schema.makeUnsafe("snowflake-cortex"),
    // altimate_change end
    // altimate_change start — databricks provider ID
    databricks: schema.makeUnsafe("databricks"),
    // altimate_change end
  })),
)

const modelIdSchema = Schema.String.pipe(Schema.brand("ModelID"))

export type ModelID = typeof modelIdSchema.Type

export const ModelID = modelIdSchema.pipe(
  withStatics((schema: typeof modelIdSchema) => ({
    make: (id: string) => schema.makeUnsafe(id),
    zod: z.string().pipe(z.custom<ModelID>()),
  })),
)
