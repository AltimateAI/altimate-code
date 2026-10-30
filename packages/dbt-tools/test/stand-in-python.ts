import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

/**
 * A stand-in `python` in `root` that records what it is asked to run and answers
 * the CLI's prerequisite checks. Every other run, the bridge's included, exits 3,
 * so a test follows startup as far as spawning the bridge without Python or dbt
 * installed. It is a `#!/bin/sh` script, so the tests that use it skip Windows.
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
      "exit 3",
    ].join("\n") + "\n",
  )
  chmodSync(python, 0o755)
  const runs = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").split("\n") : [])
  return { python, runs }
}
