// A stand-in `altimate-dbt` on PATH for validator tests that exercise `check()`
// end to end (spawn, parse, decide) without needing dbt. Each call looks up
// `<dir>/<command>-<model>.out` (stdout) and `<dir>/<command>-<model>.code`
// (exit code, default 0) and records the call in `<dir>/calls.log`.
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"

export interface FakeAltimateDbt {
  /** dbt project directory (has dbt_project.yml and models/). */
  project: string
  /** Canned output for `altimate-dbt <command> --model <model>`. */
  respond(command: string, model: string, stdout: string, exitCode?: number): Promise<void>
  /** Different canned output for the 1st, 2nd, ... call; later calls repeat the last entry. */
  respondInSequence(command: string, model: string, responses: Array<{ stdout: string; exitCode?: number }>): Promise<void>
  /** Create a model file and make it look edited during the session. */
  touchModel(model: string): Promise<void>
  /** Commands the validators ran, in order, e.g. "schema-verify tested". */
  calls(): Promise<string[]>
  restore(): Promise<void>
}

export async function installFakeAltimateDbt(): Promise<FakeAltimateDbt> {
  const root = await fs.mkdtemp(join(tmpdir(), "fake-adbt-"))
  const project = join(root, "project")
  const canned = join(root, "canned")
  const bin = join(root, "bin")
  await fs.mkdir(join(project, "models"), { recursive: true })
  await fs.mkdir(canned)
  await fs.mkdir(bin)
  await fs.writeFile(join(project, "dbt_project.yml"), "name: fake\nversion: '1.0'\nconfig-version: 2\nprofile: fake\n")
  const script = `#!/bin/sh
echo "$1 $3" >> "${canned}/calls.log"
f="${canned}/$1-$3"
n=$(( $(cat "$f.n" 2>/dev/null || echo 0) + 1 ))
echo $n > "$f.n"
while [ $n -gt 0 ] && [ ! -f "$f.out.$n" ] && [ ! -f "$f.out" ]; do n=$((n - 1)); done
if [ -f "$f.out.$n" ]; then s="$f.out.$n"; c="$f.code.$n"; else s="$f.out"; c="$f.code"; fi
[ -f "$s" ] && cat "$s"
if [ -f "$c" ]; then exit "$(cat "$c")"; fi
exit 0
`
  await fs.writeFile(join(bin, "altimate-dbt"), script, { mode: 0o755 })
  const originalPath = process.env.PATH ?? ""
  process.env.PATH = `${bin}:${originalPath}`
  return {
    project,
    async respond(command, model, stdout, exitCode = 0) {
      await fs.writeFile(join(canned, `${command}-${model}.out`), stdout)
      await fs.writeFile(join(canned, `${command}-${model}.code`), String(exitCode))
    },
    async respondInSequence(command, model, responses) {
      for (let i = 0; i < responses.length; i++) {
        await fs.writeFile(join(canned, `${command}-${model}.out.${i + 1}`), responses[i]!.stdout)
        await fs.writeFile(join(canned, `${command}-${model}.code.${i + 1}`), String(responses[i]!.exitCode ?? 0))
      }
    },
    async touchModel(model) {
      const file = join(project, "models", `${model}.sql`)
      await fs.writeFile(file, "select 1 as id")
      const t = Date.now() / 1000 + 5
      await fs.utimes(file, t, t)
    },
    async calls() {
      try {
        return (await fs.readFile(join(canned, "calls.log"), "utf8")).trim().split("\n").filter(Boolean)
      } catch {
        return []
      }
    },
    async restore() {
      process.env.PATH = originalPath
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

export const ctxFor = (project: string) => ({
  sessionID: "unit",
  workingDirectory: project,
  sessionStartMs: Date.now() - 60_000,
  step: 1,
  retryCount: 0,
})
