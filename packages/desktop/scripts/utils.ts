import { $ } from "bun"

// altimate_change start — sidecar maps to OUR build output dir names.
// packages/opencode/script/build.ts emits `dist/${pkg.name}-${os}-${arch}[-baseline]/bin/altimate`
// where pkg.name = "@altimateai/altimate-code" (vs upstream's "opencode-<os>-<arch>/bin/opencode").
// `ocBinary` is the dist subdir; the binary file inside is `altimate` (see predev.ts/prepare.ts).
export const SIDECAR_BINARIES: Array<{ rustTarget: string; ocBinary: string; assetExt: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    ocBinary: "@altimateai/altimate-code-darwin-arm64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    ocBinary: "@altimateai/altimate-code-darwin-x64-baseline",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    ocBinary: "@altimateai/altimate-code-windows-x64-baseline",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    ocBinary: "@altimateai/altimate-code-linux-x64-baseline",
    assetExt: "tar.gz",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    ocBinary: "@altimateai/altimate-code-linux-arm64",
    assetExt: "tar.gz",
  },
]
// altimate_change end

export const RUST_TARGET = Bun.env.RUST_TARGET

export function getCurrentSidecar(target = RUST_TARGET) {
  if (!target && !RUST_TARGET) throw new Error("RUST_TARGET not set")

  const binaryConfig = SIDECAR_BINARIES.find((b) => b.rustTarget === target)
  if (!binaryConfig) throw new Error(`Sidecar configuration not available for Rust target '${RUST_TARGET}'`)

  return binaryConfig
}

export async function copyBinaryToSidecarFolder(source: string, target = RUST_TARGET) {
  await $`mkdir -p src-tauri/sidecars`
  const dest = windowsify(`src-tauri/sidecars/opencode-cli-${target}`)
  await $`cp ${source} ${dest}`

  console.log(`Copied ${source} to ${dest}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
