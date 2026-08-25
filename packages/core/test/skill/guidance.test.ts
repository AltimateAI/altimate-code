import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { it } from "../lib/effect"

const build = AgentV2.ID.make("build")
const effect = new SkillV2.Info({
  name: "effect",
  description: "Build applications with Effect",
  location: AbsolutePath.make(path.resolve("/skills/effect/SKILL.md")),
  content: "Effect guidance",
})
const hidden = new SkillV2.Info({
  name: "hidden",
  location: AbsolutePath.make(path.resolve("/skills/hidden/SKILL.md")),
  content: "Undescribed guidance",
})
const denied = new SkillV2.Info({
  name: "denied",
  description: "Must not be advertised",
  location: AbsolutePath.make(path.resolve("/skills/denied/SKILL.md")),
  content: "Denied guidance",
})

const layer = (list: () => SkillV2.Info[], wait: () => void = () => {}) =>
  SkillGuidance.layer.pipe(
    Layer.provide(Layer.mock(SkillV2.Service, { list: () => Effect.succeed(list()) })),
    Layer.provide(Layer.mock(PluginBoot.Service, { wait: () => Effect.sync(wait) })),
  )

describe("SkillGuidance", () => {
  it.effect("renders described agent skills and reconciles the complete available list", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "denied", effect: "deny" }],
    })
    let skills = [hidden, denied, effect]
    let waited = 0
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const initialized = yield* guidance
        .load({ id: agent.id, info: agent })
        .pipe(Effect.flatMap(SystemContext.initialize))

      expect(waited).toBe(1)
      expect(initialized.baseline).toBe(
        [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          "<available_skills>",
          "  <skill>",
          "    <name>effect</name>",
          "    <description>Build applications with Effect</description>",
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
      )

      skills = []
      expect(
        yield* guidance
          .load({ id: agent.id, info: agent })
          .pipe(Effect.flatMap((context) => SystemContext.reconcile(context, initialized.snapshot))),
      ).toMatchObject({
        _tag: "Updated",
        text: expect.stringContaining("No skills are currently available."),
      })
    }).pipe(
      Effect.provide(
        layer(
          () => skills,
          () => waited++,
        ),
      ),
    )
  })

  it.effect("omits guidance when the selected agent denies all skills", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits guidance when a resource-specific denial follows the global denial", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "hidden", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("retains specifically allowed skills after a global denial", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        (yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))).baseline,
      ).toContain("<name>effect</name>")
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits guidance when a specifically allowed skill is denied again", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
        { action: "skill", resource: "effect", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })
})

// altimate_change start — ordering here must be machine-independent AND representation-stable.
//
// This list renders into the core session runner's system context, and exact-prefix caches stop
// at the first differing byte, so two machines emitting different bytes share no prefix.
//
// Two distinct hazards, and the previous test caught neither: it asserted the OPENCODE
// SystemPrompt sort, a different implementation, so reverting THIS comparator left it green.
//
//   locale     `localeCompare` without an explicit locale follows the runtime's LANG/ICU data
//   surrogates `<` compares UTF-16 code UNITS. Astral characters are stored as surrogate pairs
//              in 0xD800-0xDFFF, BELOW the private-use area at 0xE000, so `"\u{10000}" < ""`
//              is true by code unit and false by Unicode scalar value.
describe("SkillGuidance ordering", () => {
  const named = (name: string) =>
    new SkillV2.Info({
      name,
      description: `desc ${name}`,
      location: AbsolutePath.make(path.resolve(`/skills/x/SKILL.md`)),
      content: "c",
    })

  const namesFrom = (text: string) => [...text.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1])

  it.effect("orders by Unicode code point, not locale and not UTF-16 code unit", () => {
    const agent = new AgentV2.Info({ ...AgentV2.Info.empty(build) })
    // "sort-a" vs "sort_a": ICU puts the underscore first, code point puts the hyphen first
    // (0x2D < 0x5F) — catches a revert to localeCompare.
    // "" (PUA) vs "\u{10000}" (astral): code point puts PUA first, UTF-16 code units put
    // the astral pair first because its surrogates are 0xD800-0xDBFF — catches a revert to `<`.
    const skills = [named("\u{10000}zz"), named("sort_a"), named("aa"), named("sort-a")]
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const initialized = yield* guidance
        .load({ id: agent.id, info: agent })
        .pipe(Effect.flatMap(SystemContext.initialize))

      const names = namesFrom(initialized.baseline)
      expect(names).toEqual(["sort-a", "sort_a", "aa", "\u{10000}zz"])

      // Guards against the fixtures going vacuous if either assumption ever stops holding.
      expect("sort-a".localeCompare("sort_a")).toBeGreaterThan(0)
      expect("\u{10000}zz" < "aa").toBe(true)
    }).pipe(Effect.provide(layer(() => skills)))
  })
})
// altimate_change end
