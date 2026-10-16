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
  // altimate: ALT-F03 - release templates are expanded by the updater, never by the shell.
  readonly updater: {
    readonly releaseUrl: string
    readonly package: string
    readonly installedPackagePattern: string
    readonly policyFiles: readonly string[]
    readonly installDirectory: string
    readonly installBinary: string
    readonly installerUrl: string | null
    readonly brew: {
      readonly formulas: readonly string[]
      readonly coreFormula: string
      readonly coreUrl: string
      readonly package: string
      readonly channels: Readonly<Record<string, string>>
    } | null
    readonly winget: string | null
  }
  // altimate: ALT-F02 - module path relative to the descriptor, resolved only by the build host.
  readonly hostPlugins?: string
  // altimate: ALT-F05 - optional distribution-owned artifact packaging hook.
  readonly buildPlugin?: string
  // altimate: ALT-F06 sidebar "Getting started" copy; absent means the stock OpenCode text.
  readonly onboarding?: { readonly lines: readonly string[]; readonly connect: string }
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
  // altimate: ALT-F03
  updater: {
    releaseUrl: "https://opencode.ai/update/api/{channel}/{artifact}/{distribution}?current={current}",
    package: "@opencode/{artifact}",
    installedPackagePattern: "^@opencode(?:-ai)?/cli(?:-node)?$",
    policyFiles: ["config.json", "opencode.json", "opencode.jsonc"],
    installDirectory: ".opencode",
    installBinary: "opencode",
    installerUrl: "https://opencode.ai/v2/install",
    brew: {
      formulas: ["opencode", "opencode-beta", "opencode-v2"],
      coreFormula: "opencode",
      coreUrl: "https://formulae.brew.sh/api/formula/opencode.json",
      package: "anomalyco/tap/opencode-v2",
      channels: { beta: "anomalyco/tap/opencode-beta" },
    },
    winget: "Anomaly.OpenCode",
  },
}

/** Validate a complete external descriptor at the build boundary. */
export function resolveIdentity(input: unknown): Descriptor {
  if (typeof input !== "object" || input === null) throw new Error("Identity must be an object")
  const value = input as Record<string, unknown>
  // altimate: ALT-F03
  requireUpdater(value.updater)
  // altimate: ALT-F02
  if (value.hostPlugins !== undefined && (typeof value.hostPlugins !== "string" || !value.hostPlugins))
    throw new Error("Identity.hostPlugins must be a nonempty module path")
  // altimate: ALT-F05
  if (value.buildPlugin !== undefined && (typeof value.buildPlugin !== "string" || !value.buildPlugin))
    throw new Error("Identity.buildPlugin must be a nonempty module path")
  // altimate: ALT-F06
  requireOnboarding(value.onboarding)
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

// altimate: ALT-F03 - validate the external descriptor once, before embedding it.
function requireUpdater(input: unknown) {
  if (typeof input !== "object" || input === null) throw new Error("Identity.updater must be an object")
  const value = input as Record<string, unknown>
  for (const key of ["releaseUrl", "package", "installedPackagePattern", "installDirectory", "installBinary"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`Identity.updater.${key} must be nonempty`)
  }
  new RegExp(value.installedPackagePattern as string)
  requireUpdateUrl(value.releaseUrl)
  if (!strings(value.policyFiles) || !value.policyFiles.length || value.policyFiles.some((name) => !name))
    throw new Error("Identity.updater.policyFiles must contain nonempty strings")
  if (value.installerUrl !== null) requireUpdateUrl(value.installerUrl)
  if (value.winget !== null && (typeof value.winget !== "string" || !value.winget))
    throw new Error("Identity.updater.winget must be a package identifier or null")
  if (value.brew === null) return
  if (typeof value.brew !== "object" || value.brew === null)
    throw new Error("Identity.updater.brew must be an object or null")
  const brew = value.brew as Record<string, unknown>
  if (!strings(brew.formulas) || !brew.formulas.length || brew.formulas.some((name) => !name))
    throw new Error("Identity.updater.brew.formulas must contain nonempty strings")
  for (const key of ["coreFormula", "package"]) {
    if (typeof brew[key] !== "string" || !brew[key]) throw new Error(`Identity.updater.brew.${key} must be nonempty`)
  }
  requireUpdateUrl(brew.coreUrl)
  if (
    typeof brew.channels !== "object" ||
    brew.channels === null ||
    Array.isArray(brew.channels) ||
    Object.values(brew.channels).some((name) => typeof name !== "string" || !name)
  )
    throw new Error("Identity.updater.brew.channels must map channels to package names")
}

// altimate: ALT-F03 - HTTP is allowed for explicitly selected local test endpoints.
function requireUpdateUrl(input: unknown) {
  if (typeof input !== "string" || !["http:", "https:"].includes(new URL(input).protocol))
    throw new Error("Identity updater URLs must use http or https")
}

// altimate: ALT-F06
function requireOnboarding(input: unknown) {
  if (input === undefined) return
  const value = input as { lines?: unknown; connect?: unknown } | null
  if (
    typeof value !== "object" ||
    value === null ||
    !strings(value.lines) ||
    !value.lines.length ||
    value.lines.some((line) => !line) ||
    typeof value.connect !== "string" ||
    !value.connect
  )
    throw new Error("Identity.onboarding must contain nonempty lines and a connect label")
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
