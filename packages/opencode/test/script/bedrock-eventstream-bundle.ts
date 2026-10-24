// Usage: bun bedrock-eventstream-bundle.ts <outdir> <plugin|none>
// Bundles the probe with the release build's resolution conditions. Runs in its own process because
// Bun.build does not tolerate a second differently-configured build over the same graph in-process.
import path from "node:path"
import { smithyNodeSerdePlugin } from "../../script/smithy-node-serde-plugin"

const [outdir, mode] = process.argv.slice(2)
const root = path.resolve(import.meta.dir, "../..")
const built = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "bedrock-eventstream-probe.ts")],
  outdir,
  conditions: ["browser"],
  target: "bun",
  tsconfig: path.join(root, "tsconfig.json"),
  plugins: mode === "plugin" ? [smithyNodeSerdePlugin()] : [],
})
if (!built.success) {
  console.error(built.logs.join("\n"))
  process.exit(1)
}
