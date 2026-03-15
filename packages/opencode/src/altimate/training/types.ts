// altimate_change - Training types for AI Teammate learning system
import z from "zod"

export const TRAINING_TAG = "training"
export const TRAINING_ID_PREFIX = "training"
export const TRAINING_MAX_PATTERNS_PER_KIND = 20
// Budget scales with available context. Default is generous; users can override via config.
export const TRAINING_BUDGET = 16000

export const TrainingKind = z.enum(["pattern", "rule", "glossary", "standard", "context", "playbook"])
export type TrainingKind = z.infer<typeof TrainingKind>

export const TrainingBlockMeta = z.object({
  kind: TrainingKind,
  source: z.string().optional(),
  applied: z.number().int().min(0).default(0),
})
export type TrainingBlockMeta = z.infer<typeof TrainingBlockMeta>

export function trainingId(kind: TrainingKind, name: string): string {
  return `${TRAINING_ID_PREFIX}/${kind}/${name}`
}

export function trainingTags(kind: TrainingKind, extra: string[] = []): string[] {
  return [TRAINING_TAG, kind, ...extra]
}

export function isTrainingBlock(block: { tags: string[] }): boolean {
  return block.tags.includes(TRAINING_TAG)
}

export function trainingKind(block: { tags: string[] }): TrainingKind | undefined {
  for (const tag of block.tags) {
    const parsed = TrainingKind.safeParse(tag)
    if (parsed.success) return parsed.data
  }
  return undefined
}

export function parseTrainingMeta(content: string): TrainingBlockMeta | undefined {
  // Training blocks store structured metadata in the first YAML-like section
  const match = content.match(/^<!--\s*training\n([\s\S]*?)\n-->/)
  if (!match) return undefined
  const meta: Record<string, unknown> = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value: unknown = line.slice(idx + 1).trim()
    if (value === "") continue
    if (/^\d+$/.test(value as string)) value = parseInt(value as string, 10)
    meta[key] = value
  }
  const result = TrainingBlockMeta.safeParse(meta)
  return result.success ? result.data : undefined
}

export function embedTrainingMeta(content: string, meta: TrainingBlockMeta): string {
  const header = [
    "<!-- training",
    `kind: ${meta.kind}`,
    ...(meta.source ? [`source: ${meta.source}`] : []),
    `applied: ${meta.applied}`,
    "-->",
  ].join("\n")
  // Strip existing training meta block if present
  const stripped = content.replace(/^<!--\s*training\n[\s\S]*?-->\n*/, "")
  return header + "\n" + stripped
}
