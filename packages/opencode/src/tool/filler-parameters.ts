import type { JSONSchema7 } from "@ai-sdk/provider"
import { Schema, SchemaGetter } from "effect"

const normalized = new WeakSet<Schema.Top>()

/** Normalize only optional tool arguments; required values and nested payloads retain their meaning. */
export function fillerSafeParameters<T>(parameters: Schema.Decoder<T>, jsonSchema: JSONSchema7): Schema.Decoder<T> {
  // Legacy tools may publish a simpler wire schema than their validation schema.
  if (normalized.has(parameters)) return parameters
  const result = Schema.Unknown.pipe(
    Schema.decodeTo(parameters, {
      decode: SchemaGetter.transform((input) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) return input
        const args = input as Record<string, unknown>
        const properties = new Set<string>()
        const required = new Set<string>()
        const collect = (schema: JSONSchema7 | boolean) => {
          if (typeof schema === "boolean") return
          for (const name of Object.keys(schema.properties ?? {})) properties.add(name)
          for (const name of schema.required ?? []) required.add(name)
          for (const child of schema.allOf ?? []) collect(child)
          for (const child of schema.anyOf ?? schema.oneOf ?? []) {
            // Literal discriminants determine which arguments are required for this call.
            if (
              typeof child !== "boolean" &&
              Object.entries(child.properties ?? {}).some(
                ([key, field]) =>
                  typeof field !== "boolean" &&
                  child.required?.includes(key) &&
                  key in args &&
                  ((field.const !== undefined && field.const !== args[key]) ||
                    (field.enum !== undefined && !field.enum.includes(args[key] as never))),
              )
            )
              continue
            collect(child)
          }
        }
        collect(jsonSchema)
        return Object.fromEntries(
          Object.entries(args).filter(
            ([key, value]) =>
              !properties.has(key) ||
              required.has(key) ||
              !(value === null || value === "" || value === 0 || (Array.isArray(value) && value.length === 0)),
          ),
        )
      }),
      encode: SchemaGetter.transform((value) => value),
    }),
  )
  normalized.add(result)
  return result
}
