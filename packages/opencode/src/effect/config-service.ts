import { Config, ConfigProvider, Context, Effect, Layer } from "effect"
// altimate_change start — every OPENCODE_* variable is documented under an ALTIMATE_CLI_* name
import { documentedAlias } from "@opencode-ai/core/flag/flag"
// altimate_change end

type ConfigMap = Record<string, Config.Config<unknown>>

/**
 * The service shape inferred from an object of Effect `Config` definitions.
 */
export type Shape<Fields extends ConfigMap> = {
  readonly [Key in keyof Fields]: Config.Success<Fields[Key]>
}

/**
 * A Context service class with generated layers for config-backed services.
 */
export type ServiceClass<Self, Id extends string, Service> = Context.ServiceClass<Self, Id, Service> & {
  /** Provide already-parsed config, useful in tests. */
  readonly layer: (input: Service) => Layer.Layer<Self>
  /** Parse config once from the active Effect ConfigProvider and provide the service. */
  readonly defaultLayer: Layer.Layer<Self, Config.ConfigError>
}

/**
 * Create a Context service whose implementation is derived from Effect `Config`.
 *
 * This keeps Effect `Config` as the source of truth for env names, defaults, and
 * validation while generating a typed service plus convenient production/test
 * layers.
 *
 * ```ts
 * class ServerAuthConfig extends ConfigService.Service<ServerAuthConfig>()(
 *   "@opencode/ServerAuthConfig",
 *   {
 *     password: Config.string("OPENCODE_SERVER_PASSWORD").pipe(Config.option),
 *     username: Config.string("OPENCODE_SERVER_USERNAME").pipe(Config.withDefault("opencode")),
 *   },
 * ) {}
 *
 * const live = ServerAuthConfig.defaultLayer
 * const test = ServerAuthConfig.layer({ password: Option.some("secret"), username: "kit" })
 * ```
 */
export const Service =
  <Self>() =>
  <const Id extends string, const Fields extends ConfigMap>(id: Id, fields: Fields) => {
    class ConfigTag extends Context.Service<Self, Shape<Fields>>()(id) {
      static layer(input: Shape<Fields>) {
        return Layer.succeed(this, this.of(input))
      }

      static get defaultLayer() {
        const tag = this
        return Layer.effect(
          tag,
          Effect.gen(function* () {
            // altimate_change start — resolve the documented ALTIMATE_CLI_* name before the
            // OPENCODE_* one, whatever provider is active. Same rule as `flag.ts`'s `read`;
            // without it a documented name reached `Flag.*` but never a Config-backed field,
            // and `RuntimeFlags.disableExternalSkills` — the real skill-discovery gate — kept
            // ignoring `ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS` (#1329). Built with `make`
            // rather than `orElse`, whose fallback calls `get` and skips `mapInput`.
            const config = yield* Config.all(fields).pipe(
              Effect.provideServiceEffect(
                ConfigProvider.ConfigProvider,
                Effect.map(ConfigProvider.ConfigProvider, aliasDocumentedNames),
              ),
            )
            // altimate_change end
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Config.all preserves the field shape, but its conditional return type also supports iterable inputs.
            return tag.of(config as Shape<Fields>)
          }),
        )
      }
    }

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The generated class carries typed static helpers.
    return ConfigTag as ServiceClass<Self, Id, Shape<Fields>>
  }

export * as ConfigService from "./config-service"

// altimate_change start — see `defaultLayer`
/** A provider that tries the documented `ALTIMATE_CLI_*` spelling of an `OPENCODE_*` path
 * first and falls back to the path as written. An empty documented value counts as unset. */
export function aliasDocumentedNames(provider: ConfigProvider.ConfigProvider): ConfigProvider.ConfigProvider {
  return ConfigProvider.make((path) => {
    const head = path[0]
    const alias = typeof head === "string" ? documentedAlias(head) : undefined
    if (alias === undefined) return provider.load(path)
    return Effect.flatMap(provider.load([alias, ...path.slice(1)]), (node) =>
      node && !(node._tag === "Value" && node.value === "") ? Effect.succeed(node) : provider.load(path),
    )
  })
}
// altimate_change end
