// Child process used by test/packages.test.ts: runs ensurePackages against a
// project with a deliberately slow, non-atomic fake `dbt deps`, then reports
// what it observed once ensurePackages returned.
//
// usage: bun packages-worker.ts <projectRoot> <logFile> <pkgName> [crash]
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { ensurePackages } from "../../src/packages"

const [root, log, pkg, mode] = process.argv.slice(2) as [string, string, string, string | undefined]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// What dbt deps does to a package: delete it, re-create the directory, then
// write its files. A reader that looks in between sees a missing or empty package.
async function slowInstall() {
  appendFileSync(log, `install ${process.pid}\n`)
  const dir = join(root, "dbt_packages", pkg)
  rmSync(dir, { recursive: true, force: true })
  await sleep(150)
  mkdirSync(dir, { recursive: true })
  if (mode === "crash") {
    // Die with the package directory present but incomplete.
    process.kill(process.pid, "SIGKILL")
  }
  await sleep(150)
  writeFileSync(join(dir, "dbt_project.yml"), `name: ${pkg}\nversion: '1.0.0'\n`)
  await sleep(50)
}

await ensurePackages(root, slowInstall, { staleMs: 1500, heartbeatMs: 100 })
// This is the moment a real command would go on to read the packages.
const ok = existsSync(join(root, "dbt_packages", pkg, "dbt_project.yml"))
appendFileSync(log, `${ok ? "ready" : "BROKEN"} ${process.pid}\n`)
