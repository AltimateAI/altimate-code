import { describe, test, expect } from "bun:test"
import { z } from "zod"
import { fn } from "../../src/util/fn"

describe("fn: zod-validated function wrapper", () => {
  test("passes validated input to callback", () => {
    const add = fn(z.object({ a: z.number(), b: z.number() }), ({ a, b }) => a + b)
    expect(add({ a: 1, b: 2 })).toBe(3)
  })

  test("throws ZodError on invalid input", () => {
    const greet = fn(z.object({ name: z.string() }), ({ name }) => `hi ${name}`)
    expect(() => greet({ name: 42 } as any)).toThrow()
  })

  test(".force() bypasses validation", () => {
    const double = fn(z.number().int(), (n) => n * 2)
    // 1.5 is not an int, but .force skips validation
    expect(double.force(1.5)).toBe(3)
  })

  test(".schema exposes the original zod schema", () => {
    const schema = z.string().email()
    const validate = fn(schema, (s) => s.toUpperCase())
    expect(validate.schema).toBe(schema)
  })

  test("rejects unknown keys with strict schema", () => {
    const strict = fn(z.object({ id: z.number() }).strict(), ({ id }) => id)
    expect(() => strict({ id: 1, extra: true } as any)).toThrow()
  })
})
