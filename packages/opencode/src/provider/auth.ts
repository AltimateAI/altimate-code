import { LayerNode } from "@opencode-ai/core/effect/layer-node"
// altimate_change start — makeRuntime for restored Promise wrappers (see bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end
import type { AuthOAuthResult, Hooks } from "@opencode-ai/plugin"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Auth } from "@/auth"
import { InstanceState } from "@/effect/instance-state"
import { optional } from "@opencode-ai/core/schema"
import { Plugin } from "../plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Array as Arr, Effect, Layer, Record, Result, Context, Schema } from "effect"

const When = Schema.Struct({
  key: Schema.String,
  op: Schema.Literals(["eq", "neq"]),
  value: Schema.String,
})

const TextPrompt = Schema.Struct({
  type: Schema.Literal("text"),
  key: Schema.String,
  message: Schema.String,
  placeholder: optional(Schema.String),
  when: optional(When),
})

const SelectOption = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  hint: optional(Schema.String),
})

const SelectPrompt = Schema.Struct({
  type: Schema.Literal("select"),
  key: Schema.String,
  message: Schema.String,
  options: Schema.Array(SelectOption),
  when: optional(When),
})

const Prompt = Schema.Union([TextPrompt, SelectPrompt])

export class Method extends Schema.Class<Method>("ProviderAuthMethod")({
  type: Schema.Literals(["oauth", "api"]),
  label: Schema.String,
  prompts: optional(Schema.Array(Prompt)),
}) {}

export const Methods = Schema.Record(Schema.String, Schema.Array(Method))
export type Methods = typeof Methods.Type

export class Authorization extends Schema.Class<Authorization>("ProviderAuthAuthorization")({
  url: Schema.String,
  method: Schema.Literals(["auto", "code"]),
  instructions: Schema.String,
}) {}

export const AuthorizeInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({ description: "Prompt inputs" }),
})
export type AuthorizeInput = Schema.Schema.Type<typeof AuthorizeInput>

export const CallbackInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  code: Schema.optional(Schema.String).annotate({ description: "OAuth authorization code" }),
})
export type CallbackInput = Schema.Schema.Type<typeof CallbackInput>

export class OauthMissing extends Schema.TaggedErrorClass<OauthMissing>()("ProviderAuthOauthMissing", {
  providerID: ProviderV2.ID,
}) {}

export class OauthCodeMissing extends Schema.TaggedErrorClass<OauthCodeMissing>()("ProviderAuthOauthCodeMissing", {
  providerID: ProviderV2.ID,
}) {}

export class OauthCallbackFailed extends Schema.TaggedErrorClass<OauthCallbackFailed>()(
  "ProviderAuthOauthCallbackFailed",
  {},
) {}

export class ValidationFailed extends Schema.TaggedErrorClass<ValidationFailed>()("ProviderAuthValidationFailed", {
  field: Schema.String,
  message: Schema.String,
}) {}

export type Error = Auth.AuthError | OauthMissing | OauthCodeMissing | OauthCallbackFailed | ValidationFailed

type Hook = NonNullable<Hooks["auth"]>

// altimate_change start — upstream_fix: honor deprecated prompt condition on auth methods
type WhenRule = typeof When.Type
type MethodPrompt = NonNullable<Hook["methods"][number]["prompts"]>[number]

function whenMatches(when: WhenRule | undefined, inputs: Record<string, string>) {
  if (!when) return true
  const value = inputs[when.key]
  if (value === undefined) return false
  return when.op === "eq" ? value === when.value : value !== when.value
}

function promptApplies(prompt: MethodPrompt, inputs: Record<string, string>) {
  if (!whenMatches(prompt.when, inputs)) return false
  return prompt.condition ? prompt.condition(inputs) : true
}

function inferConditionWhen(prompts: readonly MethodPrompt[], prompt: MethodPrompt): WhenRule | undefined {
  if (prompt.when || !prompt.condition) return prompt.when

  for (const candidate of prompts) {
    if (candidate === prompt || candidate.type !== "select") continue

    const results = candidate.options.map((option) => {
      try {
        return {
          value: option.value,
          applies: prompt.condition!({ [candidate.key]: option.value }),
        }
      } catch {
        return {
          value: option.value,
          applies: false,
        }
      }
    })

    const matching = results.filter((result) => result.applies)
    if (matching.length === 1) {
      return { key: candidate.key, op: "eq", value: matching[0].value }
    }

    const hidden = results.filter((result) => !result.applies)
    if (hidden.length === 1 && matching.length > 0) {
      return { key: candidate.key, op: "neq", value: hidden[0].value }
    }
  }

  return undefined
}
// altimate_change end

export interface Interface {
  readonly methods: () => Effect.Effect<Methods>
  readonly authorize: (
    input: {
      providerID: ProviderV2.ID
    } & AuthorizeInput,
  ) => Effect.Effect<Authorization | undefined, Error>
  readonly callback: (input: { providerID: ProviderV2.ID } & CallbackInput) => Effect.Effect<void, Error>
}

interface State {
  hooks: Record<ProviderV2.ID, Hook>
  pending: Map<ProviderV2.ID, AuthOAuthResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderAuth") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, Auth.Service | Plugin.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("ProviderAuth.state")(function* () {
        const plugins = yield* plugin.list()
        return {
          hooks: Record.fromEntries(
            Arr.filterMap(plugins, (x) =>
              x.auth?.provider !== undefined
                ? Result.succeed([ProviderV2.ID.make(x.auth.provider), x.auth] as const)
                : Result.failVoid,
            ),
          ),
          pending: new Map<ProviderV2.ID, AuthOAuthResult>(),
        }
      }),
    )

    const decode = Schema.decodeUnknownSync(Methods)
    const methods = Effect.fn("ProviderAuth.methods")(function* () {
      const hooks = (yield* InstanceState.get(state)).hooks
      return decode(
        Record.map(hooks, (item) =>
          item.methods.map((method) => ({
            type: method.type,
            label: method.label,
            ...(method.prompts && {
              prompts: method.prompts.map((prompt) => {
                // altimate_change start — upstream_fix: map serializable auth condition to when
                const when = inferConditionWhen(method.prompts ?? [], prompt)
                // altimate_change end
                if (prompt.type === "select") {
                  return {
                    type: "select" as const,
                    key: prompt.key,
                    message: prompt.message,
                    options: prompt.options,
                    // altimate_change start — upstream_fix: carry inferred `when` onto select prompts
                    ...(when && { when }),
                    // altimate_change end
                  }
                }
                return {
                  type: "text" as const,
                  key: prompt.key,
                  message: prompt.message,
                  ...(prompt.placeholder && { placeholder: prompt.placeholder }),
                  // altimate_change start — upstream_fix: carry inferred `when` onto text prompts
                  ...(when && { when }),
                  // altimate_change end
                }
              }),
            }),
          })),
        ),
      )
    })

    const authorize = Effect.fn("ProviderAuth.authorize")(function* (
      input: { providerID: ProviderV2.ID } & AuthorizeInput,
    ) {
      const { hooks, pending } = yield* InstanceState.get(state)
      const method = hooks[input.providerID].methods[input.method]
      if (method.type !== "oauth") return

      if (method.prompts && input.inputs) {
        for (const prompt of method.prompts) {
          // altimate_change start — upstream_fix: skip validation for inactive conditional auth prompts
          if (!promptApplies(prompt, input.inputs)) continue
          // altimate_change end
          if (prompt.type === "text" && prompt.validate && input.inputs[prompt.key] !== undefined) {
            const error = prompt.validate(input.inputs[prompt.key])
            if (error) return yield* new ValidationFailed({ field: prompt.key, message: error })
          }
        }
      }

      const result = yield* Effect.promise(() => method.authorize(input.inputs))
      pending.set(input.providerID, result)
      return {
        url: result.url,
        method: result.method,
        instructions: result.instructions,
      }
    })

    const callback = Effect.fn("ProviderAuth.callback")(function* (
      input: { providerID: ProviderV2.ID } & CallbackInput,
    ) {
      const pending = (yield* InstanceState.get(state)).pending
      const match = pending.get(input.providerID)
      if (!match) return yield* new OauthMissing({ providerID: input.providerID })
      if (match.method === "code" && !input.code) {
        return yield* new OauthCodeMissing({ providerID: input.providerID })
      }

      const result = yield* Effect.promise(() =>
        match.method === "code" ? match.callback(input.code!) : match.callback(),
      )
      if (!result || result.type !== "success") return yield* new OauthCallbackFailed({})

      if ("key" in result) {
        yield* auth.set(input.providerID, {
          type: "api",
          key: result.key,
          ...(result.metadata ? { metadata: result.metadata } : {}),
        })
      }

      if ("refresh" in result) {
        const { type: _, provider: __, refresh, access, expires, ...extra } = result
        yield* auth.set(input.providerID, {
          type: "oauth",
          access,
          refresh,
          expires,
          ...extra,
        })
      }
    })

    return Service.of({ methods, authorize, callback })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provide(Auth.defaultLayer), Layer.provide(Plugin.defaultLayer)),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Auth.node, Plugin.node] })

// altimate_change start — restore imperative Promise wrappers for the HTTP route layer
// (server/routes/provider.ts) which the Effect-only migration dropped. ProviderV2.ID is a
// runtime-identity brand, so accepting a string providerID and re-branding is safe.
const { runPromise: runProviderAuth } = makeRuntime(Service, defaultLayer)
export async function methods() {
  return runProviderAuth((svc) => svc.methods())
}
export async function authorize(input: { providerID: string } & AuthorizeInput) {
  return runProviderAuth((svc) => svc.authorize({ ...input, providerID: ProviderV2.ID.make(input.providerID) }))
}
export async function callback(input: { providerID: string } & CallbackInput) {
  return runProviderAuth((svc) => svc.callback({ ...input, providerID: ProviderV2.ID.make(input.providerID) }))
}
// Persist an API-key credential for a provider. Restored after the Effect-only
// migration dropped it; delegates straight to Auth (the Service had no extra
// behavior beyond the auth.set above).
export async function api(input: { providerID: string; key: string }) {
  return Auth.set(input.providerID, { type: "api", key: input.key })
}
// altimate_change end

export * as ProviderAuth from "./auth"
