/**
 * The `dbt_fault_injection` agent tool is registered only when the installed engine
 * provides `FaultInjectionSession`; the plain command keeps its own clear error
 * (see fault-injection-driver.test.ts).
 *
 * The two cases use the real loader: pointing ALTIMATE_CORE_DEV_PATH at a directory that
 * holds no engine makes the engine unavailable, and the availability cache is reset around
 * each case so nothing leaks into other tests.
 */

import { afterEach, describe, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import {
  CORE_DEV_PATH_ENV,
  isFaultInjectionEngineAvailable,
  resetFaultInjectionEngineAvailability,
} from "../../src/altimate/native/connections/fault-injection"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})
const it = testEffect(
  LayerNode.buildLayer(LayerNode.group([ToolRegistry.node, Agent.node]), {
    replacements: [
      LayerNode.replace(Config.node, configLayer),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
    ],
  }),
)

const savedDevPath = process.env[CORE_DEV_PATH_ENV]
afterEach(async () => {
  if (savedDevPath === undefined) delete process.env[CORE_DEV_PATH_ENV]
  else process.env[CORE_DEV_PATH_ENV] = savedDevPath
  resetFaultInjectionEngineAvailability()
  await disposeAllInstances()
})

/** Run `body` with the engine made unavailable by pointing the dev override at an empty directory. */
function withoutEngine<A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "fi-no-engine-"))
    process.env[CORE_DEV_PATH_ENV] = empty
    resetFaultInjectionEngineAvailability()
    return yield* body
  })
}

describe("dbt_fault_injection registration", () => {
  it.instance("is not offered when the installed engine has no fault-injection class", () =>
    withoutEngine(
      Effect.gen(function* () {
        expect(yield* Effect.promise(() => isFaultInjectionEngineAvailable())).toBe(false)
        const ids = yield* (yield* ToolRegistry.Service).ids()
        expect(ids).not.toContain("dbt_fault_injection")
        // The rest of the registry is unaffected.
        expect(ids).toContain("sql_execute")
      }),
    ),
  )

  it.instance("is offered to the agent when the engine provides FaultInjectionSession", () =>
    Effect.gen(function* () {
      // Needs a build of the engine that exports the class (ALTIMATE_CORE_DEV_PATH or a new enough package).
      resetFaultInjectionEngineAvailability()
      const available = yield* Effect.promise(() => isFaultInjectionEngineAvailable())
      const ids = yield* (yield* ToolRegistry.Service).ids()
      expect(ids.includes("dbt_fault_injection")).toBe(available)
      if (process.env[CORE_DEV_PATH_ENV]) expect(available).toBe(true)
    }),
  )
})
