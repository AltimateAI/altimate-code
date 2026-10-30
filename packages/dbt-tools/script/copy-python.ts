import { cpSync, existsSync, readFileSync } from "fs"
import { dirname, join } from "path"

const dist = join(import.meta.dir, "..", "dist")

// 1. Copy altimate_python_packages
const resolved = require.resolve("@altimateai/dbt-integration")
const source = join(dirname(resolved), "altimate_python_packages")
cpSync(source, join(dist, "altimate_python_packages"), { recursive: true })
console.log(`Copied altimate_python_packages → dist/`)

// 2. Copy node_python_bridge.py into dist so it lives next to index.js
// node_python_bridge.py is shipped in dbt-integration's dist
const bridgePy = join(dirname(resolved), "node_python_bridge.py")
if (!existsSync(bridgePy)) {
  console.error(`ERROR: node_python_bridge.py not found at ${bridgePy}`)
  console.error(`  Is @altimateai/dbt-integration up to date?`)
  process.exit(1)
}
cpSync(bridgePy, join(dist, "node_python_bridge.py"))
console.log(`Copied node_python_bridge.py → dist/`)

// 3. dbt-integration resolves node_python_bridge.py at runtime from its own
//    location (`fileURLToPath(import.meta.url)`), which in this bundle is dist/,
//    where step 2 put the script. This only checks that the bundle still has
//    the references that path is built from and no path baked in at build time;
//    test/build-integrity.test.ts runs the packaged CLI from another directory
//    to check where the script is found.
const indexPath = join(dist, "index.js")
const code = readFileSync(indexPath, "utf8")
const baked = /var __dirname\s*=\s*"(?:[A-Za-z]:\\\\|\/)/
if (!code.includes("fileURLToPath(import.meta.url)") || !code.includes(`"node_python_bridge.py"`) || baked.test(code)) {
  console.error(`ERROR: dist/index.js lacks the references the bridge path is built from, or has a build-time path`)
  console.error(`  Has the @altimateai/dbt-integration bundle format changed?`)
  process.exit(1)
}
console.log(`Checked dist/index.js: bridge path references present, no build-time path`)
