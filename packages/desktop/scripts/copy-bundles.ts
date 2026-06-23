import { $, Glob } from "bun"
import * as path from "node:path"

import { RUST_TARGET } from "./utils"

if (!RUST_TARGET) throw new Error("RUST_TARGET not defined")

const BUNDLE_DIR = `src-tauri/target/${RUST_TARGET}/release/bundle`
const BUNDLES_OUT_DIR = path.join(process.cwd(), `src-tauri/target/bundles`)

await $`mkdir -p ${BUNDLES_OUT_DIR}`

// altimate_change start — match OUR product name ("Altimate Code", "Altimate Code Beta",
// "Altimate Code Dev"). The name contains a space, so a bare shell glob (`*/Altimate Code*`)
// would word-split; use Bun.Glob and copy each match with the path passed as a single arg.
const glob = new Glob("*/Altimate Code*")
let copied = 0
for await (const rel of glob.scan({ cwd: BUNDLE_DIR, onlyFiles: false, followSymlinks: false })) {
  await $`cp -R ${path.join(BUNDLE_DIR, rel)} ${BUNDLES_OUT_DIR}/`
  copied++
}
if (copied === 0) throw new Error(`No "Altimate Code*" bundles found under ${BUNDLE_DIR}`)
console.log(`Copied ${copied} bundle artifact(s) to ${BUNDLES_OUT_DIR}`)
// altimate_change end
