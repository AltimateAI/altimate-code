#!/usr/bin/env bun

/**
 * Version bumping for altimate-code packages.
 *
 * The Python engine (altimate-engine) has been eliminated.
 * Versioning is now handled through package.json for TypeScript packages.
 *
 * To bump versions:
 *   - CLI: edit packages/opencode/package.json "version" field
 *   - Drivers: edit packages/drivers/package.json "version" field
 *   - altimate-core: managed in altimate-core-internal repo
 */

console.log("Python engine has been eliminated — no engine version to bump.")
console.log("")
console.log("To bump package versions:")
console.log("  CLI:     edit packages/opencode/package.json")
console.log("  Drivers: edit packages/drivers/package.json")
console.log("  Core:    managed in altimate-core-internal repo")
