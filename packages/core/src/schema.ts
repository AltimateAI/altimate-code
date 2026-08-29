import { Option, Schema, SchemaGetter } from "effect"
import { Hash } from "./util/hash"

export type ExternalID = {
  readonly namespace: string
  readonly key: string
}

export const externalID = (prefix: string, input: ExternalID) =>
  `${prefix}_${Hash.sha256(JSON.stringify([input.namespace, input.key]))}`

/**
 * Integer greater than zero.
 */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * Integer greater than or equal to zero.
 */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

// altimate_change start — float32-exact lower bound for the compaction
// safety fraction.
//
// `Schema.toArbitrary`'s fast-check generator requires `.check()` bounds to be
// exact 32-bit floats, and 0.1 is not float32-representable. Rounding UP to the
// nearest float32 (`Math.fround(0.1)` ≈ 0.10000000149) makes the schema reject
// the documented minimum `0.1`, so the bound has to round DOWN instead. This is
// the nearest float32 strictly below 0.1 (~1.3e-8 under), which satisfies the
// generator and still accepts the advertised lower endpoint.
export const SAFETY_FRACTION_MIN = Math.fround(0.1 - 1e-8)
// altimate_change end

/**
 * Relative file path (e.g., `src/components/Button.tsx`).
 */
export const RelativePath = Schema.String.pipe(Schema.brand("RelativePath"))
export type RelativePath = Schema.Schema.Type<typeof RelativePath>

/**
 * Absolute file path (e.g., `/home/user/projects/myapp/src/main.ts`).
 */
export const AbsolutePath = Schema.String.pipe(Schema.brand("AbsolutePath"))
export type AbsolutePath = Schema.Schema.Type<typeof AbsolutePath>

/**
 * Optional public JSON field that can hold explicit `undefined` on the type
 * side but encodes it as an omitted key, matching legacy `JSON.stringify`.
 */
export const optionalOmitUndefined = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema).pipe(
    Schema.decodeTo(Schema.optional(schema), {
      decode: SchemaGetter.passthrough({ strict: false }),
      encode: SchemaGetter.transformOptional(Option.filter((value) => value !== undefined)),
    }),
  )

/**
 * Strip `readonly` from a nested type. Stand-in for `effect`'s `Types.DeepMutable`
 * until `effect:core/x228my` ("Types.DeepMutable widens unknown to `{}`") lands.
 *
 * The upstream version falls through `unknown` into `{ -readonly [K in keyof T]: ... }`
 * where `keyof unknown = never`, so `unknown` collapses to `{}`. This local
 * version gates the object branch on `extends object` (which `unknown` does
 * not) so `unknown` passes through untouched.
 *
 * Primitive bailout matches upstream — without it, branded strings like
 * `string & Brand<"SessionID">` fall into the object branch and get their
 * prototype methods walked.
 *
 * Tuple branch preserves readonly tuples (e.g. `ConfigPlugin.Spec`'s
 * `readonly [string, Options]`); the general array branch would otherwise
 * widen them to unbounded arrays.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type DeepMutable<T> = T extends string | number | boolean | bigint | symbol | Function
  ? T
  : T extends readonly [unknown, ...unknown[]]
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T extends readonly (infer U)[]
      ? DeepMutable<U>[]
      : T extends object
        ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
        : T

/**
 * Attach static methods to a schema object. Designed to be used with `.pipe()`:
 *
 * @example
 *   export const Foo = fooSchema.pipe(
 *     withStatics((schema) => ({
 *       zero: schema.make(0),
 *       from: Schema.decodeUnknownOption(schema),
 *     }))
 *   )
 */
export const withStatics =
  <S extends object, M extends Record<string, unknown>>(methods: (schema: S) => M) =>
  (schema: S): S & M => {
    // altimate_change start — pass statics a stable view of the pre-augmented schema.
    // Some fork schemas intentionally expose `make` as their public static and implement
    // it by delegating to `schema.make`. Passing the same object that Object.assign later
    // mutates makes those delegates self-recursive.
    const base = Object.create(Object.getPrototypeOf(schema))
    Object.defineProperties(base, Object.getOwnPropertyDescriptors(schema))
    return Object.assign(schema, methods(base as S))
    // altimate_change end
  }

/**
 * Nominal wrapper for scalar types. The class itself is a valid schema —
 * pass it directly to `Schema.decode`, `Schema.decodeEffect`, etc.
 *
 * Overrides `~type.make` on the derived `Schema.Opaque` so `Schema.Schema.Type`
 * of a field using this newtype resolves to `Self` rather than the underlying
 * branded phantom. Without that override, passing a class instance to code
 * typed against `Schema.Schema.Type<FieldSchema>` would require a cast even
 * though the values are structurally equivalent at runtime.
 *
 * @example
 *   class QuestionID extends Newtype<QuestionID>()("QuestionID", Schema.String) {
 *     static make(id: string): QuestionID {
 *       return this.make(id)
 *     }
 *   }
 *
 *   Schema.decodeEffect(QuestionID)(input)
 */
export function Newtype<Self>() {
  return <const Tag extends string, S extends Schema.Top>(tag: Tag, schema: S) => {
    abstract class Base {
      declare readonly _newtype: Tag

      static make(value: Schema.Schema.Type<S>): Self {
        return value as unknown as Self
      }
    }

    Object.setPrototypeOf(Base, schema)

    return Base as unknown as (abstract new (_: never) => { readonly _newtype: Tag }) & {
      readonly make: (value: Schema.Schema.Type<S>) => Self
    } & Omit<Schema.Opaque<Self, S, {}>, "make" | "~type.make"> & {
        readonly "~type.make": Self
      }
  }
}
