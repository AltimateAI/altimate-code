// altimate: ALT-F02
// Distribution-owned definitions; loaders keep server-only hosts free of TUI imports.
import type { Plugin } from "./promise/plugin.js"
import type { Definition } from "./tui/plugin.js"

export type Contribution<P> = {
  readonly id: string
  readonly protected: boolean
  readonly plugin: () => Promise<{ default: P }>
}

export type Contributions = {
  readonly server: readonly Contribution<Plugin>[]
  readonly tui: readonly Contribution<Definition>[]
}

declare global {
  var __OPENCODE_HOST_PLUGINS__: Contributions | undefined
}

// Source preloads set this before host imports; compiled hosts replace this module at build time.
export const HostContributions: Contributions = globalThis.__OPENCODE_HOST_PLUGINS__ ?? { server: [], tui: [] }
