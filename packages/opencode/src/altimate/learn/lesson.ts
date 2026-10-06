// altimate_change - new file
import z from "zod"
import type { Bullet } from "./playbook"

const id = z.string().regex(/^L-[0-9a-f]{4,}$/)
export const Lesson = z.object({
  id,
  text: z.string(),
  tags: z.array(z.string()),
  scope: z.literal("project"),
  pinned: z.boolean().optional(),
  trigger: z.object({ paths: z.array(z.string()).optional() }).strict().optional(),
  helpful: z.number().int().nonnegative(),
  harmful: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  coexists: z.array(id).optional(),
  created: z.string(),
  updated: z.string(),
  provenance: z.string().optional(),
}).strict()
export type Lesson = z.infer<typeof Lesson>
export const RetiredLesson = Lesson.extend({ supersededBy: id.optional(), reason: z.string() })
export type RetiredLesson = z.infer<typeof RetiredLesson>

/** Stable key order, including nested objects, for reviewed-content hashes. Array order is meaningful. */
export function canonical(value: unknown): string {
  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered)
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, ordered(v)]),
      )
    return value
  }
  return JSON.stringify(ordered(value), null, 2) + "\n"
}

export function parse(text: string): Lesson[] {
  const lessons = z.array(Lesson).parse(JSON.parse(text))
  const seen = new Set<string>()
  for (const lesson of lessons) {
    if (seen.has(lesson.id)) throw new Error(`candidate repeats bullet id ${lesson.id}`)
    seen.add(lesson.id)
  }
  return lessons
}

export function toBullet(lesson: Lesson): Bullet {
  return {
    id: lesson.id, text: lesson.text, helpful: lesson.helpful, harmful: lesson.harmful,
    ...(lesson.coexists ? { coexists: [...lesson.coexists] } : {}),
    ...(lesson.pinned !== undefined ? { pinned: lesson.pinned } : {}),
  }
}

/** Preserve store-only metadata while the existing curator operates on bullets. */
export function fromBullet(bullet: Bullet, previous?: Lesson, paths?: string[], now = new Date().toISOString()): Lesson {
  const next: Lesson = {
    id: bullet.id, text: bullet.text, tags: previous?.tags ?? [], scope: "project",
    helpful: bullet.helpful, harmful: bullet.harmful, applied: previous?.applied ?? 0,
    created: previous?.created ?? now, updated: previous?.updated ?? now,
    ...(bullet.coexists?.length ? { coexists: [...bullet.coexists] } : {}),
    ...(bullet.pinned !== undefined ? { pinned: bullet.pinned } : {}),
    ...(previous?.trigger ? { trigger: previous.trigger } : paths?.length ? { trigger: { paths } } : {}),
    ...(previous?.provenance !== undefined ? { provenance: previous.provenance } : {}),
  }
  if (previous && canonical(next) !== canonical(previous)) next.updated = now
  return next
}
