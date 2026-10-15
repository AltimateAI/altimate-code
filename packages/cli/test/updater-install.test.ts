import { NodeServices } from "@effect/platform-node"
import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
// altimate: ALT-F03
import { defaults, resolveIdentity, type Descriptor } from "@opencode/util/identity"
import { AppProcess } from "@opencode/util/process"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Layer, PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Updater } from "../src/services/updater"
import { testEffect } from "../../core/test/lib/effect"
// altimate: ALT-F03
import branded from "../../altimate/identity.json"

const it = testEffect(NodeServices.layer)

declare const OPENCODE_CLI_NAME: string | undefined
// altimate: ALT-F03
declare const OPENCODE_CHANNEL: string | undefined

const altimate = resolveIdentity(branded)

function fixture(
  respond: (command: ChildProcess.StandardCommand) => Partial<AppProcess.RunResult> & {
    error?: AppProcess.AppProcessError
  } = () => ({}),
  name = "@opencode/cli",
  failCleanup = false,
  releasePackage = name,
  formula?: string,
  executableOverride?: (
    root: string,
    home: string,
  ) => Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem>,
  // altimate: ALT-F03
  options: { identity?: Descriptor; version?: string } = {},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-updater-" })
    const execPath = process.execPath
    const modules = path.join(root, "node_modules")
    const executable = executableOverride
      ? yield* executableOverride(root, path.join(root, "home"))
      : formula
        ? path.join(root, "Cellar", formula, "2.0.20", "bin", "opencode")
        : path.join(modules, "@opencode", "cli", "bin", "opencode")
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true })
    yield* fs.writeFileString(executable, "binary")
    if (!formula && !executableOverride)
      yield* fs.writeFileString(
        path.join(modules, "@opencode", "cli", "package.json"),
        JSON.stringify({ name, bin: { opencode: "bin/opencode" } }),
      )
    const requests: string[] = []
    // altimate: ALT-F03 - inject a transport so every test is offline without changing global fetch.
    const request = Object.assign(
      async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString()
        requests.push(url)
        if (new URL(url).hostname === "formulae.brew.sh") return Response.json({ versions: { stable: "2.0.21" } })
        return Response.json({
          version: options.version ?? "2.3.4",
          metadata: { package: formula && !url.includes("/homebrew?") ? name : releasePackage },
        })
      },
      { preconnect: fetch.preconnect },
    )
    const global = Global.make({
      home: path.join(root, "home"),
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
      bin: path.join(root, "bin"),
      log: path.join(root, "log"),
      repos: path.join(root, "repos"),
    })
    // Windows locates the installer's Git Bash through `git --exec-path`; answer it with a fixture install.
    const git = path.join(root, "Git")
    const bash = process.platform === "win32" ? path.join(git, "bin", "bash.exe") : "bash"
    if (process.platform === "win32") {
      yield* fs.makeDirectory(path.dirname(bash), { recursive: true })
      yield* fs.writeFileString(bash, "bash")
    }
    const commands: string[][] = []
    const updater = yield* Updater.Service.pipe(
      // altimate: ALT-F03
      Effect.provide(Updater.layerWith({ identity: options.identity, fetch: request })),
      Effect.provide(
        LayerNode.compile(EffectFlock.node, {
          replacements: [Global.node.replace(Layer.succeed(Global.Service, global))],
        }),
      ),
      Effect.provideService(Global.Service, global),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        remove: (target, options) =>
          failCleanup && target.startsWith(global.cache)
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: target,
                }),
              )
            : fs.remove(target, options),
        realPath: (input) => (input === execPath ? fs.realPath(executable) : fs.realPath(input)),
      }),
      Effect.provideService(
        AppProcess.Service,
        AppProcess.Service.of({
          ...spawner,
          run: (command) =>
            Effect.suspend(() => {
              if (command._tag !== "StandardCommand") return Effect.die("Unexpected piped install command")
              const lookup = command.command === "git" && command.args[0] === "--exec-path"
              if (!lookup) commands.push([command.command, ...command.args])
              const result = lookup
                ? { stdout: Buffer.from(`${path.join(git, "mingw64", "libexec", "git-core")}\n`) }
                : respond(command)
              if (result.error) return Effect.fail(result.error)
              return Effect.succeed({
                command: command.command,
                exitCode: 0,
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
                stdoutTruncated: false,
                stderrTruncated: false,
                ...result,
              })
            }),
          runStream: () => Stream.die("Unexpected streaming install command"),
        }),
      ),
    )
    return { updater, commands, requests, global, fs, executable, bash }
  })
}

const windows = process.platform === "win32" ? it.live : it.live.skip
const unix = process.platform === "win32" ? it.live.skip : it.live

const installs = [
  { method: "npm", command: ["npm", "install", "--global", "--force", "@opencode/cli@2.3.4-beta.1"] },
  {
    method: "pnpm",
    command: ["pnpm", "add", "--global", "--allow-build=@opencode/cli", "@opencode/cli@2.3.4-beta.1"],
  },
  { method: "yarn", command: ["yarn", "global", "add", "@opencode/cli@2.3.4-beta.1"] },
  { method: "vp", command: ["vp", "update", "-g", "@opencode/cli@2.3.4-beta.1"] },
] as const

installs.forEach(({ method, command }) => {
  it.live(`${method} installs the explicit V2 package version without a leading v`, () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* test.updater.upgrade(method, "v2.3.4-beta.1")
      expect(test.commands).toEqual([[...command]])
    }),
  )
})

// altimate: ALT-F03 - package migration can only target the identity's expected artifact package.
it.live("vp force-installs the expected V2 package that replaces the existing binary owner", () =>
  Effect.gen(function* () {
    const test = yield* fixture(() => ({}), "@opencode/cli-node", false, "@opencode/cli")
    yield* test.updater.upgrade("vp", "v2.3.4-beta.1")
    expect(test.commands).toEqual([["vp", "install", "-g", "--force", "@opencode/cli@2.3.4-beta.1"]])
  }),
)

it.live("vp removes the package from its managed global store", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    const removal = test.updater.removal("vp")
    if (!removal) return yield* Effect.die("Expected vp removal command")
    expect(removal.command).toEqual(["vp", "uninstall", "-g", "@opencode/cli"])
    yield* removal.run
    expect(test.commands).toEqual([["vp", "uninstall", "-g", "@opencode/cli"]])
  }),
)
;[0, 1].forEach((exitCode) => {
  it.live(`bun isolates and removes its install cache after exit ${exitCode}`, () =>
    Effect.gen(function* () {
      const test = yield* fixture((command) => {
        expect(command.command).toBe("bun")
        expect(existsSync(command.args[4])).toBe(true)
        return { exitCode, stderr: Buffer.from("bun install failed") }
      })
      const result = yield* test.updater.upgrade("bun", "v2.3.4-beta.1").pipe(Effect.flip, Effect.option)
      const cache = test.commands[0]?.[5]
      expect(cache).toStartWith(path.join(test.global.cache, "update-"))
      expect(test.commands).toEqual([
        ["bun", "install", "--global", "--trust", "--cache-dir", cache, "@opencode/cli@2.3.4-beta.1"],
      ])
      expect(yield* test.fs.readDirectory(test.global.cache)).toEqual([])
      expect(result._tag).toBe(exitCode === 0 ? "None" : "Some")
      if (result._tag === "Some") expect(result.value.message).toBe("bun install failed")
    }),
  )
})

it.live("bun ignores install cache cleanup failures", () =>
  Effect.gen(function* () {
    const test = yield* fixture(() => ({}), "@opencode/cli", true)
    yield* test.updater.upgrade("bun", "v2.3.4-beta.1")
    expect(test.commands).toHaveLength(1)
  }),
)
;["success", "download", "install"].forEach((failure) => {
  it.live(`curl uses the V2 installer and cleans its directory: ${failure}`, () =>
    Effect.gen(function* () {
      const test = yield* fixture((command) => {
        const installer = command.command === "curl" ? command.args[2] : command.args[0]
        expect(existsSync(path.dirname(installer))).toBe(true)
        return {
          exitCode:
            path.basename(command.command, ".exe") ===
            (failure === "download" ? "curl" : failure === "install" ? "bash" : "")
              ? 1
              : 0,
          stderr: Buffer.from(`${failure} failed`),
        }
      })
      const result = yield* test.updater.upgrade("curl", "v2.3.4-beta.1").pipe(Effect.flip, Effect.option)
      const installer = test.commands[0]?.[3]
      expect(installer).toStartWith(path.join(test.global.cache, "update-"))
      expect(test.commands).toEqual([
        ["curl", "-fsSL", "-o", installer, "https://opencode.ai/v2/install"],
        ...(failure === "download" ? [] : [[test.bash, installer, "--version", "2.3.4-beta.1", "--no-modify-path"]]),
      ])
      expect(yield* test.fs.readDirectory(test.global.cache)).toEqual([])
      expect(result._tag).toBe(failure === "success" ? "None" : "Some")
      if (result._tag === "Some") expect(result.value.message).toBe(`${failure} failed`)
    }),
  )
})

it.live("invalid version targets never execute a command or create a cache", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    yield* Effect.forEach(Updater.methods, (method) =>
      Effect.forEach(
        ["", "latest", "2.3", "01.2.3", "vv2.3.4", "2.3.4; echo unsafe", "--global", "v2.3.4\n--force"],
        (version) =>
          Effect.gen(function* () {
            const error = yield* test.updater.upgrade(method, version).pipe(Effect.flip)
            expect(error.message).toBe(`Invalid version: ${version}`)
          }),
      ),
    )
    expect(test.commands).toEqual([])
    expect(yield* test.fs.exists(test.global.cache)).toBe(false)
  }),
)

it.live("install failures expose stderr and process errors do not report success", () =>
  Effect.gen(function* () {
    const failed = yield* fixture(() => ({ exitCode: 1, stderr: Buffer.from("  registry denied access\n") }))
    const error = yield* failed.updater.upgrade("npm", "2.3.4").pipe(Effect.flip)
    expect(error.message).toBe("registry denied access")
    const missing = yield* fixture(() => ({ error: new AppProcess.AppProcessError({ command: "npm" }) }))
    const unavailable = yield* missing.updater.upgrade("npm", "2.3.4").pipe(Effect.flip)
    expect(unavailable.message).toBe("Failed to update with npm")
    expect(failed.commands).toHaveLength(1)
    expect(missing.commands).toHaveLength(1)
  }),
)
;(["npm", "pnpm", "bun", "yarn", "vp", undefined] as const).forEach((method) => {
  it.live(`method detection identifies ${method ?? "an unknown installation"} using the V2 package`, () =>
    Effect.gen(function* () {
      const test = yield* fixture((command) => ({
        stdout: Buffer.from(
          command.command === method
            ? method === "vp"
              ? JSON.stringify([{ name: "@opencode/cli", version: "2.3.4" }])
              : "@opencode/cli@2.3.4"
            : command.command === "vp"
              ? "[]"
              : "opencode-ai@1.0.0",
        ),
      }))
      expect(yield* test.updater.method()).toBe(method)
      expect(test.commands).toEqual([
        ["npm", "list", "-g", "--depth=0", "@opencode/cli"],
        ["pnpm", "list", "-g", "--depth=0", "@opencode/cli"],
        ["bun", "pm", "ls", "-g"],
        ["yarn", "global", "list"],
        ["vp", "list", "-g", "--json", "@opencode/cli"],
      ])
    }),
  )
})

it.live("method detection tolerates unavailable package managers", () =>
  Effect.gen(function* () {
    const test = yield* fixture((command) =>
      command.command === "yarn"
        ? { stdout: Buffer.from("@opencode/cli@2.3.4") }
        : { error: new AppProcess.AppProcessError({ command: command.command }) },
    )
    expect(yield* test.updater.method()).toBe("yarn")
    expect(test.commands).toHaveLength(5)
  }),
)

it.live("vp detection ignores no-match output that repeats the package name", () =>
  Effect.gen(function* () {
    const test = yield* fixture((command) => ({
      stdout: Buffer.from(command.command === "vp" ? "No global packages matching '@opencode/cli'." : ""),
    }))
    expect(yield* test.updater.method()).toBeUndefined()
  }),
)

it.live("Homebrew Core installs check and upgrade the Core formula", () =>
  Effect.gen(function* () {
    const test = yield* fixture(() => ({}), "@opencode/cli", false, "anomalyco/tap/opencode-v2", "opencode")
    expect(yield* test.updater.method()).toBe("brew")
    expect(yield* test.updater.latest()).toBe("2.0.21")
    yield* test.updater.upgrade("brew", "2.0.21")
    expect(test.commands).toEqual([["brew", "upgrade", "opencode"]])
    // An explicitly selected method keeps its own release source.
    expect(yield* test.updater.latest("npm")).toBe("2.3.4")
    expect(test.requests).toEqual([
      "https://formulae.brew.sh/api/formula/opencode.json",
      "https://opencode.ai/update/api/local/cli/npm?current=local",
    ])
  }),
)
;["opencode-v2", "opencode-beta"].forEach((formula) => {
  it.live(`Homebrew tap installs of ${formula} use the published tap formula`, () =>
    Effect.gen(function* () {
      // altimate: ALT-F03 - a local-channel build expects the default tap package, even in a beta Cellar.
      const test = yield* fixture(() => ({}), "@opencode/cli", false, "anomalyco/tap/opencode-v2", formula)
      expect(yield* test.updater.method()).toBe("brew")
      expect(yield* test.updater.latest()).toBe("2.3.4")
      yield* test.updater.upgrade("brew", "2.3.4")
      expect(test.commands).toEqual([["brew", "upgrade", "anomalyco/tap/opencode-v2"]])
      expect(test.requests).toEqual([
        "https://opencode.ai/update/api/local/cli/homebrew?current=local",
        "https://opencode.ai/update/api/local/cli/homebrew?current=local",
      ])
    }),
  )
})

const winget = (search: Partial<AppProcess.RunResult>) =>
  fixture(
    (command) => (command.args[0] === "search" ? search : {}),
    "@opencode/cli",
    false,
    "@opencode/cli",
    undefined,
    (root) =>
      Effect.succeed(
        path.join(
          root,
          "AppData",
          "Local",
          "Microsoft",
          "WinGet",
          "Packages",
          "Anomaly.OpenCode_Microsoft.Winget.Source_8wekyb3d8bbwe",
          "opencode.exe",
        ),
      ),
  )
const wingetArgs = [
  "--id",
  "Anomaly.OpenCode",
  "--exact",
  "--source",
  "winget",
  "--accept-source-agreements",
  "--disable-interactivity",
]

it.live("WinGet installs check, upgrade, and remove the version in the WinGet index", () =>
  Effect.gen(function* () {
    const test = yield* winget({
      stdout: Buffer.from(
        "Name     Id               Version\r\n------------------------------\r\nOpenCode Anomaly.OpenCode 2.0.28\r\n",
      ),
    })
    expect(yield* test.updater.method()).toBe("winget")
    expect(yield* test.updater.latest()).toBe("2.0.28")
    yield* test.updater.upgrade("winget", "v2.0.28")
    const removal = test.updater.removal("winget")
    if (!removal) return yield* Effect.die("Expected winget removal command")
    yield* removal.run
    expect(test.commands).toEqual([
      ["winget", "search", ...wingetArgs],
      ["winget", "upgrade", ...wingetArgs, "--version", "2.0.28", "--silent", "--accept-package-agreements"],
      ["winget", "uninstall", ...wingetArgs],
    ])
    // WinGet moderates submissions, so the OpenCode release service may list a version WinGet cannot install yet.
    expect(test.requests).toEqual([])
  }),
)

it.live("WinGet update checks report a missing package instead of a version", () =>
  Effect.gen(function* () {
    const test = yield* winget({
      exitCode: -1978335212,
      stdout: Buffer.from("No package found matching input criteria.\r\n"),
    })
    const error = yield* test.updater.latest().pipe(Effect.flip)
    expect(error.message).toBe("No package found matching input criteria.")
  }),
)

// Links are named opencode-upgrade-<pid>-<random>.exe; read them from inside the installer run.
const links = (directory: string) =>
  existsSync(directory) ? readdirSync(directory).filter((name) => name.startsWith("opencode-")) : []
const upgradeLinks = (directory: string) =>
  links(directory).filter((name) => name.startsWith(`opencode-upgrade-${process.pid}-`))

windows("windows keeps a second link to the running binary in the cache while the installer runs", () =>
  Effect.gen(function* () {
    const layout = { executable: "", cache: "" }
    const test = yield* fixture(() => {
      expect(readFileSync(layout.executable, "utf8")).toBe("binary")
      const held = upgradeLinks(layout.cache)
      expect(held).toHaveLength(1)
      expect(readFileSync(path.join(layout.cache, held[0]), "utf8")).toBe("binary")
      return {}
    })
    layout.executable = test.executable
    layout.cache = test.global.cache
    yield* test.fs.makeDirectory(test.global.cache, { recursive: true })
    // pid 999999999 does not exist; pid 4 is System, alive but not openable (EPERM).
    yield* test.fs.writeFileString(path.join(test.global.cache, "opencode-upgrade-999999999-dead.exe"), "exited")
    yield* test.fs.writeFileString(path.join(test.global.cache, "opencode-service-4-aa.exe"), "inaccessible")
    yield* test.updater.upgrade("bun", "2.3.4")
    expect(test.commands).toHaveLength(1)
    // The installed path never disappears; the extra link is released and only dead ones are swept.
    expect(yield* test.fs.readFileString(test.executable)).toBe("binary")
    expect(links(test.global.cache)).toEqual(["opencode-service-4-aa.exe"])
  }),
)

windows("windows releases the link when the installer fails", () =>
  Effect.gen(function* () {
    const layout = { cache: "" }
    const test = yield* fixture(() => {
      expect(upgradeLinks(layout.cache)).toHaveLength(1)
      return { exitCode: 1, stderr: Buffer.from("registry denied access") }
    })
    layout.cache = test.global.cache
    const error = yield* test.updater.upgrade("npm", "2.3.4").pipe(Effect.flip)
    expect(error.message).toBe("registry denied access")
    expect(yield* test.fs.readFileString(test.executable)).toBe("binary")
    expect(links(test.global.cache)).toEqual([])
  }),
)

windows("windows keeps the uninstall link in the temporary directory, not the removed cache", () =>
  Effect.gen(function* () {
    const layout = { tmp: "" }
    const test = yield* fixture(() => {
      expect(upgradeLinks(layout.tmp)).toHaveLength(1)
      return {}
    })
    layout.tmp = test.global.tmp
    yield* test.fs.makeDirectory(test.global.cache, { recursive: true })
    const removal = test.updater.removal("bun")
    if (!removal) return yield* Effect.die("Expected bun removal command")
    yield* removal.run
    expect(test.commands).toEqual([["bun", "remove", "--global", "@opencode/cli"]])
    expect(links(test.global.cache)).toEqual([])
    expect(links(test.global.tmp)).toEqual([])
  }),
)

windows("windows links the curl binary before the installer replaces it", () =>
  Effect.gen(function* () {
    const layout = { executable: "", cache: "" }
    const test = yield* fixture(
      (command) => {
        if (path.basename(command.command, ".exe") === "bash") {
          expect(readFileSync(layout.executable, "utf8")).toBe("binary")
          expect(upgradeLinks(layout.cache)).toHaveLength(1)
        }
        return {}
      },
      "@opencode/cli",
      false,
      "@opencode/cli",
      undefined,
      (_root, home) => Effect.succeed(path.join(home, ".opencode", "bin", "opencode.exe")),
    )
    layout.executable = test.executable
    layout.cache = test.global.cache
    const original = process.execPath
    process.execPath = layout.executable
    yield* Effect.addFinalizer(() => Effect.sync(() => (process.execPath = original)))
    expect(yield* test.updater.method()).toBe("curl")
    yield* test.updater.upgrade("curl", "2.3.4")
    expect(test.commands.map((command) => command[0])).toEqual(["curl", test.bash])
    expect(yield* test.fs.readFileString(layout.executable)).toBe("binary")
    expect(links(test.global.cache)).toEqual([])
  }),
)

unix("curl method detection resolves symlinked home directories", () =>
  Effect.gen(function* () {
    const test = yield* fixture(
      () => ({}),
      "@opencode/cli",
      false,
      "@opencode/cli",
      undefined,
      (root, home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const realHome = path.join(root, "real-home")
          const bin = path.join(realHome, ".opencode", "bin", "opencode")
          yield* fs.makeDirectory(path.dirname(bin), { recursive: true })
          yield* fs.symlink(realHome, home)
          return bin
        }),
    )
    expect(yield* test.updater.method()).toBe("curl")
    expect(test.commands).toEqual([])
  }),
)

windows("windows leaves a source checkout's runtime alone", () =>
  Effect.gen(function* () {
    const layout = { cache: "" }
    // altimate: ALT-F03 - an unrelated runtime can still request the identity's valid update package.
    const test = yield* fixture(
      () => {
        expect(links(layout.cache)).toEqual([])
        return {}
      },
      "not-opencode",
      false,
      "@opencode/cli",
    )
    layout.cache = test.global.cache
    yield* test.updater.upgrade("bun", "2.3.4")
    expect(test.commands).toHaveLength(1)
  }),
)

unix("other platforms never link the running binary", () =>
  Effect.gen(function* () {
    const layout = { cache: "" }
    const test = yield* fixture(() => {
      expect(links(layout.cache)).toEqual([])
      return {}
    })
    layout.cache = test.global.cache
    yield* test.updater.upgrade("bun", "2.3.4")
    expect(yield* test.fs.readFileString(test.executable)).toBe("binary")
  }),
)

test("Node distribution honors the compile-time CLI name", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      import.meta.path,
      "--define",
      'OPENCODE_CLI_NAME="opencode2-node"',
      // altimate: ALT-F03 - the expected release package follows the compiled artifact.
      "--define",
      'OPENCODE_ARTIFACT="cli-node"',
      "--test-name-pattern",
      "^Node distribution resolves the published npm package$",
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "pipe",
      // Bun 1.4 can reuse cached modules compiled with different --define values.
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code, stderr).toBe(0)
  expect(stderr).toContain("1 pass")
})

if (typeof OPENCODE_CLI_NAME === "string" && OPENCODE_CLI_NAME === "opencode2-node") {
  it.live("Node distribution resolves the published npm package", () =>
    Effect.gen(function* () {
      const test = yield* fixture(
        (command) => ({
          stdout: Buffer.from(command.command === "npm" ? "@opencode/cli-node@2.3.4" : ""),
        }),
        "@opencode/cli-node",
      )
      expect(yield* test.updater.method()).toBe("npm")
      yield* test.updater.upgrade("npm", "v2.3.4")
      yield* test.updater.upgrade("pnpm", "v2.3.4")
      yield* test.updater.upgrade("vp", "v2.3.4")
      expect(test.commands).toEqual([
        ["npm", "list", "-g", "--depth=0", "@opencode/cli-node"],
        ["pnpm", "list", "-g", "--depth=0", "@opencode/cli-node"],
        ["bun", "pm", "ls", "-g"],
        ["yarn", "global", "list"],
        ["vp", "list", "-g", "--json", "@opencode/cli-node"],
        ["npm", "install", "--global", "@opencode/cli-node@2.3.4"],
        ["pnpm", "add", "--global", "--allow-build=@opencode/cli-node", "@opencode/cli-node@2.3.4"],
        ["vp", "update", "-g", "@opencode/cli-node@2.3.4"],
      ])
    }),
  )
}

// altimate: ALT-F03 - exercise the real service with the distribution descriptor and an offline transport.
;(["npm", "pnpm", "bun", "yarn", "vp"] as const).forEach((method) => {
  it.live(`Altimate detects ${method} and installs only its expected package`, () =>
    Effect.gen(function* () {
      const test = yield* fixture(
        (command) => ({
          stdout: Buffer.from(
            command.command !== method
              ? ""
              : method === "vp"
                ? JSON.stringify([{ name: "@altimateai/altimate-code" }])
                : "@altimateai/altimate-code@0.0.1-spike",
          ),
        }),
        "@altimateai/altimate-code",
        false,
        "@altimateai/altimate-code",
        undefined,
        undefined,
        { identity: altimate },
      )
      expect(yield* test.updater.method()).toBe(method)
      expect(test.commands.slice(0, 5)).toEqual([
        ["npm", "list", "-g", "--depth=0", "@altimateai/altimate-code"],
        ["pnpm", "list", "-g", "--depth=0", "@altimateai/altimate-code"],
        ["bun", "pm", "ls", "-g"],
        ["yarn", "global", "list"],
        ["vp", "list", "-g", "--json", "@altimateai/altimate-code"],
      ])
      yield* test.updater.upgrade(method, "v0.0.2-spike")
      const target = "@altimateai/altimate-code@0.0.2-spike"
      const expected = {
        npm: ["npm", "install", "--global", "--force", target],
        pnpm: ["pnpm", "add", "--global", "--allow-build=@altimateai/altimate-code", target],
        bun: ["bun", "install", "--global", "--trust", "--cache-dir", test.commands[5][5], target],
        yarn: ["yarn", "global", "add", target],
        vp: ["vp", "update", "-g", target],
      }
      expect(test.commands[5]).toEqual(expected[method])
      expect(test.requests).toEqual(["https://altimate.ai/altimate-code/update/api/local/cli/npm?current=local"])
      expect(test.updater.removal(method)?.command.at(-1)).toBe("@altimateai/altimate-code")
    }),
  )
})
;["@opencode/cli", "@opencode/cli-node", "unrelated-package"].forEach((name) => {
  it.live(`Altimate ignores an installed package named ${name}`, () =>
    Effect.gen(function* () {
      const test = yield* fixture(() => ({}), name, false, "@altimateai/altimate-code", undefined, undefined, {
        identity: altimate,
      })
      expect(yield* test.updater.method()).toBeUndefined()
      expect(test.commands).toEqual([])
      expect(test.requests).toEqual([])
    }),
  )
})

it.live("Altimate recognizes the legacy unscoped v1 package", () =>
  Effect.gen(function* () {
    const test = yield* fixture(
      (command) => ({ stdout: Buffer.from(command.command === "npm" ? "altimate-code@0.0.1-spike" : "") }),
      "altimate-code",
      false,
      "@altimateai/altimate-code",
      undefined,
      undefined,
      { identity: altimate },
    )
    expect(yield* test.updater.method()).toBe("npm")
    yield* test.updater.upgrade("npm", "0.0.2-spike")
    expect(test.commands.at(-1)).toEqual([
      "npm",
      "install",
      "--global",
      "--force",
      "@altimateai/altimate-code@0.0.2-spike",
    ])
  }),
)
;[
  { identity: defaults, expected: "@opencode/cli", wrong: "@altimateai/altimate-code" },
  { identity: altimate, expected: "@altimateai/altimate-code", wrong: "@opencode/cli" },
].forEach(({ identity, expected, wrong }) => {
  it.live(`${identity.displayName} refuses a manifest for the wrong package before installing`, () =>
    Effect.gen(function* () {
      const test = yield* fixture(() => ({}), expected, false, wrong, undefined, undefined, { identity })
      const lookup = yield* test.updater.latest("npm").pipe(Effect.flip)
      expect(lookup.message).toContain(expected)
      expect(lookup.message).toContain(wrong)
      expect(lookup.message).toMatch(/package/i)
      const install = yield* test.updater.upgrade("npm", "0.0.2-spike").pipe(Effect.flip)
      expect(install.message).toBe(lookup.message)
      expect(test.commands).toEqual([])
      expect(yield* test.fs.exists(test.global.cache)).toBe(false)
    }),
  )
})
;(["brew", "winget", "curl"] as const).forEach((method) => {
  it.live(`Altimate rejects deferred ${method} updates before any request or command`, () =>
    Effect.gen(function* () {
      const test = yield* fixture(
        () => ({}),
        "@altimateai/altimate-code",
        false,
        "@altimateai/altimate-code",
        undefined,
        undefined,
        { identity: altimate },
      )
      const lookup = yield* test.updater.latest(method).pipe(Effect.flip)
      expect(lookup.message).toContain("not supported for this distribution")
      const install = yield* test.updater.upgrade(method, "0.0.2-spike").pipe(Effect.flip)
      expect(install.message).toContain("not supported for this distribution")
      expect(test.commands).toEqual([])
      expect(test.requests).toEqual([])
      expect(test.updater.removal(method)).toBeUndefined()
    }),
  )
})

it.live("every URL constructed by the branded updater stays off opencode.ai", () =>
  Effect.gen(function* () {
    const test = yield* fixture(
      () => ({}),
      "@altimateai/altimate-code",
      false,
      "@altimateai/altimate-code",
      undefined,
      undefined,
      { identity: altimate },
    )
    yield* test.updater.latest()
    yield* Effect.forEach(Updater.methods, (method) =>
      test.updater
        .latest(method)
        .pipe(Effect.ignore)
        .pipe(Effect.andThen(test.updater.upgrade(method, "0.0.2-spike").pipe(Effect.ignore))),
    )
    const urls = [...test.requests, ...test.commands.flat().filter((arg) => /^https?:/.test(arg))]
    expect(urls.length).toBeGreaterThan(0)
    urls.forEach((url) => {
      expect(new URL(url).hostname).toBe("altimate.ai")
      expect(url).not.toContain("opencode.ai")
    })
  }),
)

unix("Altimate install-location detection and an enabled installer use the descriptor", () =>
  Effect.gen(function* () {
    const test = yield* fixture(
      () => ({}),
      "@altimateai/altimate-code",
      false,
      "@altimateai/altimate-code",
      undefined,
      (_root, home) => Effect.succeed(path.join(home, ".altimate-code", "bin", "altimate-code")),
      { identity: { ...altimate, updater: { ...altimate.updater, installerUrl: "https://altimate.ai/install" } } },
    )
    expect(yield* test.updater.method()).toBe("curl")
    yield* test.updater.upgrade("curl", "0.0.2-spike")
    expect(test.commands[0].at(-1)).toBe("https://altimate.ai/install")
    expect(test.requests).toEqual(["https://altimate.ai/altimate-code/update/api/local/cli/npm?current=local"])
    expect([...test.requests, ...test.commands.flat()].join(" ")).not.toContain("opencode.ai")
  }),
)

test("branded installed builds exercise real TUI update checks and policy precedence offline", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      import.meta.path,
      "--define",
      'OPENCODE_VERSION="0.0.1-spike"',
      "--define",
      'OPENCODE_CHANNEL="spike"',
      "--test-name-pattern",
      "^branded installed build:",
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...process.env,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        OPENCODE_DISABLE_AUTOUPDATE: "0",
        ALTIMATE_CLI_DISABLE_AUTOUPDATE: "0",
      },
    },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code, stderr).toBe(0)
  expect(stderr).toContain("3 pass")
})

if (typeof OPENCODE_CHANNEL === "string" && OPENCODE_CHANNEL === "spike") {
  const installed = (releasePackage = "@altimateai/altimate-code") =>
    fixture(
      (command) => ({ stdout: Buffer.from(command.command === "npm" ? "@altimateai/altimate-code@0.0.1-spike" : "") }),
      "@altimateai/altimate-code",
      false,
      releasePackage,
      undefined,
      undefined,
      { identity: altimate, version: "0.0.2-spike" },
    )

  it.live("branded installed build: check, apply, and recheck use the branded release", () =>
    Effect.gen(function* () {
      const test = yield* installed()
      expect(yield* test.updater.check()).toEqual({ type: "available", version: "0.0.2-spike" })
      yield* test.updater.apply("0.0.2-spike")
      expect(yield* test.updater.check()).toEqual({ type: "installed", version: "0.0.2-spike" })
      expect(test.requests).toEqual(
        Array(3).fill("https://altimate.ai/altimate-code/update/api/spike/cli/npm?current=0.0.1-spike"),
      )
      expect(test.commands.filter((command) => command[1] === "install")).toEqual([
        ["npm", "install", "--global", "--force", "@altimateai/altimate-code@0.0.2-spike"],
      ])
    }),
  )

  it.live("branded installed build: check refuses a wrong-package manifest", () =>
    Effect.gen(function* () {
      const test = yield* installed("@opencode/cli")
      const error = yield* test.updater.check().pipe(Effect.flip)
      expect(error.message).toContain("@opencode/cli")
      expect(error.message).toContain("@altimateai/altimate-code")
      expect(test.commands.every((command) => command[1] !== "install")).toBe(true)
    }),
  )

  it.live("branded installed build: branded policy files override inherited legacy files", () =>
    Effect.gen(function* () {
      const test = yield* installed()
      yield* test.fs.makeDirectory(test.global.config, { recursive: true })
      yield* test.fs.writeFileString(path.join(test.global.config, "config.json"), '{"update":"disable"}')
      expect(yield* test.updater.run()).toBeUndefined()
      expect(test.requests).toEqual([])
      yield* test.fs.writeFileString(path.join(test.global.config, "opencode.json"), '{"update":"notify"}')
      expect(yield* test.updater.run()).toEqual({ type: "available", version: "0.0.2-spike" })
      yield* test.fs.writeFileString(path.join(test.global.config, "opencode.jsonc"), '{"update":"disable"}')
      expect(yield* test.updater.run()).toBeUndefined()
      yield* test.fs.writeFileString(path.join(test.global.config, "altimate-code.json"), '{"update":"notify"}')
      expect(yield* test.updater.run()).toEqual({ type: "available", version: "0.0.2-spike" })
      yield* test.fs.writeFileString(path.join(test.global.config, "altimate-code.jsonc"), '{"update":"disable"}')
      expect(yield* test.updater.run()).toBeUndefined()
      expect(test.requests).toHaveLength(2)
    }),
  )
}
