#!/usr/bin/env node

import fs from "fs"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function detectPlatformAndArch() {
  // Map platform names
  let platform
  switch (os.platform()) {
    case "darwin":
      platform = "darwin"
      break
    case "linux":
      platform = "linux"
      break
    case "win32":
      platform = "windows"
      break
    default:
      platform = os.platform()
      break
  }

  // Map architecture names
  let arch
  switch (os.arch()) {
    case "x64":
      arch = "x64"
      break
    case "arm64":
      arch = "arm64"
      break
    case "arm":
      arch = "arm"
      break
    default:
      arch = os.arch()
      break
  }

  return { platform, arch }
}

function findBinary() {
  const { platform, arch } = detectPlatformAndArch()
  const packageName = `@altimateai/altimate-code-${platform}-${arch}`
  const binaryName = platform === "windows" ? "altimate-code.exe" : "altimate-code"

  try {
    // Use require.resolve to find the package
    const packageJsonPath = require.resolve(`${packageName}/package.json`)
    const packageDir = path.dirname(packageJsonPath)
    const binaryPath = path.join(packageDir, "bin", binaryName)

    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Binary not found at ${binaryPath}`)
    }

    return { binaryPath, binaryName }
  } catch (error) {
    throw new Error(`Could not find package ${packageName}: ${error.message}`)
  }
}

function prepareBinDirectory(binaryName) {
  const binDir = path.join(__dirname, "bin")
  const targetPath = path.join(binDir, binaryName)

  // Ensure bin directory exists
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true })
  }

  // Remove existing binary/symlink if it exists
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath)
  }

  return { binDir, targetPath }
}

function printWelcome(version) {
  const cleanVersion = version.replace(/^v/, "")
  const v = `altimate-code v${cleanVersion} installed`
  const lines = [
    "",
    "  Get started:",
    "    altimate              Open the TUI",
    '    altimate run "hello"  Run a quick task',
    "    altimate --help       See all commands",
    "",
    "  Docs: https://altimate-code.dev",
    "",
  ]
  // Box width: pad all lines to the same length
  const contentWidth = Math.max(v.length, ...lines.map((l) => l.length)) + 2
  const pad = (s) => s + " ".repeat(contentWidth - s.length)
  const top = `  ╭${"─".repeat(contentWidth + 2)}╮`
  const bot = `  ╰${"─".repeat(contentWidth + 2)}╯`
  const empty = `  │ ${" ".repeat(contentWidth)} │`
  const row = (s) => `  │ ${pad(s)} │`

  // Use stderr — npm v7+ silences postinstall stdout
  const out = (s) => process.stderr.write(s + "\n")
  out(top)
  out(empty)
  out(row(` ${v}`))
  for (const line of lines) out(row(line))
  out(bot)
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath)
    } else {
      fs.copyFileSync(srcPath, dstPath)
    }
  }
}

/**
 * Link bundled dbt-tools binary into the package's bin/ directory so it's
 * available alongside the main CLI binary. The wrapper script exports
 * ALTIMATE_BIN_DIR pointing to this directory.
 */
function setupDbtTools() {
  try {
    const dbtBinSrc = path.join(__dirname, "dbt-tools", "bin", "altimate-dbt")
    if (!fs.existsSync(dbtBinSrc)) {
      console.warn(`Bundled altimate-dbt entrypoint missing: ${dbtBinSrc}`)
      return
    }

    const binDir = path.join(__dirname, "bin")
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true })

    const target = path.join(binDir, "altimate-dbt")
    if (fs.existsSync(target)) fs.unlinkSync(target)

    // Prefer symlink (preserves original relative imports), fall back to
    // writing a new wrapper with the correct path from bin/ → dbt-tools/dist/.
    try {
      fs.symlinkSync(dbtBinSrc, target)
    } catch {
      // Direct copy would break the `import("../dist/index.js")` resolution
      // since the script moves from dbt-tools/bin/ → bin/. Write a wrapper instead.
      fs.writeFileSync(target, '#!/usr/bin/env node\nimport("../dbt-tools/dist/index.js")\n')
    }
    fs.chmodSync(target, 0o755)

    // Windows: create .cmd shim since cmd.exe doesn't understand shebangs
    if (os.platform() === "win32") {
      const cmdTarget = path.join(binDir, "altimate-dbt.cmd")
      fs.writeFileSync(cmdTarget, '@echo off\r\nnode "%~dp0\\..\\dbt-tools\\dist\\index.js" %*\r\n')
    }
  } catch (error) {
    console.warn("Failed to setup bundled altimate-dbt:", error)
  }
}

/**
 * Copy bundled skills to ~/.altimate/builtin/ on every install/upgrade.
 * The entire directory is wiped and replaced so each release is the single
 * source of truth. Intentionally separate from ~/.altimate/skills/ which users own.
 */
function copySkillsToAltimate() {
  try {
    const skillsSrc = path.join(__dirname, "skills")
    if (!fs.existsSync(skillsSrc)) return // skills not in package (shouldn't happen)

    const builtinDst = path.join(os.homedir(), ".altimate", "builtin")

    // Full wipe-and-replace — each release owns this directory entirely
    if (fs.existsSync(builtinDst)) fs.rmSync(builtinDst, { recursive: true, force: true })
    copyDirRecursive(skillsSrc, builtinDst)
  } catch {
    // Non-fatal — skills can be installed manually
  }
}

/**
 * Write a marker file so the CLI can show a welcome/upgrade banner on first run.
 * npm v7+ silences postinstall stdout, so the CLI reads this marker at startup instead.
 */
function writeUpgradeMarker(version) {
  try {
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    const dataDir = path.join(xdgData, "altimate-code")
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, ".installed-version"), version.replace(/^v/, ""))
  } catch {
    // Non-fatal — the CLI just won't show a welcome banner
  }
}

async function main() {
  let version
  try {
    const pkgPath = path.join(__dirname, "package.json")
    if (fs.existsSync(pkgPath)) {
      version = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version
    }
  } catch {}

  try {
    if (os.platform() === "win32") {
      // On Windows, the .exe is already included in the package and bin field points to it
      // No postinstall setup needed
      if (version) writeUpgradeMarker(version)
      copySkillsToAltimate()
      setupDbtTools()
      return
    }

    // On non-Windows platforms, just verify the binary package exists
    // Don't replace the wrapper script - it handles binary execution
    const { binaryPath } = findBinary()
    const target = path.join(__dirname, "bin", ".altimate-code")
    if (fs.existsSync(target)) fs.unlinkSync(target)
    try {
      fs.linkSync(binaryPath, target)
    } catch {
      fs.copyFileSync(binaryPath, target)
    }
    fs.chmodSync(target, 0o755)
    // Write marker only — npm v7+ suppresses all postinstall output.
    // The CLI picks up the marker and shows the welcome box on first run.
    if (version) writeUpgradeMarker(version)
    copySkillsToAltimate()
    setupDbtTools()
  } catch (error) {
    console.error("Failed to setup altimate-code binary:", error.message)
    process.exit(1)
  }
}

try {
  main()
} catch (error) {
  console.error("Postinstall script error:", error.message)
  process.exit(0)
}
