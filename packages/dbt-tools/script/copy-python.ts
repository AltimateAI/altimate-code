import { cpSync } from "fs"
import { dirname, join } from "path"

const resolved = require.resolve("@altimateai/dbt-integration")
const source = join(dirname(resolved), "altimate_python_packages")
const target = join(import.meta.dir, "..", "dist", "altimate_python_packages")

cpSync(source, target, { recursive: true })
console.log(`Copied altimate_python_packages → dist/`)
