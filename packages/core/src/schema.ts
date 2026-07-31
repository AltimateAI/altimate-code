import { Schema } from "effect"
import {
  AbsolutePath,
  DateTimeUtcFromMillis,
  NonNegativeInt,
  optional,
  PositiveInt,
  RelativePath,
  statics,
} from "@opencode-ai/schema/schema"

export { AbsolutePath, DateTimeUtcFromMillis, NonNegativeInt, optional, PositiveInt, RelativePath, statics }

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

// altimate_change start — restore fork's `withStatics` helper. Upstream dropped it in favor of
// the shared package's `statics` (re-exported above), but several fork schemas (pty, permission,
// session, provider, project, control-plane) layer additional statics on top of already-`statics`'d
// core schemas via this exact name. Keep it distinct from `statics` (rather than aliasing) so the
// `@opencode-ai/core/schema` <-> `@opencode-ai/schema/schema` identity check in
// shared-schema.test.ts still holds.
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
    // Some fork schemas intentionally expose `make` as their public static and implement
    // it by delegating to `schema.make`. Passing the same object that Object.assign later
    // mutates makes those delegates self-recursive.
    const base = Object.create(Object.getPrototypeOf(schema))
    Object.defineProperties(base, Object.getOwnPropertyDescriptors(schema))
    return Object.assign(schema, methods(base as S))
  }
// altimate_change end

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
