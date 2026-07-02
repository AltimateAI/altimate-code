import { afterEach, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { ProviderAuth } from "../../src/provider/auth"
import { ProviderID } from "../../src/provider/schema"
import { Plugin } from "../../src/plugin/index"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Auth.remove("test-provider-auth")
})

test("ProviderAuth.api persists auth via AuthService", async () => {
  await ProviderAuth.api({
    providerID: ProviderID.make("test-provider-auth"),
    key: "sk-test",
  })

  expect(await Auth.get("test-provider-auth")).toEqual({
    type: "api",
    key: "sk-test",
  })
})

const copilotConditionHook: Hooks = {
  auth: {
    provider: "github-copilot",
    methods: [
      {
        type: "oauth",
        label: "Login with GitHub Copilot",
        prompts: [
          {
            type: "select",
            key: "deploymentType",
            message: "Select GitHub deployment type",
            options: [
              { label: "GitHub.com", value: "github.com", hint: "Public" },
              { label: "GitHub Enterprise", value: "enterprise", hint: "Data residency or self-hosted" },
            ],
          },
          {
            type: "text",
            key: "enterpriseUrl",
            message: "Enter your GitHub Enterprise URL or domain",
            placeholder: "company.ghe.com or https://company.ghe.com",
            condition: (inputs) => inputs.deploymentType === "enterprise",
            validate: (value) => (value ? undefined : "URL or domain is required"),
          },
        ],
        async authorize() {
          return {
            url: "https://github.com/login/device",
            method: "auto" as const,
            instructions: "Enter code: TEST",
            async callback() {
              return { type: "failed" as const }
            },
          }
        },
      },
    ],
  },
}

const providerAuthIt = testEffect(
  ProviderAuth.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(
      Layer.mock(Plugin.Service)({
        trigger: <Name extends string, Input, Output>(_name: Name, _input: Input, output: Output) =>
          Effect.succeed(output),
        list: () => Effect.succeed([copilotConditionHook]),
        init: () => Effect.void,
      }),
    ),
  ),
)

providerAuthIt.instance("ProviderAuth.methods maps Copilot condition prompts to serializable when rules", () =>
  Effect.gen(function* () {
    const svc = yield* ProviderAuth.Service
    const methods = yield* svc.methods()
    const prompt = methods["github-copilot"]?.[0]?.prompts?.[1]

    expect(prompt).toMatchObject({
      type: "text",
      key: "enterpriseUrl",
      when: { key: "deploymentType", op: "eq", value: "enterprise" },
    })
  }),
)

providerAuthIt.instance("ProviderAuth.authorize skips validation for inactive condition prompts", () =>
  Effect.gen(function* () {
    const svc = yield* ProviderAuth.Service
    const auth = yield* svc.authorize({
      providerID: ProviderV2.ID.make("github-copilot"),
      method: 0,
      inputs: {
        deploymentType: "github.com",
        enterpriseUrl: "",
      },
    })

    expect(auth).toEqual({
      url: "https://github.com/login/device",
      method: "auto",
      instructions: "Enter code: TEST",
    })
  }),
)
