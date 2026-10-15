// altimate: ALT-F01
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { defaults, Identity, resolveIdentity } from "../src/identity.js"

const altimate = await Bun.file(path.resolve(import.meta.dir, "../../altimate/identity.json")).json()

describe("host identity", () => {
  test("unmodified source retains upstream defaults", () => {
    expect(Identity).toBe(defaults)
    expect(defaults).toEqual({
      app: "opencode",
      displayName: "OpenCode",
      userAgent: "opencode",
      envPrefixes: ["OPENCODE_"],
      configBasenames: ["opencode"],
      servicePort: 0xc0de,
      serviceName: "opencode",
      title: { home: "OpenCode", prefix: "OC" },
      logo: {
        left: ["                   ", "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", "█__█ █__█ █^^^ █__█", "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"],
        right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
      },
      narrowLogo: {
        left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
        right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
      },
    })
  })

  test("validates the descriptor at the build boundary", () => {
    expect(resolveIdentity(altimate)).toEqual(altimate)
    expect(() => resolveIdentity({ ...altimate, servicePort: 65_535 })).toThrow("servicePort")
    expect(() => resolveIdentity({ ...altimate, envPrefixes: [] })).toThrow("envPrefixes")
    expect(() => resolveIdentity({ ...altimate, logo: { left: ["x"], right: [] } })).toThrow("logo")
    // altimate: ALT-F02
    expect(() => resolveIdentity({ ...altimate, hostPlugins: "" })).toThrow("hostPlugins")
    expect(() => resolveIdentity({ ...altimate, hostPlugins: 42 })).toThrow("hostPlugins")
  })

  for (const branded of [false, true]) {
    test(`${branded ? "Altimate" : "upstream"} initializes actual roots, tmp and user agent before use`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-"))
      const app = branded ? "altimate-code" : "opencode"
      try {
        const result = Bun.spawnSync({
          cmd: [
            process.execPath,
            ...(branded
              ? ["--preload", path.resolve(import.meta.dir, "../../altimate/script/identity-preload.ts")]
              : []),
            "-e",
            `
              import { Context, Effect, Layer } from "effect"
              const { Identity } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../src/identity.ts")).href)})
              const { Global } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../src/global.ts")).href)})
              const { App } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../../core/src/app.ts")).href)})
              const context = await Effect.runPromise(Effect.scoped(Layer.build(Global.layerWith({}))))
              console.log(JSON.stringify({
                paths: Context.get(context, Global.Service),
                userAgent: App.useragent(App.make({ version: "2.0.29", channel: "dev" })),
                basenames: Identity.configBasenames,
              }))
            `,
          ],
          cwd: path.resolve(import.meta.dir, ".."),
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_STATE_HOME: path.join(root, "state"),
            TMPDIR: path.join(root, "tmp"),
            OPENCODE_TEST_HOME: undefined,
            ALTIMATE_CLI_TEST_HOME: undefined,
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        const value = JSON.parse(result.stdout.toString())
        for (const key of ["data", "cache", "config", "state"]) {
          expect(value.paths[key]).toBe(path.join(root, key, app))
          expect(fs.existsSync(value.paths[key])).toBe(true)
          if (branded) expect(fs.existsSync(path.join(root, key, "opencode"))).toBe(false)
        }
        expect(value.paths.tmp).toBe(fs.realpathSync(path.join(root, "tmp", app)))
        expect(value.userAgent).toBe(`${app}/dev/2.0.29/${app}`)
        expect(value.basenames).toEqual(branded ? ["altimate-code", "opencode"] : ["opencode"])
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
