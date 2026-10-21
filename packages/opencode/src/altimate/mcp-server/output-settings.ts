import { readFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { parse } from "jsonc-parser"
import { Flag, env } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@/global"
import { ConfigPaths } from "@/config/paths"
import { git } from "@/util/git"
import { MAX_LINES, MAX_BYTES } from "@/tool/truncate-core"

/** The project's git worktree root, as the agent's Instance resolves it (`Project.fromDirectory`). */
async function projectWorktree(directory: string): Promise<string> {
  const dotgit = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* FSUtil.Service).up({ targets: [".git"], start: directory })
    }).pipe(
      Effect.provide(FSUtil.defaultLayer),
      Effect.orElseSucceed(() => [] as string[]),
    ),
  )
  if (!dotgit[0]) return "/"
  const sandbox = path.dirname(dotgit[0])
  const result = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: sandbox })
  const common = result.exitCode === 0 ? result.text().replace(/[\r\n]+$/, "") : ""
  if (!common) return sandbox
  const resolved = path.resolve(sandbox, common)
  return resolved === sandbox ? sandbox : path.dirname(resolved)
}

/**
 * Read only output settings: loading the full agent config can install dependencies or fetch remote
 * configuration, neither of which belongs in this standalone server. The files, their order and the
 * `ALTIMATE_CLI_*` / `OPENCODE_*` variables are the agent loader's (`config/config.ts`), through the
 * same `ConfigPaths` and `Flag` helpers, so one config resolves to the same limits in both.
 */
export async function outputLimits() {
  const directory = process.cwd()
  const limits = { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
  const apply = (text: string) => {
    const output = parse(text)?.tool_output
    if (Number.isInteger(output?.max_lines) && output.max_lines > 0) limits.maxLines = output.max_lines
    if (Number.isInteger(output?.max_bytes) && output.max_bytes > 0) limits.maxBytes = output.max_bytes
  }
  // A missing or unreadable file contributes nothing; output limits never stop the server from starting.
  const load = async (file: string) => {
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text) apply(text)
  }
  const worktree = await projectWorktree(directory)
  const discover = <A>(effect: Effect.Effect<A, unknown, FSUtil.Service>, fallback: A) =>
    Effect.runPromise(effect.pipe(Effect.provide(FSUtil.defaultLayer), Effect.orElseSucceed(() => fallback)))

  for (const name of ["config.json", "opencode.json", "opencode.jsonc", "altimate-code.json", "altimate-code.jsonc"]) {
    await load(path.join(Global.Path.config, name))
  }
  const custom = env("OPENCODE_CONFIG")
  if (custom) await load(custom)
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    for (const file of await discover(ConfigPaths.files("opencode", directory, worktree), [] as string[])) {
      await load(file)
    }
  }
  const configDir = Flag.OPENCODE_CONFIG_DIR
  for (const dir of await discover(ConfigPaths.directories(directory, worktree), [] as string[])) {
    if (!dir.endsWith(".altimate-code") && !dir.endsWith(".opencode") && dir !== configDir) continue
    for (const name of ["altimate-code.json", "altimate-code.jsonc", "opencode.json", "opencode.jsonc"]) {
      await load(path.join(dir, name))
    }
  }
  const content = env("OPENCODE_CONFIG_CONTENT")
  if (content) apply(content)
  return limits
}
