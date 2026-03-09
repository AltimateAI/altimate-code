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
  const v = `altimate-code v${version} installed`
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

  console.log(top)
  console.log(empty)
  console.log(row(` ${v}`))
  for (const line of lines) console.log(row(line))
  console.log(bot)
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
      console.log("Windows detected: binary setup not needed (using packaged .exe)")
      if (version) printWelcome(version)
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
    if (version) printWelcome(version)
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
