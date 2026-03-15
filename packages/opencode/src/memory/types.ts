import z from "zod"

export const CitationSchema = z.object({
  file: z.string().min(1).max(512),
  line: z.number().int().positive().optional(),
  note: z.string().max(256).optional(),
})

export type Citation = z.infer<typeof CitationSchema>

// Each path segment must start and end with alphanumeric.
// Segments are separated by '/'. No '..' or '.' as standalone segments (prevents path traversal).
// No double slashes, no leading/trailing slashes.
const MEMORY_ID_SEGMENT = /[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?/
const MEMORY_ID_REGEX = new RegExp(
  `^${MEMORY_ID_SEGMENT.source}(?:\\.${MEMORY_ID_SEGMENT.source})*(?:/${MEMORY_ID_SEGMENT.source}(?:\\.${MEMORY_ID_SEGMENT.source})*)*$`,
)

export const MemoryBlockSchema = z.object({
  id: z.string().min(1).max(256).regex(MEMORY_ID_REGEX, {
    message: "ID must be lowercase alphanumeric segments separated by '/' or '.', each starting/ending with alphanumeric. No '..' or empty segments allowed.",
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

// altimate_change start - unified injection budget and agent-aware relevance scoring
export const UNIFIED_INJECTION_BUDGET = 20000

/** Per-agent relevance weights for training entry kinds. Higher = more relevant to that agent. */
export const AGENT_TRAINING_RELEVANCE: Record<string, Partial<Record<string, number>>> = {
  builder: { rule: 5, pattern: 5, standard: 3, playbook: 3, glossary: 1, context: 1 },
  analyst: { glossary: 5, context: 5, rule: 3, standard: 3, pattern: 1, playbook: 1 },
  executive: { glossary: 5, context: 5, playbook: 3, rule: 1, pattern: 1, standard: 1 },
  validator: { rule: 5, standard: 5, pattern: 3, context: 1, glossary: 1, playbook: 1 },
  migrator: { pattern: 5, rule: 5, context: 3, standard: 3, glossary: 1, playbook: 1 },
  researcher: { context: 5, glossary: 5, rule: 3, pattern: 3, standard: 1, playbook: 1 },
  trainer: { rule: 3, pattern: 3, glossary: 3, standard: 3, context: 3, playbook: 3 },
}

export interface InjectionContext {
  agent?: string
  disableTraining?: boolean
}
// altimate_change end
