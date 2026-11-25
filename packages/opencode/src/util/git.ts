import { Process } from "./process"
// altimate_change start — offline mode refuses Git commands that use the network
import { offlineModeEnabled } from "@opencode-ai/core/flag/flag"
import { GIT_OFFLINE_REFUSAL, gitCommandUsesNetwork } from "@opencode-ai/core/git"
// altimate_change end

export interface GitResult {
  exitCode: number
  text(): string
  stdout: Buffer
  stderr: Buffer
}

/**
 * Run a git command.
 *
 * Uses Process helpers with stdin ignored to avoid protocol pipe inheritance
 * issues in embedded/client environments.
 */
export async function git(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<GitResult> {
  // altimate_change start — offline mode refuses Git commands that use the network
  if (offlineModeEnabled() && gitCommandUsesNetwork(args))
    return { exitCode: 1, text: () => "", stdout: Buffer.alloc(0), stderr: Buffer.from(GIT_OFFLINE_REFUSAL) }
  // altimate_change end
  return Process.run(["git", ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    nothrow: true,
  })
    .then((result) => ({
      exitCode: result.code,
      text: () => result.stdout.toString(),
      stdout: result.stdout,
      stderr: result.stderr,
    }))
    .catch((error) => ({
      exitCode: 1,
      text: () => "",
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(error instanceof Error ? error.message : String(error)),
    }))
}
