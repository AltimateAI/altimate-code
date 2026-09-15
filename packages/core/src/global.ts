import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { LayerNode } from "./effect/layer-node"

// altimate_change start — app name (fork data dir; mirror packages/opencode/src/global/index.ts).
// The overlay merge reverted this to upstream's "opencode", splitting the fork's data
// across ~/.local/share/opencode (core-global consumers: auth, mcp-auth, providers, …) and
// ~/.local/share/altimate-code (fork-global consumers: traces, sessions, …). v0.8.10 put
// everything under altimate-code; keep all consumers unified there.
const app = "altimate-code"
// altimate_change end
const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)
const tmp = path.join(os.tmpdir(), app)

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  // altimate_change start — cubic review (3986917361): unlike `home` above, `state` was a plain
  // const with no test-isolation override, so any consumer reading `Global.Path.state` — or
  // `Flock`'s lock directory, which is derived from it (see the `Flock.setGlobal` call below) —
  // silently touched the REAL, current developer's state directory in tests. Mirror `home`'s
  // pattern: a getter honoring `OPENCODE_TEST_STATE_HOME`, read fresh on every access.
  get state() {
    return process.env.OPENCODE_TEST_STATE_HOME ?? state
  },
  // altimate_change end
  tmp,
}

export const Path = paths

// altimate_change start — cubic review (3986917361): `Flock.setGlobal` used to be given the
// frozen `state` const directly, snapshotted once at this module's import time — even after
// adding the `OPENCODE_TEST_STATE_HOME` override to `Path.state` above, `Flock`'s own internal
// lock-directory resolution would still have kept using whatever `state` was BEFORE any test set
// that env var (module imports happen once, before a test's own `beforeAll`/mount code runs). A
// getter-backed property here means `Flock`'s `root()` — which just reads `global.state` as a
// plain property — re-evaluates `Path.state` fresh on every lock acquisition instead, so setting
// `OPENCODE_TEST_STATE_HOME` redirects BOTH `Global.Path.state` reads and `Flock`'s lock root.
Flock.setGlobal({
  get state() {
    return Path.state
  },
})
// altimate_change end

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.OPENCODE_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer
export const node = LayerNode.make(layer, [])

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
