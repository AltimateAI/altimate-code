// altimate: ALT-F01
import { cliName } from "./identity"
export * as ServerProcess from "./server-process"

import { NodeServices } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
// altimate: ALT-F01
import { get, keys } from "@opencode/util/env"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_VERSION } from "./version"
import { AppProcess } from "@opencode/util/process"
import { randomBytes, randomUUID } from "node:crypto"
import { Effect, Option, Redacted, Schema } from "effect"
import { PersistentPty } from "@opencode/schema/persistent-pty"
import { HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import { Env } from "./env"
import { ServiceConfig } from "./services/service-config"
import { RetainedImage } from "./services/retained-image"
import { ServiceRegistration } from "./services/service-registration"
import { RemoteTunnel } from "./services/remote-tunnel"
import { WebUi } from "./services/web-ui"
import { databasePath } from "./database-path"

export type Mode = "default" | "service" | "stdio"

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
  readonly cors?: readonly string[]
}

// The process effect lives until server shutdown; tracing it would parent every request to one process-lifetime trace.
export const run = Effect.fnUntraced(function* (options: Options) {
  return yield* processEffect(options).pipe(
    Effect.provide(
      LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), {
        replacements: [
          Global.node.replace(
            // altimate: ALT-F01
            Global.layerWith(get("OPENCODE_CONFIG_DIR") ? { config: get("OPENCODE_CONFIG_DIR") } : {}),
          ),
        ],
      }),
    ),
    Effect.provide(NodeServices.layer),
  )
})

const processEffect = Effect.fnUntraced(function* (options: Options) {
  const inherited = process.env.OPENCODE_PTY_HANDOFF
  delete process.env.OPENCODE_PTY_HANDOFF
  const handoff =
    inherited === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistentPty.Handoff))(inherited).pipe(
          Effect.catch(() =>
            Effect.logWarning("Ignoring invalid PTY restart handoff; persistent terminals will start fresh").pipe(
              Effect.as(undefined),
            ),
          ),
        )
  const global = yield* Global.Service
  if (options.mode === "service") yield* Effect.sync(() => process.chdir(global.home))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const foreground = options.mode === "default"
      const serviceOptions = options.mode === "service" ? yield* ServiceConfig.options() : undefined
      const config = options.mode === "service" ? yield* ServiceConfig.read() : {}
      const hostname = options.hostname ?? config.hostname ?? "127.0.0.1"
      const port = options.port ?? config.port ?? (options.mode === "service" ? ServiceConfig.defaultPort() : undefined)
      const findIncumbent =
        serviceOptions !== undefined && port !== undefined
          ? Service.incumbent({ ...serviceOptions, url: serviceURL(hostname, port) })
          : undefined
      if (findIncumbent !== undefined && (yield* findIncumbent) !== undefined) return
      // Keep a package-manager or curl install replaceable while the service runs; Desktop updates its own copy.
      if (options.mode === "service" && process.platform === "win32" && RetainedImage.installed(global.home))
        yield* RetainedImage.retain(global.cache, "service")
      const { start } = yield* Effect.promise(() => import("@opencode/server/process"))
      const environmentPassword = yield* Env.password
      // Keep the lease credential out of the environment inherited by tools.
      if (options.mode === "stdio") {
        // altimate: ALT-F01
        keys("OPENCODE_PASSWORD").concat(keys("OPENCODE_SERVER_PASSWORD")).forEach((key) => delete process.env[key])
      }
      const password =
        options.mode === "service"
          ? config.password || randomBytes(32).toString("base64url")
          : environmentPassword
            ? Redacted.value(environmentPassword)
            : randomBytes(32).toString("base64url")
      if (!password) return yield* Effect.fail(new Error("Missing server password"))
      const instanceID = randomUUID()
      const transform = yield* WebUi.handler()
      const remote = { urls: [] as ReadonlyArray<string> }
      const launch = start(
        {
          // altimate: ALT-F01
          app: {
            name: get("OPENCODE_CLIENT") ?? OPENCODE_ARTIFACT,
            version: OPENCODE_VERSION,
            channel: OPENCODE_CHANNEL,
          },
          hostname,
          port,
          cors: options.cors ?? config.cors,
          password,
          pty: { handoff },
          // altimate: ALT-F01
          simulation: truthy(get("OPENCODE_SIMULATE")),
          database: {
            path: databasePath(global.data),
          },
          // altimate: ALT-F01
          models: {
            url: get("OPENCODE_MODELS_URL"),
            file: get("OPENCODE_MODELS_PATH"),
            fetch: !truthy(get("OPENCODE_DISABLE_MODELS_FETCH")),
          },
          // altimate: ALT-F01
          config: {
            directory: get("OPENCODE_CONFIG_DIR"),
            project: !truthy(get("OPENCODE_CONFIG_PROJECT_DISABLE") ?? get("OPENCODE_DISABLE_PROJECT_CONFIG")),
            file: get("OPENCODE_CONFIG"),
            content: get("OPENCODE_CONFIG_CONTENT"),
          },
          // altimate: ALT-F01
          windows: {
            gitbash: get("OPENCODE_GIT_BASH_PATH"),
          },
          fs: {
            filewatcher: !truthy(get("OPENCODE_FILEWATCHER_DISABLE") ?? get("OPENCODE_DISABLE_FILEWATCHER")),
            fff:
              get("OPENCODE_DISABLE_FFF") === undefined
                ? process.platform !== "win32"
                : !truthy(get("OPENCODE_DISABLE_FFF")),
          },
        },
        serviceOptions === undefined
          ? undefined
          : {
              onListen: (address, shutdown) =>
                Effect.gen(function* () {
                  if (!config.password) yield* ServiceConfig.password(password)
                  return yield* ServiceRegistration.register({
                    address,
                    password,
                    id: instanceID,
                    file: serviceOptions.file,
                    shutdown,
                  })
                }),
            },
        transform,
        () => remote.urls,
      )
      const server = yield* launch.pipe(
        Effect.catch((error) => {
          if (findIncumbent === undefined || !addressInUse(error)) return Effect.fail(error)
          return Effect.gen(function* () {
            const deadline = Date.now() + 15_000
            while (Date.now() < deadline) {
              const found = yield* findIncumbent.pipe(Effect.timeoutOption(deadline - Date.now()))
              if (Option.isSome(found) && found.value !== undefined) return
              yield* Effect.sleep("100 millis")
              if (Date.now() >= deadline) break
              // Failed binds close their scope; a successful bind may take longer than this window to boot.
              const server = yield* launch.pipe(Effect.catchIf(addressInUse, () => Effect.void))
              if (server !== undefined) return server
            }
            return yield* Effect.fail(
              // altimate: ALT-F01
              portInUseError(port, hostname, error),
            )
          })
        }),
      )
      if (server === undefined) return
      if (serviceOptions !== undefined && config.remote !== undefined && NetAddress.isInetAddress(server.address)) {
        const bound = NetAddress.formatIp(server.address.address)
        // A wildcard bind also listens on loopback, which is all the tunnel needs to reach.
        const target =
          bound === "0.0.0.0" || bound === "::"
            ? `127.0.0.1:${server.address.port}`
            : NetAddress.formatInet(server.address)
        yield* Effect.forkScoped(
          RemoteTunnel.run({
            route: config.remote.route,
            target,
            onURL: (url) => {
              remote.urls = url === undefined ? [] : [url]
            },
          }),
        )
      }
      const url = HttpServer.formatAddress(server.address)
      console.log(options.mode === "stdio" ? JSON.stringify({ url }) : `server listening on ${url}`)
      if (foreground && !environmentPassword) console.log(`server password ${password}`)
      return yield* options.mode === "service"
        ? server.shutdown
        : options.mode === "stdio"
          ? waitForStdinClose()
          : Effect.never
    }).pipe(Effect.annotateLogs({ role: "server" })),
  )
})

function serviceURL(hostname: string, port: number) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

function addressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "EADDRINUSE") return true
  return "cause" in error && addressInUse(error.cause)
}

function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)
      process.stdin.off("close", close)
      process.stdin.pause()
    })
  })
}

// altimate: ALT-F01
export function portInUseError(port: number | undefined, hostname: string, cause: unknown) {
  return new Error(
    `Managed service port ${port} on ${hostname} is already in use by another process. ` +
      `Configure another port with \`${cliName} service set port <port>\` and start the service again.`,
    { cause },
  )
}
