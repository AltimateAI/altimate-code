// altimate: ALT-F02
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { hostContributionsPlugin } from "../script/host-contributions"
import descriptor from "../../altimate/identity.json"

const contract = path.resolve(import.meta.dirname, "../../plugin/src/host-contributions.ts")

test("host contribution build hook bundles both production Altimate entries and RPC", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-contributions-"))
  try {
    const entry = path.join(directory, "entry.ts")
    await Bun.write(
      entry,
      `import { HostContributions } from ${JSON.stringify(contract)}; console.log(HostContributions)`,
    )
    const inputs = new Set<string>()
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      plugins: [
        hostContributionsPlugin(
          path.resolve(import.meta.dirname, "../../altimate/identity.json"),
          descriptor.hostPlugins,
        ),
        createSolidTransformPlugin(),
        {
          name: "inspect-distribution-graph",
          setup(build) {
            build.onLoad({ filter: /altimate[/\\]src[/\\](server|rpc)\.ts$/ }, (args) => {
              inputs.add(args.path)
            })
            // Observe TUI resolution before the Solid loader transforms it.
            build.onResolve({ filter: /^\.\/src\/tui$/ }, (args) => {
              inputs.add(path.resolve(args.resolveDir, "src/tui.tsx"))
              return undefined
            })
            // Dependency packaging/native sidecars belong to H5; this checks the actual host composition graph.
            build.onResolve({ filter: /^[@a-z]/ }, (args) => ({ path: args.path, external: true }))
          },
        },
      ],
    })
    expect(result.success, result.logs.map(String).join("\n")).toBe(true)
    expect([...inputs].map((file) => path.basename(file)).sort()).toEqual(["rpc.ts", "server.ts", "tui.tsx"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("compiled host contribution loaders run without a source preload; stock stays empty", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-contribution-compile-"))
  try {
    const entry = path.join(directory, "entry.ts")
    await Bun.write(
      entry,
      `import { HostContributions } from ${JSON.stringify(contract)};
      console.log(JSON.stringify(await Promise.all([...HostContributions.server, ...HostContributions.tui].map(async entry => ({id: entry.id, protected: entry.protected, loaded: (await entry.plugin()).default.id})))));`,
    )
    await Bun.write(path.join(directory, "plugin.ts"), 'export default { id: "fixture", setup() {} }')
    await Bun.write(
      path.join(directory, "host.ts"),
      'const entries = [{ id: "fixture", protected: true, plugin: () => import("./plugin") }]; export default {server: entries, tui: entries}',
    )
    for (const branded of [false, true]) {
      const outfile = path.join(directory, branded ? "branded" : "stock")
      const result = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        plugins: branded ? [hostContributionsPlugin(path.join(directory, "identity.json"), "./host.ts")] : [],
        compile: { outfile, autoloadBunfig: false, autoloadDotenv: false },
      })
      expect(result.success, result.logs.map(String).join("\n")).toBe(true)
      const child = Bun.spawn([outfile], { cwd: os.tmpdir(), stdout: "pipe", stderr: "pipe" })
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(status, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual(
        branded
          ? [
              { id: "fixture", protected: true, loaded: "fixture" },
              { id: "fixture", protected: true, loaded: "fixture" },
            ]
          : [],
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
