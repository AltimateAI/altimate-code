import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { downloadWithResume, type DownloadProgress } from "./fetch"
import { ensureLocalDirectories, getLocalPaths, type LocalPaths } from "./paths"

const execFileAsync = promisify(execFile)

export const LLAMA_CPP_REF = "b10516"

interface RuntimeAsset {
  file: string
  sha256: string
}

// sha256 digests from the ggml-org/llama.cpp b10516 GitHub release assets.
// Linux uses the Vulkan builds: the release publishes no CUDA binaries, and
// Vulkan runs on NVIDIA/AMD/Intel GPUs alike.
export const RUNTIME_ASSETS: Record<string, RuntimeAsset> = {
  "darwin-arm64": {
    file: `llama-${LLAMA_CPP_REF}-bin-macos-arm64.tar.gz`,
    sha256: "ee3324327d621026ae80c24031670e65fa62a0b23a3a027dbe2f65f240affd30",
  },
  "linux-x64": {
    file: `llama-${LLAMA_CPP_REF}-bin-ubuntu-vulkan-x64.tar.gz`,
    sha256: "5ce186720f43c415465869b0cd93973b828b219cbf6fbcc22aa899531973c505",
  },
  "linux-arm64": {
    file: `llama-${LLAMA_CPP_REF}-bin-ubuntu-vulkan-arm64.tar.gz`,
    sha256: "760c434827e76342f1d2cf9d1e48b318e7805e7965587ffdbc324b516d955510",
  },
  // Windows support is EXPERIMENTAL: asset pinned and unpack path wired, but
  // not yet smoke-tested on real hardware; doctor labels it accordingly.
  "win32-x64": {
    file: `llama-${LLAMA_CPP_REF}-bin-win-vulkan-x64.zip`,
    sha256: "530f57d2a874ce017827c1e5a926812b9d5de4667248575d1372b1c0acf94d83",
  },
}

const BIN_NAME = process.platform === "win32" ? "llama-server.exe" : "llama-server"

export interface RuntimeInfo {
  path: string
  version: string
  source: "override" | "installed" | "path" | "download"
}

async function executable(file: string) {
  return fs
    .access(file, constants.X_OK)
    .then(() => true)
    .catch(() => false)
}

function pathCandidates(env: NodeJS.ProcessEnv) {
  const delimiter = process.platform === "win32" ? ";" : ":"
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, BIN_NAME))
}

export async function runtimeVersion(file: string) {
  // The first exec right after archive extraction can fail while the dylibs
  // beside the binary are still being flushed; one delayed retry covers it.
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      const result = await execFileAsync(file, ["--version"], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        // Linux release tarballs ship libllama-common.so.* beside the binary;
        // unlike macOS @rpath, the Linux loader does not search that directory.
        env: { ...process.env, LD_LIBRARY_PATH: [path.dirname(file), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
      })
      const output = `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      return output || "unknown"
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `Could not read llama-server version from ${file}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

export async function locateLlamaServer(
  options: {
    env?: NodeJS.ProcessEnv
    paths?: LocalPaths
  } = {},
): Promise<RuntimeInfo | undefined> {
  const env = options.env ?? process.env
  const paths = options.paths ?? getLocalPaths(env)
  const override = env.ALTIMATE_LOCAL_LLAMA_SERVER
  if (override) {
    if (!(await executable(override))) throw new Error(`ALTIMATE_LOCAL_LLAMA_SERVER is not executable: ${override}`)
    return { path: override, version: await runtimeVersion(override), source: "override" }
  }

  const installed = [path.join(paths.bin, LLAMA_CPP_REF, BIN_NAME), path.join(paths.bin, BIN_NAME)]
  for (const candidate of installed) {
    if (await executable(candidate)) {
      // A present-but-broken install (crashes on --version, e.g. missing
      // shared libs) must count as "not found" so the reinstall fallback
      // actually runs; a thrown rejection here escapes the ?? fallback.
      const version = await runtimeVersion(candidate).catch(() => undefined)
      if (version) return { path: candidate, version, source: "installed" }
    }
  }
  for (const candidate of pathCandidates(env)) {
    if (await executable(candidate)) {
      const version = await runtimeVersion(candidate).catch(() => undefined)
      if (version) return { path: candidate, version, source: "path" }
    }
  }
  return undefined
}

export function runtimeAsset(options: { platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv }) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const asset = RUNTIME_ASSETS[`${platform}-${arch}`]
  if (!asset) throw new Error(`No Phase 1 llama.cpp runtime is available for ${platform}-${arch}`)
  const file = env.ALTIMATE_LOCAL_RUNTIME_URL
    ? path.basename(new URL(env.ALTIMATE_LOCAL_RUNTIME_URL).pathname)
    : asset.file
  const url =
    env.ALTIMATE_LOCAL_RUNTIME_URL ||
    `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_REF}/${asset.file}`
  const sha256 = env.ALTIMATE_LOCAL_RUNTIME_SHA256 || asset.sha256
  return { file, url, sha256 }
}

async function findFile(directory: string, name: string): Promise<string | undefined> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isFile() && entry.name === name) return target
    if (entry.isDirectory()) {
      const nested = await findFile(target, name)
      if (nested) return nested
    }
  }
  return undefined
}

export async function installLlamaServer(
  options: {
    env?: NodeJS.ProcessEnv
    paths?: LocalPaths
    platform?: NodeJS.Platform
    arch?: string
    fetchImpl?: typeof fetch
    onProgress?: (progress: DownloadProgress) => void
  } = {},
): Promise<RuntimeInfo> {
  const env = options.env ?? process.env
  const paths = options.paths ?? getLocalPaths(env)
  await ensureLocalDirectories(paths)
  const asset = runtimeAsset({ platform: options.platform, arch: options.arch, env })
  const archive = path.join(paths.downloads, asset.file)
  await downloadWithResume({
    url: asset.url,
    destination: archive,
    sha256: asset.sha256,
    fetchImpl: options.fetchImpl,
    onProgress: options.onProgress,
  })

  const extraction = path.join(paths.root, `.runtime-extract-${process.pid}-${Date.now()}`)
  const staging = path.join(paths.bin, `.${LLAMA_CPP_REF}-${process.pid}-${Date.now()}`)
  const target = path.join(paths.bin, LLAMA_CPP_REF)
  await fs.mkdir(extraction, { recursive: true })
  try {
    if (archive.endsWith(".zip")) {
      // Windows release assets are zips; bsdtar (present on win10+/macOS/linux)
      // handles them with the same CLI surface.
      await execFileAsync("tar", ["-xf", archive, "-C", extraction], { timeout: 120_000 })
    } else {
      await execFileAsync("tar", ["-xzf", archive, "-C", extraction], { timeout: 120_000 })
    }
    const binary = await findFile(extraction, BIN_NAME)
    if (!binary) throw new Error(`Runtime archive ${asset.file} does not contain llama-server`)
    // verbatimSymlinks: without it fs.cp resolves the archive's RELATIVE
    // lib symlinks (libllama-common.so.0 -> .so.0.1.2) into absolute paths
    // under the temporary extraction dir, which is deleted below — leaving
    // every versioned .so dangling on Linux.
    await fs.cp(path.dirname(binary), staging, { recursive: true, verbatimSymlinks: true })
    await fs.chmod(path.join(staging, BIN_NAME), 0o755)
    if (await executable(path.join(target, BIN_NAME))) {
      await fs.rm(staging, { recursive: true, force: true })
    } else {
      await fs.rm(target, { recursive: true, force: true })
      await fs.rename(staging, target)
    }
  } finally {
    await fs.rm(extraction, { recursive: true, force: true })
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }

  const binary = path.join(target, BIN_NAME)
  if (!(await executable(binary))) throw new Error(`Installed runtime is not executable: ${binary}`)
  return { path: binary, version: await runtimeVersion(binary), source: "download" }
}

export async function ensureLlamaServer(options: Parameters<typeof installLlamaServer>[0] = {}) {
  return (await locateLlamaServer(options)) ?? installLlamaServer(options)
}
