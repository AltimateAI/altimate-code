// Shared hermetic-test bootstrap for the Altimate Base e2e suites.
//
// Extracted from `test/altimate/altimate-base.test.ts`'s top-of-file isolated-environment
// pattern so every new suite (and that file) imports one implementation instead of
// re-copy-pasting it. See docs/internal/2026-09-04-altimate-base-e2e-harness-plan.md,
// Deliverable 2, for the full design rationale.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll } from "bun:test"

const ISOLATED_ENV = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_TEST_HOME",
] as const

/**
 * Call once at module scope in each suite file, BEFORE importing `../../src/altimate/free/*`
 * (the client reads Global.Path lazily per-call, but isolating env before any import keeps every
 * suite file identical to how the existing altimate-base.test.ts already does it).
 *
 * Gives the file its own temp XDG/home tree so its credential store, config, and cache never
 * touch a real user directory or another suite file's directory. Registers an `afterAll` that
 * restores the previous env values and removes the temp tree.
 */
export function isolateAltimateBaseHome(prefix: string): string {
  const original = Object.fromEntries(ISOLATED_ENV.map((key) => [key, process.env[key]]))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  process.env.XDG_DATA_HOME = path.join(home, "data")
  process.env.XDG_CONFIG_HOME = path.join(home, "config")
  process.env.XDG_CACHE_HOME = path.join(home, "cache")
  process.env.XDG_STATE_HOME = path.join(home, "state")
  process.env.OPENCODE_TEST_HOME = home

  afterAll(() => {
    for (const key of ISOLATED_ENV) {
      const value = original[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

/**
 * Call in `beforeEach`: clears both current and legacy gateway env vars, then points the client
 * at the fake gateway's URL. Mirrors `altimate-base.test.ts`'s existing `beforeEach` gateway-env
 * reset so every suite starts from the same known configuration state.
 */
export function resetGatewayEnv(gatewayUrl: string): void {
  delete process.env.ALTIMATE_BASE_GATEWAY_URL
  delete process.env.ALTIMATE_FREE_GATEWAY_URL
  process.env.ALTIMATE_BASE_GATEWAY_URL = gatewayUrl
}
