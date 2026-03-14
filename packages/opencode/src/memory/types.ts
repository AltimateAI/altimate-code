import z from "zod"

export const CitationSchema = z.object({
  file: z.string().min(1).max(512),
  line: z.number().int().positive().optional(),
  note: z.string().max(256).optional(),
})

export type Citation = z.infer<typeof CitationSchema>

export const MemoryBlockSchema = z.object({
  id: z.string().min(1).max(256).regex(/^[a-z0-9][a-z0-9_/.-]*[a-z0-9]$|^[a-z0-9]$/, {
    message: "ID must be lowercase alphanumeric with hyphens/underscores/slashes/dots, starting and ending with alphanumeric",
  }),
  scope: z.enum(["global", "project"]),
  tags: z.array(z.string().max(64)).max(10).default([]),
  created: z.string().datetime(),
  updated: z.string().datetime(),
  expires: z.string().datetime().optional(),
  citations: z.array(CitationSchema).max(10).optional(),
  content: z.string(),
})

export type MemoryBlock = z.infer<typeof MemoryBlockSchema>

export const MEMORY_MAX_BLOCK_SIZE = 2048
export const MEMORY_MAX_BLOCKS_PER_SCOPE = 50
export const MEMORY_MAX_CITATIONS = 10
export const MEMORY_DEFAULT_INJECTION_BUDGET = 8000
