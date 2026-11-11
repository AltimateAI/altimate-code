import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { delimiter, join } from "path"

/** What the stand-in prints on stdout when it runs the bridge, as dbt's own log lines do. */
export const BRIDGE_STDOUT = "stand-in bridge stdout"
/** What it prints on stderr, as a crash at bridge startup does. */
export const BRIDGE_STDERR = "stand-in bridge stderr"

/**
 * A stand-in `python` in `root` that records what it is asked to run and answers
 * the CLI's prerequisite checks. Every other run, the bridge's included, prints those
 * two lines and exits 3, so a test follows startup as far as spawning the bridge
 * without Python or dbt installed. It is a `#!/bin/sh` script, so the tests that use it
 * skip Windows.
 */
export function standInPython(root: string) {
  const argvLog = join(root, "argv.log")
  const python = join(root, "python")
  writeFileSync(
    python,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${argvLog.replaceAll("'", "'\\''")}'`,
      'case "$1" in',
      '  --version) echo "Python 3.11.9"; exit 0 ;;',
      '  -c) echo "1.10.0"; exit 0 ;;',
      "esac",
      `echo '${BRIDGE_STDOUT}'`,
      `echo '${BRIDGE_STDERR}' >&2`,
      "exit 3",
    ].join("\n") + "\n",
  )
  chmodSync(python, 0o755)
  const runs = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").split("\n") : [])
  return { python, runs }
}

/**
 * A `PATH` with a stand-in dbt Cloud CLI in front. dbt Cloud mode starts its engine only on a
 * `dbt` that says it is that CLI; every other command fails, as it does without credentials.
 */
export function pathWithDbtCloudCli(root: string) {
  const bin = join(root, "dbt-cloud-cli")
  mkdirSync(bin)
  const dbt = join(bin, "dbt")
  writeFileSync(
    dbt,
    ["#!/bin/sh", 'case "$1" in', '  --version) echo "dbt Cloud CLI - 0.40.16"; exit 0 ;;', "esac", "exit 1"].join(
      "\n",
    ) + "\n",
  )
  chmodSync(dbt, 0o755)
  return `${bin}${delimiter}${process.env.PATH}`
}
