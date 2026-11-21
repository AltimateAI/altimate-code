import type { ChildProcessWithoutNullStreams } from "child_process"
import { Process } from "@/util/process"
// altimate_change start — offline mode user environment
import { Offline } from "@/config/offline"
// altimate_change end

type Child = Process.Child & ChildProcessWithoutNullStreams

export function spawn(cmd: string, args: string[], opts?: Process.Options): Child
export function spawn(cmd: string, opts?: Process.Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const proc = Process.spawn([cmd, ...args], {
    ...cfg,
    // altimate_change start — offline mode keeps the user's proxy settings for language servers
    // Process.spawn merges process.env underneath, so a removed key is set to undefined (unset) instead.
    ...(Offline.enabled() && cfg?.env !== null
      ? {
          env: {
            NO_PROXY: undefined,
            no_proxy: undefined,
            ALTIMATE_OFFLINE_USER_PROXY: undefined,
            ...Offline.userEnv({ ...process.env, ...cfg?.env }),
            // After the spread: Process.spawn merges process.env underneath, so the key must be unset explicitly.
            ALTIMATE_OFFLINE_MODEL: undefined,
          },
        }
      : {}),
    // altimate_change end
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Child

  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")

  return proc
}
