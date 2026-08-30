/**
 * Compiled-binary probe for warehouse store path resolution.
 *
 * This entrypoint is compiled with `bun build --compile` using the same
 * options the production binary uses (see packages/opencode/script/build.ts):
 * bundled sources, `duckdb` left external, no bunfig/dotenv autoload. It then
 * reproduces the exact `--dir` handling of `altimate-code run`
 * (packages/opencode/src/cli/cmd/run.ts) — `process.chdir(args.dir)` — before
 * touching the connection registry.
 *
 * Running it from an unrelated cwd is the only way to observe the real
 * resolution behaviour: a `bun test` run keeps the package's own node_modules
 * reachable and its cwd is not the rig's, so it cannot see this defect.
 *
 * Output is a single line of JSON so the harness can assert on it.
 */

import * as Registry from "../../../src/altimate/native/connections/registry"

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1 || idx === process.argv.length - 1) return undefined
  return process.argv[idx + 1]
}

async function main() {
  // Load the native duckdb addon before any chdir. In the shipped binary the
  // `bin/altimate` wrapper makes `duckdb` resolvable via NODE_PATH; here it is
  // bundled, and Bun locates its embedded `.node` relative to the startup cwd.
  // Warming the module cache first keeps that resolution out of the experiment —
  // the behaviour under test (path resolution and create-on-open) all happens
  // inside `new duckdb.Database(...)`, well after this point.
  await import("duckdb").catch(() => {})

  const connection = arg("connection") ?? "probe"
  const schema = arg("schema") ?? "main"

  const read = async () => {
    const connector = await Registry.get(connection)
    const tables = await connector.listTables(schema)
    await connector.close()
    return tables.map((t) => t.name).sort()
  }

  // `--instance-dir` models a server or `run --attach` request: the working
  // directory stays where the process started and the project arrives through
  // the instance context instead (server.ts wraps every request this way).
  // `--dir` models the local `run --dir` path, which chdirs (run.ts).
  const instanceDir = arg("instance-dir")
  const dir = arg("dir")
  if (!instanceDir && dir) process.chdir(dir)

  try {
    const tables = instanceDir
      ? await (
          await import("../../../src/project/instance")
        ).Instance.provide({
          directory: instanceDir,
          fn: read,
        })
      : await read()
    console.log(JSON.stringify({ ok: true, cwd: process.cwd(), tables }))
  } catch (e) {
    console.log(
      JSON.stringify({
        ok: false,
        cwd: process.cwd(),
        error: e instanceof Error ? e.message : String(e),
      }),
    )
  }
}

await main()
// The duckdb native addon keeps handles alive; exit explicitly.
process.exit(0)
