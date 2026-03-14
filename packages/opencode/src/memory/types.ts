import z from "zod"

export const MemoryBlockSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "ID must be lowercase alphanumeric with hyphens/underscores, starting with alphanumeric",
  }),
  scope: z.enum(["global", "project"]),
  tags: z.array(z.string().max(64)).max(10).default([]),
  created: z.string().datetime(),
  updated: z.string().datetime(),
  content: z.string(),
})

export type MemoryBlock = z.infer<typeof MemoryBlockSchema>

export const MEMORY_MAX_BLOCK_SIZE = 2048
export const MEMORY_MAX_BLOCKS_PER_SCOPE = 50
export const MEMORY_DEFAULT_INJECTION_BUDGET = 8000
