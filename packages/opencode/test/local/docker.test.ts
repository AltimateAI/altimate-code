import { describe, expect, test } from "bun:test"

import { buildDockerRunArgs, LOCAL_CONTAINER_NAME } from "../../src/local/docker"
import { BUNDLED_RECIPES } from "../../src/local/recipes"

const model = BUNDLED_RECIPES.models[0]!
const tier = model.tiers.find((entry) => entry.name === "dgx-spark-128gb")!

describe("buildDockerRunArgs", () => {
  test("pins the image by digest and binds only to loopback", () => {
    if (tier.engine !== "docker-sglang") throw new Error("dgx tier must be docker-sglang")
    const args = buildDockerRunArgs({ tier, modelID: model.id, port: 8095, hfCache: "/home/user/.cache/huggingface" })
    expect(args).toContain(`${tier.image}@${tier.image_digest}`)
    expect(args).toContain(`127.0.0.1:8095:${tier.container_port}`)
    expect(args).toContain(LOCAL_CONTAINER_NAME)
    expect(args.join(" ")).toContain(`--model-path ${tier.model_hf}`)
    expect(args.join(" ")).toContain(`--served-model-name ${model.id}`)
    expect(args.join(" ")).toContain(`--context-length ${tier.ctx}`)
    // EAGLE speculative args come from the recipe, not hardcoded
    expect(args).toContain("--speculative-algorithm")
  })

  test("bundled dgx tier is a valid docker recipe", () => {
    expect(tier.engine).toBe("docker-sglang")
    if (tier.engine !== "docker-sglang") return
    expect(tier.image_digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(tier.ctx).toBe(131072)
    expect(tier.agent.reasoning_effort).toBe("medium")
  })
})
