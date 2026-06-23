import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

const RUST_TARGET = Bun.env.TAURI_ENV_TARGET_TRIPLE

const sidecarConfig = getCurrentSidecar(RUST_TARGET)

// altimate_change — our single-file binary is named `altimate` (build.ts), not `opencode`.
const binaryPath = windowsify(`../opencode/dist/${sidecarConfig.ocBinary}/bin/altimate`)

await (sidecarConfig.ocBinary.includes("-baseline")
  ? $`cd ../opencode && bun run build --single --baseline`
  : $`cd ../opencode && bun run build --single`)

await copyBinaryToSidecarFolder(binaryPath, RUST_TARGET)
