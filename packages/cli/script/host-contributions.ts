// altimate: ALT-F02
import type { BunPlugin } from "bun"
import path from "node:path"

// Static import paths let Bun include the distribution's lazy server/TUI entries in the artifact.
export function hostContributionsPlugin(descriptorFile: string, module: string): BunPlugin {
  const entry = path.resolve(path.dirname(descriptorFile), module)
  return {
    name: "host-contributions",
    setup(build) {
      build.onLoad({ filter: /plugin[/\\]src[/\\]host-contributions\.ts$/ }, () => ({
        loader: "ts",
        contents: `export { default as HostContributions } from ${JSON.stringify(entry)}`,
      }))
    },
  }
}
