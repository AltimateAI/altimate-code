import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Skill } from "../../src/skill"
import { Discovery } from "../../src/skill/discovery"
import { TestInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer))
const markdown = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} description.\n---\n\n${body}\n`
const embedded = [
  { name: "existing-directory", content: markdown("existing-skill", "Embedded existing instructions.") },
  { name: "new-directory", content: markdown("new-skill", "New embedded instructions.") },
]
const globals = globalThis as typeof globalThis & { OPENCODE_BUILTIN_SKILLS?: typeof embedded }
let previous: PropertyDescriptor | undefined

beforeEach(() => {
  previous = Object.getOwnPropertyDescriptor(globals, "OPENCODE_BUILTIN_SKILLS")
  globals.OPENCODE_BUILTIN_SKILLS = embedded
})

afterEach(() => {
  if (previous) Object.defineProperty(globals, "OPENCODE_BUILTIN_SKILLS", previous)
  else delete globals.OPENCODE_BUILTIN_SKILLS
})

function fixture(disableExternalSkills = false) {
  return Effect.gen(function* () {
    // Give the builtin installer and external discovery their own empty home,
    // separate from both the project and the test process's shared data root.
    const home = yield* tmpdirScoped()
    const layer = Skill.layer.pipe(
      Layer.provide(Discovery.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Global.layerWith({ home })),
      Layer.provide(RuntimeFlags.layer({ disableExternalSkills })),
    )
    return { home, layer }
  })
}

describe("builtin skill discovery", () => {
  it.instance("loads all embedded skills with a clean user-data root", () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture()
      const skills = yield* Skill.Service.use((skill) => skill.all()).pipe(Effect.provide(layer))

      expect(skills.map((skill) => skill.name).sort()).toEqual(["customize-opencode", "existing-skill", "new-skill"])
      for (const entry of embedded) {
        const name = entry.name === "existing-directory" ? "existing-skill" : "new-skill"
        expect(skills.find((skill) => skill.name === name)).toMatchObject({
          name,
          description: `${name} description.`,
          location: `builtin:${entry.name}/SKILL.md`,
          source: "built-in",
        })
      }
      expect(skills.find((skill) => skill.name === "new-skill")?.content).toContain("New embedded instructions.")
    }),
  )

  it.instance("merges a partial install with embedded skills while retaining same-name disk overrides", () =>
    Effect.gen(function* () {
      const { home, layer } = yield* fixture()
      const installed = path.join(home, ".altimate", "builtin", "old-directory", "SKILL.md")
      yield* Effect.promise(() => Bun.write(installed, markdown("existing-skill", "Installed override instructions.")))
      yield* Effect.promise(() =>
        Bun.write(path.join(home, ".altimate", "builtin", "disk-only", "SKILL.md"), markdown("disk-only", "Disk only.")),
      )
      const skills = yield* Skill.Service.use((skill) => skill.all()).pipe(Effect.provide(layer))

      expect(skills.map((skill) => skill.name).sort()).toEqual([
        "customize-opencode",
        "disk-only",
        "existing-skill",
        "new-skill",
      ])
      expect(skills.find((skill) => skill.name === "existing-skill")).toMatchObject({
        content: "\nInstalled override instructions.\n",
        location: installed,
        source: "built-in",
      })
      expect(skills.find((skill) => skill.name === "new-skill")).toMatchObject({
        location: "builtin:new-directory/SKILL.md",
        source: "built-in",
      })
    }),
  )

  it.instance("lets same-name project skills override installed and embedded builtins", () =>
    Effect.gen(function* () {
      const { home, layer } = yield* fixture()
      const { directory } = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(
          path.join(home, ".altimate", "builtin", "old-directory", "SKILL.md"),
          markdown("existing-skill", "Installed instructions."),
        ),
      )
      for (const name of ["existing-skill", "new-skill"]) {
        yield* Effect.promise(() =>
          Bun.write(path.join(directory, ".opencode", "skills", name, "SKILL.md"), markdown(name, "Project instructions.")),
        )
      }
      const skills = yield* Skill.Service.use((skill) => skill.all()).pipe(Effect.provide(layer))

      for (const name of ["existing-skill", "new-skill"]) {
        expect(skills.find((skill) => skill.name === name)).toMatchObject({
          content: "\nProject instructions.\n",
          location: path.join(directory, ".opencode", "skills", name, "SKILL.md"),
          source: "project",
        })
      }
    }),
  )

  it.instance("keeps installed and embedded builtins when external discovery is disabled", () =>
    Effect.gen(function* () {
      const { home, layer } = yield* fixture(true)
      const { directory } = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(
          path.join(home, ".altimate", "builtin", "old-directory", "SKILL.md"),
          markdown("existing-skill", "Installed instructions."),
        ),
      )
      for (const root of [home, directory]) {
        yield* Effect.promise(() =>
          Bun.write(path.join(root, ".claude", "skills", "external", "SKILL.md"), markdown("external", "External.")),
        )
      }
      const skills = yield* Skill.Service.use((skill) => skill.all()).pipe(Effect.provide(layer))

      expect(skills.map((skill) => skill.name).sort()).toEqual(["customize-opencode", "existing-skill", "new-skill"])
      expect(skills.every((skill) => skill.source === "built-in")).toBe(true)
      expect(skills.find((skill) => skill.name === "existing-skill")?.location).toStartWith(home)
      expect(skills.find((skill) => skill.name === "new-skill")?.location).toBe("builtin:new-directory/SKILL.md")
    }),
  )
})
