import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import * as Effect from "effect/Effect"
import { Flag, env as flagEnv } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "../../global"
import { ConfigPaths } from "@/config/paths"
import { ConfigManaged } from "@/config/managed"
import { validateLoaded } from "@/config/config"

/**
 * Whether the user config turns telemetry off, read without an Instance.
 *
 * `Config.get()` needs an Instance, and the CLI's main thread initialises telemetry in middleware
 * before one exists, so there it throws. Treating that as "enabled" let an opted-out user's main
 * thread clear the opt-out marker and resolve their identity. This reads the same files `Config`
 * merges, in the same order (a later source overrides an earlier one), straight from disk:
 * the global config files (the legacy TOML `config` file included), `OPENCODE_CONFIG`, the project
 * files and `.altimate-code`/`.opencode` directories found from `directory`, the inline
 * `OPENCODE_CONFIG_CONTENT`, the managed config directory and macOS managed preferences. Remote and
 * account configs are not read (they need the network). The read emits no telemetry of its own: it
 * runs before telemetry knows whether it may.
 *
 * - `disabled`: the last source that sets `telemetry.disabled` sets it to `true`.
 * - `enabled`: no source turns it off.
 * - `unreadable`: some source could not be read, parsed or validated as `Config` does (a missing
 *   `{file:}` reference, a value its schema rejects). `Config` would fail to load at all, so the
 *   answer is unknown. Callers fail closed for anything an opt-out forbids.
 */
export type State = "disabled" | "enabled" | "unreadable"

const DIR_FILES = ["altimate-code.json", "altimate-code.jsonc", "opencode.json", "opencode.jsonc"]
const GLOBAL_FILES = ["config.json", "opencode.json", "opencode.jsonc", "altimate-code.json", "altimate-code.jsonc"]

/** The git root above `directory`, which `Config` uses as the stop for its upward search. */
function worktreeOf(directory: string): string | undefined {
  let dir = path.resolve(directory)
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export async function disabledState(directory: string = process.cwd()): Promise<State> {
  try {
    let value: boolean | undefined
    // Any source that fails to read, parse or validate fails Config's whole load, so the answer
    // is unknown however the other sources set it.
    let unknown = false
    const take = (data: unknown) => {
      const disabled = (data as { telemetry?: { disabled?: unknown } } | undefined)?.telemetry?.disabled
      if (disabled === undefined) return
      if (typeof disabled !== "boolean") unknown = true
      else value = disabled
    }
    // Parse as the loader does (a missing `{file:}` reference is an error) and validate with the
    // loader's own schema step, so a source Config would reject cannot set the answer.
    const parse = async (text: string, input: string | { source: string; dir: string }) => {
      if (!text.trim()) return // the loader treats an empty file as `{}`
      const source = typeof input === "string" ? input : input.source
      try {
        take(validateLoaded(await ConfigPaths.parseText(text, input, "error", { track: false }), source))
      } catch {
        unknown = true
      }
    }
    const readFile = async (file: string) => {
      let text: string
      try {
        text = await fs.readFile(file, "utf-8")
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") unknown = true
        return
      }
      await parse(text, file)
    }
    const readText = (text: string, source: string, dir: string) => parse(text, { source, dir })

    for (const file of GLOBAL_FILES) await readFile(path.join(Global.Path.config, file))
    // The legacy TOML global config, which Config merges after the JSON files (and migrates).
    const legacy = path.join(Global.Path.config, "config")
    try {
      take(Bun.TOML.parse(await fs.readFile(legacy, "utf-8")))
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") unknown = true
    }
    if (Flag.OPENCODE_CONFIG) await readFile(Flag.OPENCODE_CONFIG)

    const worktree = worktreeOf(directory)
    const located = await Effect.runPromise(
      Effect.all([
        Flag.OPENCODE_DISABLE_PROJECT_CONFIG
          ? Effect.succeed([] as string[])
          : ConfigPaths.files("opencode", directory, worktree),
        ConfigPaths.directories(directory, worktree),
      ]).pipe(Effect.provide(FSUtil.defaultLayer)),
    )
    const [projectFiles, directories] = located
    for (const file of projectFiles) await readFile(file)
    for (const dir of directories) {
      if (dir.endsWith(".altimate-code") || dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
        for (const file of DIR_FILES) await readFile(path.join(dir, file))
      }
    }

    const inline = flagEnv("OPENCODE_CONFIG_CONTENT")
    if (inline) await readText(inline, "OPENCODE_CONFIG_CONTENT", directory)

    const managedDir = ConfigManaged.managedConfigDir()
    if (existsSync(managedDir)) for (const file of DIR_FILES) await readFile(path.join(managedDir, file))
    const managed = await ConfigManaged.readManagedPreferences().catch(() => {
      unknown = true
      return undefined
    })
    if (managed) await readText(managed.text, managed.source, path.dirname(managed.source))

    if (unknown) return "unreadable"
    return value ? "disabled" : "enabled"
  } catch {
    return "unreadable"
  }
}

export * as TelemetryConfig from "./config-state"
