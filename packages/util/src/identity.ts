// altimate: ALT-F01
// This module must stay dependency-free: roots and locks consume it during module initialization.
export type Descriptor = {
  readonly app: string
  readonly displayName: string
  readonly userAgent: string
  readonly envPrefixes: readonly string[]
  readonly configBasenames: readonly string[]
  readonly servicePort: number
  readonly serviceName: string
  readonly logo: { readonly left: readonly string[]; readonly right: readonly string[] }
  readonly narrowLogo: { readonly left: readonly string[]; readonly right: readonly string[] }
  readonly title: { readonly home: string; readonly prefix: string }
  // altimate: ALT-F02 - module path relative to the descriptor, resolved only by the build host.
  readonly hostPlugins?: string
}

export const defaults: Descriptor = {
  app: "opencode",
  displayName: "OpenCode",
  userAgent: "opencode",
  envPrefixes: ["OPENCODE_"],
  configBasenames: ["opencode"],
  servicePort: 0xc0de,
  serviceName: "opencode",
  logo: {
    left: ["                   ", "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", "█__█ █__█ █^^^ █__█", "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"],
    right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
  },
  narrowLogo: {
    left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
    right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
  },
  title: { home: "OpenCode", prefix: "OC" },
}

/** Validate a complete external descriptor at the build boundary. */
export function resolveIdentity(input: unknown): Descriptor {
  if (typeof input !== "object" || input === null) throw new Error("Identity must be an object")
  const value = input as Record<string, unknown>
  // altimate: ALT-F02
  if (value.hostPlugins !== undefined && (typeof value.hostPlugins !== "string" || !value.hostPlugins))
    throw new Error("Identity.hostPlugins must be a nonempty module path")
  for (const key of ["app", "displayName", "userAgent", "serviceName"]) {
    if (typeof value[key] !== "string" || value[key] === "") throw new Error(`Identity.${key} must be nonempty`)
  }
  for (const key of ["envPrefixes", "configBasenames"]) {
    if (!strings(value[key]) || value[key].length === 0 || value[key].some((item) => item === ""))
      throw new Error(`Identity.${key} must contain nonempty strings`)
  }
  if (!Number.isInteger(value.servicePort) || Number(value.servicePort) < 1 || Number(value.servicePort) > 65_534)
    throw new Error("Identity.servicePort must leave room for the local channel port")
  for (const key of ["logo", "narrowLogo"]) {
    const mark = value[key]
    if (
      typeof mark !== "object" ||
      mark === null ||
      !("left" in mark) ||
      !strings(mark.left) ||
      mark.left.length === 0 ||
      !("right" in mark) ||
      !strings(mark.right) ||
      mark.left.length !== mark.right.length
    )
      throw new Error(`Identity.${key} must contain equally sized left/right line arrays`)
  }
  const title = value.title
  if (
    typeof title !== "object" ||
    title === null ||
    !("home" in title) ||
    typeof title.home !== "string" ||
    !("prefix" in title) ||
    typeof title.prefix !== "string"
  )
    throw new Error("Identity.title must contain home and prefix strings")
  return input as Descriptor
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

declare global {
  var __OPENCODE_IDENTITY__: Descriptor | undefined
}

// Bun's define replaces this expression in branded builds; source runs can use an explicit preload.
export const Identity: Descriptor =
  typeof globalThis.__OPENCODE_IDENTITY__ === "undefined" ? defaults : globalThis.__OPENCODE_IDENTITY__
