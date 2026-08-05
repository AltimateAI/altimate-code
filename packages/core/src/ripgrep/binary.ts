import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "../cross-spawn-spawner"
import { LayerNode } from "../effect/layer-node"
import { httpClient } from "../effect/layer-node-platform"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { which } from "../util/which"
// altimate_change start — upstream_fix: unzip in-process instead of shelling out to PowerShell.
import { randomUUID } from "node:crypto"
import { BlobReader, BlobWriter, ZipReader } from "@zip.js/zip.js"
// altimate_change end

export namespace RipgrepBinary {
  const VERSION = "15.1.0"
  const PLATFORM = {
    "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
    "arm64-linux": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
    "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
    "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
    "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
    "ia32-win32": { platform: "i686-pc-windows-msvc", extension: "zip" },
    "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
  } as const

  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  // altimate_change start — upstream_fix: unzip in-process instead of shelling out to PowerShell.
  // Windows is the only platform that ships ripgrep as a zip, and the previous `Expand-Archive`
  // implementation needed a resolvable powershell.exe/pwsh.exe. When neither resolved (locked-down
  // or non-English corporate images), cross-spawn silently re-spawned through `cmd.exe /d /s /c`,
  // which answers "'powershell.exe' is not recognized as an internal or external command". That
  // string became the thrown Error verbatim; `filepath` is Effect.cached, so one failed extraction
  // broke grep for the rest of the session. Telemetry showed 99 Windows machines stuck on this.
  // Decoding in-process removes the external dependency entirely. Upstream has the same fragility
  // open as anomalyco/opencode#24291 (Expand-Archive unusable from a Bun-spawned process) — their
  // #23457 fix only corrected how the paths were passed to PowerShell, not the dependency on it.
  /** Decode the `rg` executable out of a ripgrep release zip. Exported for tests. */
  export const unzipExecutable = Effect.fnUntraced(function* (bytes: ArrayBuffer) {
    const reader = new ZipReader(new BlobReader(new Blob([bytes])))

    // The reader stays open across both getEntries() and getData() — closing after the first would
    // release it while entry reads are still outstanding.
    return yield* Effect.gen(function* () {
      const entries = yield* Effect.tryPromise({
        try: () => reader.getEntries(),
        catch: (cause) => new Error(`ripgrep archive could not be read: ${cause}`),
      })

      // Release zips nest the binary under `ripgrep-<version>-<platform>/`, but match a bare
      // `rg.exe` too so a flattened or repackaged archive still works.
      const entry = entries.find((x) => !x.directory && /(^|[\\/])rg\.exe$/i.test(x.filename))
      if (!entry?.getData) return yield* Effect.fail(new Error("ripgrep archive did not contain rg.exe"))

      // checkSignature defaults to false in zip.js, which would let a CRC-corrupt download decode
      // "successfully". The bytes are then written to Global.Path.bin and trusted by every later
      // session purely because the file exists — a corrupt download would break grep permanently,
      // which is the failure class this change exists to remove.
      const blob = yield* Effect.tryPromise({
        try: () => entry.getData!(new BlobWriter(), { checkSignature: true }),
        catch: (cause) => new Error(`ripgrep archive entry could not be decoded: ${cause}`),
      })
      const decoded = yield* Effect.promise(() => blob.arrayBuffer())
      if (decoded.byteLength === 0) return yield* Effect.fail(new Error("ripgrep archive contained an empty rg.exe"))
      return new Uint8Array(decoded)
    }).pipe(Effect.ensuring(Effect.promise(() => reader.close()).pipe(Effect.ignore)))
  })
  // altimate_change end

  export class Service extends Context.Service<Service, Interface>()("@opencode/RipgrepBinary") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const spawner = yield* ChildProcessSpawner

      const run = Effect.fnUntraced(function* (command: string, args: string[]) {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { extendEnv: true, stdin: "ignore" }))
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        )
        return { stdout, stderr, code }
      }, Effect.scoped)

      // altimate_change start — upstream_fix: install the binary atomically.
      // `target` is the cache path every later session trusts on existence alone
      // (`fs.isFile(target)` below — no size or integrity check). A write interrupted partway
      // therefore leaves a truncated `rg.exe` that is reused forever, which is the same
      // "permanently broken until the cache is deleted by hand" failure this change exists to
      // remove — and `checkSignature` cannot help, since CRC is verified before the write.
      // Staging next to the target keeps the rename within one filesystem, so it is atomic.
      const install = Effect.fnUntraced(
        function* (target: string, write: (staged: string) => Effect.Effect<void, Error>) {
          // Staging name is unique per attempt. A shared `${target}.tmp` lets two cold-cache
          // processes clobber each other: one renames while the other is still writing, so the
          // loser publishes a partial binary or renames a file that no longer exists.
          const staged = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
          yield* Effect.gen(function* () {
            yield* write(staged)
            if (process.platform !== "win32") yield* fs.chmod(staged, 0o755)
            // POSIX rename replaces atomically. Windows fails when the destination exists, so
            // retry once after removing it — but only after the first attempt has failed, so a
            // rename that fails for any other reason leaves the existing binary untouched.
            yield* fs.rename(staged, target).pipe(
              Effect.catch(() =>
                Effect.gen(function* () {
                  yield* fs.remove(target, { force: true }).pipe(Effect.ignore)
                  yield* fs.rename(staged, target)
                }),
              ),
            )
          }).pipe(Effect.onError(() => fs.remove(staged, { force: true }).pipe(Effect.ignore)))
        },
        // Name the failure. A resolve failure is memoized by Effect.cached, so it is re-reported on
        // every later grep of the session — an unattributed filesystem message there is what made
        // the Windows outage read as a tool bug rather than a binary problem.
        Effect.mapError((cause) => {
          const message = cause instanceof Error ? cause.message : String(cause)
          return /ripgrep/i.test(message) ? cause : new Error(`ripgrep binary install failed: ${message}`)
        }),
      )
      // altimate_change end

      // altimate_change start — upstream_fix: tar.gz path only; zip is handled by unzipExecutable.
      const extractTar = Effect.fnUntraced(function* (
        archive: string,
        config: (typeof PLATFORM)[keyof typeof PLATFORM],
        target: string,
      ) {
        const dir = yield* fs.makeTempDirectoryScoped({ directory: Global.Path.bin, prefix: "ripgrep-" })

        const result = yield* run("tar", ["-xzf", archive, "-C", dir])
        // Attribute the failure to ripgrep extraction rather than reporting child stderr verbatim —
        // an unattributed shell string is what made the Windows outage undiagnosable.
        if (result.code !== 0)
          throw new Error(
            `ripgrep extraction failed with code ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
          )

        const extracted = path.join(
          dir,
          `ripgrep-${VERSION}-${config.platform}`,
          process.platform === "win32" ? "rg.exe" : "rg",
        )
        if (!(yield* fs.isFile(extracted))) throw new Error(`ripgrep archive did not contain executable: ${extracted}`)

        yield* install(target, (staged) => fs.copyFile(extracted, staged))
      }, Effect.scoped)
      // altimate_change end

      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            const system = yield* Effect.sync(() => which(process.platform === "win32" ? "rg.exe" : "rg"))
            if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

            const target = path.join(Global.Path.bin, `rg${process.platform === "win32" ? ".exe" : ""}`)
            if (yield* fs.isFile(target).pipe(Effect.orDie)) return target

            const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
            const config = PLATFORM[platformKey]
            if (!config) throw new Error(`unsupported platform for ripgrep: ${platformKey}`)

            const filename = `ripgrep-${VERSION}-${config.platform}.${config.extension}`
            const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`

            yield* Effect.logInfo("downloading ripgrep", { url })
            yield* fs.ensureDir(Global.Path.bin).pipe(Effect.orDie)
            const bytes = yield* HttpClientRequest.get(url).pipe(
              http.execute,
              Effect.flatMap((response) => response.arrayBuffer),
              // altimate_change start — upstream_fix: name the download failure.
              // A bare HttpClientError/ResponseError says nothing about ripgrep, and because
              // `filepath` is Effect.cached it is then re-reported on every later grep of the
              // session — a network block or proxy 403 would read as a grep bug.
              Effect.mapError((cause) => {
                const message = cause instanceof Error ? cause.message : String(cause)
                return /ripgrep/i.test(message)
                  ? cause instanceof Error
                    ? cause
                    : new Error(message)
                  : new Error(`ripgrep download failed from ${url}: ${message}`)
              }),
              // altimate_change end
            )
            if (bytes.byteLength === 0) throw new Error(`failed to download ripgrep from ${url}`)

            // altimate_change start — upstream_fix: zip extracts in-process, no PowerShell.
            // The staging archive only exists on the tar path, so its cleanup lives there too.
            if (config.extension === "zip") {
              const decoded = yield* unzipExecutable(bytes)
              yield* install(target, (staged) => fs.writeWithDirs(staged, decoded))
            } else {
              const archive = path.join(Global.Path.bin, filename)
              yield* fs.writeWithDirs(archive, new Uint8Array(bytes))
              yield* extractTar(archive, config, target)
              yield* fs.remove(archive, { force: true }).pipe(Effect.ignore)
            }
            // altimate_change end
            return target
          }),
        ),
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
  )

  export const node = LayerNode.make(layer, [FSUtil.node, httpClient, CrossSpawnSpawner.node])
}
