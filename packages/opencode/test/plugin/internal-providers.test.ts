import { describe, expect, test } from "bun:test"
import path from "path"

const indexFile = path.join(import.meta.dir, "../../src/plugin/index.ts")

describe("plugin.internal-providers", () => {
  test("wires upstream provider auth plugins into INTERNAL_PLUGINS", async () => {
    const src = await Bun.file(indexFile).text()
    const providers = [
      { name: "AzureAuthPlugin", importPath: "./azure" },
      { name: "DigitalOceanAuthPlugin", importPath: "./digitalocean" },
      { name: "XaiAuthPlugin", importPath: "./xai" },
    ]

    for (const provider of providers) {
      expect(src).toContain(`import { ${provider.name} } from "${provider.importPath}"`)
    }

    // internalPlugins() was refactored from a plain `const INTERNAL_PLUGINS` array into a
    // function of RuntimeFlags (so default-plugin gating can vary per-flags); match its
    // `return [...]` body instead of the old top-level const.
    const match = src.match(/function internalPlugins\([^)]*\): PluginInstance\[\] \{\s*return \[([\s\S]*?)\n\s*\]/)
    expect(match).not.toBeNull()

    const block = match![1]
    const gitlabIndex = block.indexOf("GitlabAuthPlugin")
    expect(gitlabIndex).toBeGreaterThanOrEqual(0)

    for (const provider of providers) {
      const providerIndex = block.indexOf(provider.name)
      expect(providerIndex).toBeGreaterThan(gitlabIndex)
    }

    expect(block).toMatch(
      /\/\/ altimate_change start — upstream_fix: restore provider auth internal plugins[\s\S]*AzureAuthPlugin[\s\S]*DigitalOceanAuthPlugin[\s\S]*XaiAuthPlugin[\s\S]*\/\/ altimate_change end/,
    )
  })
})
