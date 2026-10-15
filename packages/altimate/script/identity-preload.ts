// Source-only opt-in: bun --preload ./packages/altimate/script/identity-preload.ts ...
// Keep the type import erased so identity-dependent modules initialize after this assignment.
import type { Descriptor } from "../../util/src/identity.js"
import descriptor from "../identity.json"

globalThis.__OPENCODE_IDENTITY__ = descriptor satisfies Descriptor

// Load only the lazy definitions after identity is selected, before any host modules initialize.
const { default: contributions } = await import("../host")
globalThis.__OPENCODE_HOST_PLUGINS__ = contributions
