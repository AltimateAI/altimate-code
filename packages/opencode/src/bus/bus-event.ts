import z from "zod"
import type { ZodType } from "zod"

export namespace BusEvent {
  export type Definition = ReturnType<typeof define>

  const registry = new Map<string, Definition>()

  // altimate_change start — private event definitions are excluded from wildcard transport
  export function define<Type extends string, Properties extends ZodType>(
    type: Type,
    properties: Properties,
    options?: { private?: boolean },
  ) {
    // altimate_change start — make idempotent so SyncEvent.define (cycle 3 bridge) and
    // SyncEvent.init can both safely call this without duplicate-registration concerns.
    // First registration wins to keep schema stable across re-imports/test resets.
    const existing = registry.get(type) as { type: Type; properties: Properties; private?: boolean } | undefined
    if (existing) return existing
    // altimate_change end
    const result = {
      type,
      properties,
      // altimate_change start — sensitive events require an explicit typed subscription
      private: options?.private,
      // altimate_change end
    }
    registry.set(type, result)
    return result
  }

  // altimate_change end

  export function payloads() {
    return z
      .discriminatedUnion(
        "type",
        registry
          .entries()
          // altimate_change start — private events are absent from public SSE schemas
          .filter(([, def]) => !def.private)
          // altimate_change end
          .map(([type, def]) => {
            return z
              .object({
                type: z.literal(type),
                properties: def.properties,
              })
              .meta({
                ref: "Event" + "." + def.type,
              })
          })
          .toArray() as any,
      )
      .meta({
        ref: "Event",
      })
  }
}
