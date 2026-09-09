import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
// altimate_change start — upstream_fix: needsDependencies (below)
import { fileURLToPath, pathToFileURL } from "url"
import { existsSync, realpathSync } from "fs"
import { FSUtil } from "@opencode-ai/core/fs-util"
// altimate_change end
import { isPathPluginSpec, parsePluginSpecifier, resolvePathPluginTarget } from "@/plugin/shared"
import path from "path"

export type Scope = "global" | "local"

// Origin keeps the original config provenance attached to a spec.
// After multiple config files are merged, callers still need to know which file declared the plugin
// and whether it should behave like a global or project-local plugin.
export type Origin = {
  spec: ConfigPluginV1.Spec
  source: string
  scope: Scope
}

export async function load(dir: string) {
  const plugins: ConfigPluginV1.Spec[] = []

  for (const item of await Glob.scan("{plugin,plugins}/*.{ts,js}", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    plugins.push(pathToFileURL(item).href)
  }
  return plugins
}

export function pluginSpecifier(plugin: ConfigPluginV1.Spec): string {
  return Array.isArray(plugin) ? plugin[0] : plugin
}

export function pluginOptions(plugin: ConfigPluginV1.Spec): ConfigPluginV1.Options | undefined {
  return Array.isArray(plugin) ? plugin[1] : undefined
}

// altimate_change start — upstream_fix: only install @opencode-ai/plugin where something can import it.
// Upstream reifies a ~60-package @npmcli/arborist tree into EVERY config dir on every start, in-process
// (Config and TuiConfig both do it). On a fresh v0.11.0 install (2026-09-09) that saturated Bun's event
// loop: `serve` accepted no HTTP request for 5 minutes and `run` froze for ~2.5 minutes until the install
// finished; the starved EffectFlock heartbeat made the lock look stale, a second waiter stole it, and the
// holder's release died with "metadata missing". The package is only importable by local tool/plugin
// sources and file:// plugins under the dir, so install only for those, or to keep an existing
// node_modules current.
const SOURCE_GLOB = "{tool,tools,plugin,plugins}/*.{js,ts}"

export function needsDependencies(dir: string, plugins: readonly ConfigPluginV1.Spec[] | undefined): boolean {
  if (existsSync(path.join(dir, "node_modules"))) return true
  try {
    if (Glob.scanSync(SOURCE_GLOB, { cwd: dir, dot: true, symlink: true }).length > 0) return true
  } catch {
    // An unreadable dir cannot hold importable sources; fall through to the declared specs.
  }
  return (plugins ?? []).some((plugin) => {
    const spec = pluginSpecifier(plugin)
    if (!spec.startsWith("file://")) return false
    try {
      const file = fileURLToPath(spec)
      try {
        // Bun resolves imports through symlinks; compare the locations that will use node_modules.
        return FSUtil.contains(realpathSync(dir), realpathSync(file))
      } catch {
        // Preserve lexical detection for paths that cannot yet be resolved on disk.
        return FSUtil.contains(dir, file)
      }
    } catch {
      return false
    }
  })
}
// altimate_change end

// Path-like specs are resolved relative to the config file that declared them so merges later on do not
// accidentally reinterpret `./plugin.ts` relative to some other directory.
export async function resolvePluginSpec(
  plugin: ConfigPluginV1.Spec,
  configFilepath: string,
): Promise<ConfigPluginV1.Spec> {
  const spec = pluginSpecifier(plugin)
  if (!isPathPluginSpec(spec)) return plugin

  const base = path.dirname(configFilepath)
  const file = (() => {
    if (spec.startsWith("file://")) return spec
    if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return pathToFileURL(spec).href
    return pathToFileURL(path.resolve(base, spec)).href
  })()

  const resolved = await resolvePathPluginTarget(file).catch(() => file)

  if (Array.isArray(plugin)) return [resolved, plugin[1]]
  return resolved
}

// Dedupe on the load identity (package name for npm specs, exact file URL for local specs), but keep the
// full Origin so downstream code still knows which config file won and where follow-up writes should go.
export function deduplicatePluginOrigins(plugins: Origin[]): Origin[] {
  const seen = new Set<string>()
  const list: Origin[] = []

  for (const plugin of plugins.toReversed()) {
    const spec = pluginSpecifier(plugin.spec)
    const name = spec.startsWith("file://") ? spec : parsePluginSpecifier(spec).pkg
    if (seen.has(name)) continue
    seen.add(name)
    list.push(plugin)
  }

  return list.toReversed()
}

export * as ConfigPlugin from "./plugin"
