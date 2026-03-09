#!/usr/bin/env bun

import fs from "fs"
import path from "path"
import { parseArgs } from "util"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    engine: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
})

const root = path.resolve(import.meta.dir, "../../..")
const dryRun = values["dry-run"]

if (values.engine) {
  const version = values.engine

  // Validate semver-ish
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`Invalid version: ${version}`)
    process.exit(1)
  }

  // Update pyproject.toml
  const pyprojectPath = path.join(root, "packages/altimate-engine/pyproject.toml")
  let pyproject = fs.readFileSync(pyprojectPath, "utf-8")
  const oldPyVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  pyproject = pyproject.replace(/^(version\s*=\s*")([^"]+)(")/m, `$1${version}$3`)

  // Update __init__.py
  const initPath = path.join(root, "packages/altimate-engine/src/altimate_engine/__init__.py")
  let init = fs.readFileSync(initPath, "utf-8")
  const oldInitVersion = init.match(/__version__\s*=\s*"([^"]+)"/)?.[1]
  init = init.replace(/(__version__\s*=\s*")([^"]+)(")/, `$1${version}$3`)

  if (dryRun) {
    console.log(`[dry-run] pyproject.toml: ${oldPyVersion} → ${version}`)
    console.log(`[dry-run] __init__.py: ${oldInitVersion} → ${version}`)
  } else {
    fs.writeFileSync(pyprojectPath, pyproject)
    fs.writeFileSync(initPath, init)
    console.log(`pyproject.toml: ${oldPyVersion} → ${version}`)
    console.log(`__init__.py: ${oldInitVersion} → ${version}`)
  }
}

if (!values.engine) {
  console.log("Usage:")
  console.log("  bun run bump-version.ts --engine 0.2.0    # Set engine version")
  console.log("")
  console.log("Options:")
  console.log("  --dry-run    Show changes without writing")
  process.exit(0)
}
