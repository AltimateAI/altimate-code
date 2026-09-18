import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { Global } from "../../global"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Filesystem } from "../../util/filesystem"
import { Process } from "../../util/process"

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  dryRun: boolean
  force: boolean
}

interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfig: string | null
  binary: string | null
}

export const UninstallCommand = {
  command: "uninstall",
  // altimate_change start — upstream_fix: branding regression in describe text
  describe: "uninstall altimate-code and remove all related files",
  // altimate_change end
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep session data and snapshots",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Uninstall Altimate Code")

    const method = await Installation.method()
    prompts.log.info(`Installation method: ${method}`)

    // altimate_change start — #1305: refuse BEFORE removing anything when we cannot tell what
    // installed this binary.
    //
    // `unknown` means detection could not confirm an owner. The removal targets below always
    // include data, config, cache and state, while the binary and the package-manager entry
    // are only removed for a known method — so proceeding here wiped everything the user
    // cares about and left the installation running, with no indication that had happened.
    // Data loss with nothing uninstalled is strictly worse than declining.
    if (method === "unknown") {
      const win = process.platform === "win32"
      const standalone = win ? "%USERPROFILE%\\.altimate\\bin" : "~/.altimate/bin"
      prompts.log.error(`Cannot determine how altimate was installed (running from ${process.execPath}).`)
      prompts.log.info("Uninstalling now would delete your data and config while leaving the program installed.")
      prompts.log.info("Remove the program with whichever tool installed it — each has its own syntax:")
      prompts.log.info("  npm:       npm uninstall -g altimate-code")
      prompts.log.info("  pnpm:      pnpm uninstall -g altimate-code")
      prompts.log.info("  bun:       bun remove -g altimate-code")
      prompts.log.info("  yarn:      yarn global remove altimate-code")
      prompts.log.info("  Homebrew:  brew uninstall altimate-code")
      prompts.log.info(`  installer: delete the binary from ${standalone}`)
      prompts.log.info("If you installed the scoped package, use @altimateai/altimate-code as the name instead.")
      // Do not tell the user to "re-run" this command: once the package is gone, so is the
      // binary that would run it. Name the directories so data can be cleaned up by hand.
      prompts.log.info("Then delete these directories to remove data, config, cache and state:")
      for (const dir of [Global.Path.data, Global.Path.config, Global.Path.cache, Global.Path.state]) {
        prompts.log.info(`  ${dir}`)
      }
      prompts.outro("Nothing was removed")
      return
    }
    // altimate_change end

    // altimate_change start — #1305: the package the MANAGER confirms owns this binary.
    // publish.ts ships both a scoped and an unscoped wrapper; removing the wrong one removes
    // nothing while uninstall goes on to delete config and cache.
    //
    // No `?? "@altimateai/altimate-code"` default here. A package-manager method is only
    // returned once ownership was confirmed, so a missing name alongside one of those methods
    // is a contradiction, not a case to guess through — and guessing is precisely what made an
    // earlier revision delete a user's data and then remove a package that was not installed.
    const pkg = await Installation.packageName()
    const managed = method === "npm" || method === "pnpm" || method === "bun" || method === "yarn"
    if (managed && !pkg) {
      prompts.log.error(`Detected a ${method} installation but could not confirm which package owns it.`)
      prompts.log.info("Nothing was removed. Remove the package with your package manager, then delete:")
      for (const dir of [Global.Path.data, Global.Path.config, Global.Path.cache, Global.Path.state]) {
        prompts.log.info(`  ${dir}`)
      }
      prompts.outro("Nothing was removed")
      return
    }
    const targets = await collectRemovalTargets(args, method)
    await showRemovalSummary(targets, method, pkg ?? "altimate-code")
    // altimate_change end

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: "Are you sure you want to uninstall?",
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn("Dry run - no changes made")
      prompts.outro("Done")
      return
    }

    // altimate_change start — #1305: pass the verified package name through so removal
    // targets the wrapper the user actually installed.
    await executeUninstall(method, targets, pkg ?? "altimate-code")
    // altimate_change end

    prompts.outro("Done")
  },
}

async function collectRemovalTargets(args: UninstallArgs, method: Installation.Method): Promise<RemovalTargets> {
  const directories: RemovalTargets["directories"] = [
    { path: Global.Path.data, label: "Data", keep: args.keepData },
    { path: Global.Path.cache, label: "Cache", keep: false },
    { path: Global.Path.config, label: "Config", keep: args.keepConfig },
    { path: Global.Path.state, label: "State", keep: false },
  ]

  const shellConfig = method === "curl" ? await getShellConfigFile() : null
  const binary = method === "curl" ? process.execPath : null

  return { directories, shellConfig, binary }
}

// altimate_change start — #1305: takes the verified package name so the summary prints the
// command that will actually run.
async function showRemovalSummary(targets: RemovalTargets, method: Installation.Method, pkg: string) {
  // altimate_change end
  prompts.log.message("The following will be removed:")

  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(keeping)" : ""
    const prefix = dir.keep ? "○" : "✓"

    prompts.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.binary) {
    prompts.log.info(`  ✓ Binary: ${shortenPath(targets.binary)}`)
  }

  if (targets.shellConfig) {
    prompts.log.info(`  ✓ Shell PATH in ${shortenPath(targets.shellConfig)}`)
  }

  if (method !== "curl" && method !== "unknown") {
    // altimate_change start — #1305: these targeted upstream's `opencode-ai` / `opencode`,
    // so an uninstall could remove an unrelated upstream package while leaving Altimate
    // installed. scoop/choco are omitted: Installation.method() no longer returns them
    // (their commands still reference upstream identities), so they are unreachable here.
    const cmds: Record<string, string> = {
      npm: `npm uninstall -g ${pkg}`,
      pnpm: `pnpm uninstall -g ${pkg}`,
      bun: `bun remove -g ${pkg}`,
      yarn: `yarn global remove ${pkg}`,
      brew: "brew uninstall altimate-code",
    }
    // altimate_change end
    prompts.log.info(`  ✓ Package: ${cmds[method] || method}`)
  }
}

// altimate_change start — #1305: takes the verified package name so removal targets the
// wrapper the user actually installed.
async function executeUninstall(method: Installation.Method, targets: RemovalTargets, pkg: string) {
  // altimate_change end
  const spinner = prompts.spinner()
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(`Skipping ${dir.label} (--keep-${dir.label.toLowerCase()})`)
      continue
    }

    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    spinner.start(`Removing ${dir.label}...`)
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.stop(`Failed to remove ${dir.label}`, 1)
      errors.push(`${dir.label}: ${err.message}`)
      continue
    }
    spinner.stop(`Removed ${dir.label}`)
  }

  if (targets.shellConfig) {
    spinner.start("Cleaning shell config...")
    const err = await cleanShellConfig(targets.shellConfig).catch((e) => e)
    if (err) {
      spinner.stop("Failed to clean shell config", 1)
      errors.push(`Shell config: ${err.message}`)
    } else {
      spinner.stop("Cleaned shell config")
    }
  }

  if (method !== "curl" && method !== "unknown") {
    // altimate_change start — #1305: Altimate package identities, not upstream's.
    const cmds: Record<string, string[]> = {
      npm: ["npm", "uninstall", "-g", pkg],
      pnpm: ["pnpm", "uninstall", "-g", pkg],
      bun: ["bun", "remove", "-g", pkg],
      yarn: ["yarn", "global", "remove", pkg],
      brew: ["brew", "uninstall", "altimate-code"],
    }
    // altimate_change end

    const cmd = cmds[method]
    if (cmd) {
      spinner.start(`Running ${cmd.join(" ")}...`)
      // altimate_change start — #1305: the choco special-case here passed a hardcoded
      // `["choco","uninstall","opencode",...]`; choco is no longer a reachable method (see
      // the command map above), so the branch is gone and `cmd` is used directly.
      const result = await Process.run(cmd, {
        nothrow: true,
      })
      // altimate_change end
      if (result.code !== 0) {
        spinner.stop(`Package manager uninstall failed: exit code ${result.code}`, 1)
        const text = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`
        if (method === "choco" && text.includes("not running from an elevated command shell")) {
          prompts.log.warn(`You may need to run '${cmd.join(" ")}' from an elevated command shell`)
        } else {
          prompts.log.warn(`You may need to run manually: ${cmd.join(" ")}`)
        }
      } else {
        spinner.stop("Package removed")
      }
    }
  }

  if (method === "curl" && targets.binary) {
    UI.empty()
    prompts.log.message("To finish removing the binary, run:")
    prompts.log.info(`  rm "${targets.binary}"`)

    const binDir = path.dirname(targets.binary)
    if (binDir.includes(".opencode")) {
      prompts.log.info(`  rmdir "${binDir}" 2>/dev/null`)
    }
  }

  if (errors.length > 0) {
    UI.empty()
    prompts.log.warn("Some operations failed:")
    for (const err of errors) {
      prompts.log.error(`  ${err}`)
    }
  }

  UI.empty()
  prompts.log.success("Thank you for using Altimate Code!")
}

async function getShellConfigFile(): Promise<string | null> {
  const shell = path.basename(process.env.SHELL || "bash")
  const home = os.homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config")

  const configFiles: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish")],
    zsh: [
      path.join(home, ".zshrc"),
      path.join(home, ".zshenv"),
      path.join(xdgConfig, "zsh", ".zshrc"),
      path.join(xdgConfig, "zsh", ".zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdgConfig, "bash", ".bashrc"),
      path.join(xdgConfig, "bash", ".bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".profile")],
  }

  const candidates = configFiles[shell] || configFiles.bash

  for (const file of candidates) {
    const exists = await fs
      .access(file)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const content = await Filesystem.readText(file).catch(() => "")
    if (content.includes("# opencode") || content.includes(".opencode/bin")) {
      return file
    }
  }

  return null
}

async function cleanShellConfig(file: string) {
  const content = await Filesystem.readText(file)
  const lines = content.split("\n")

  const filtered: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === "# opencode") {
      skip = true
      continue
    }

    if (skip) {
      skip = false
      if (trimmed.includes(".opencode/bin") || trimmed.includes("fish_add_path")) {
        continue
      }
    }

    if (
      (trimmed.startsWith("export PATH=") && trimmed.includes(".opencode/bin")) ||
      (trimmed.startsWith("fish_add_path") && trimmed.includes(".opencode"))
    ) {
      continue
    }

    filtered.push(line)
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop()
  }

  const output = filtered.join("\n") + "\n"
  await Filesystem.write(file, output)
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
