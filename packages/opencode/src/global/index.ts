import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"
import { Filesystem } from "../util/filesystem"

// altimate_change start - app name
const app = "altimate-code"
// altimate_change end

const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)

export namespace Global {
  export const Path = {
    // Allow override via OPENCODE_TEST_HOME for test isolation
    get home() {
      return process.env.OPENCODE_TEST_HOME || os.homedir()
    },
    data,
    bin: path.join(data, "bin"),
    log: path.join(data, "log"),
    cache,
    config,
    // altimate_change start — cubic review round 5, P2: unlike `home` above, `state` was a
    // plain module-load-time const with no test-isolation override, so any test reading or
    // writing through `Global.Path.state` (recent-model / migration-decline persistence in
    // `model.json`) was silently touching the REAL, current developer's state directory —
    // racing any other test file doing the same thing in parallel, and risking clobbering real
    // state if a test run were killed mid-write. Mirror `home`'s pattern with its own getter and
    // env var so `Global.Path.state` can be redirected to a throwaway temp dir per test (see
    // `test/fixture/fixture.ts`'s `withTestStateHome`), without changing production behavior —
    // the getter is evaluated fresh on every access, and the env var is unset outside tests.
    get state() {
      return process.env.OPENCODE_TEST_STATE_HOME ?? state
    },
    // altimate_change end
  }
}

await Promise.all([
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
])

const CACHE_VERSION = "21"

const version = await Filesystem.readText(path.join(Global.Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Filesystem.write(path.join(Global.Path.cache, "version"), CACHE_VERSION)
}
