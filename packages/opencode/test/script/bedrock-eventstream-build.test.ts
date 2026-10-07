import { describe, test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { smithyNodeSerdePlugin } from "../../script/smithy-node-serde-plugin"

/**
 * Regression: Bedrock Converse streams came back empty (finish "other", no text, no usage, no error)
 * in the built binary. script/build.ts bundles with `conditions: ["browser"]` for a Bun target; under
 * that combination `@smithy/core/serde` exports placeholder `fromString`/`fromArrayBuffer`, the event
 * stream decoder throws on its first frame and the SDK swallows the error.
 *
 * These tests bundle a probe that decodes a synthetic `application/vnd.amazon.eventstream` body through
 * the real @ai-sdk/amazon-bedrock provider, using the same `conditions` and a Bun target as the release
 * build, then run the bundle. No network or credentials are involved.
 */

const bundler = path.join(import.meta.dir, "bedrock-eventstream-bundle.ts")

async function bundleAndRun(mode: "plugin" | "none") {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-eventstream-"))
  try {
    const build = Bun.spawn([process.execPath, bundler, outdir, mode], { stdout: "pipe", stderr: "pipe" })
    const buildErr = await new Response(build.stderr).text()
    expect(await build.exited, buildErr).toBe(0)
    const run = Bun.spawn([process.execPath, path.join(outdir, "bedrock-eventstream-probe.js")], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(run.stdout).text()
    await run.exited
    return JSON.parse(out.trim().split("\n").pop()!)
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true })
  }
}

describe("Bedrock event-stream decoding in the release build's resolution conditions", () => {
  test("with the build plugin the stream yields text, finish reason and token counts", async () => {
    const result = await bundleAndRun("plugin")
    expect(result).toEqual({ text: "hello", finish: { unified: "stop", raw: "end_turn" }, input: 4, output: 2 })
  }, 60_000)

  // Control: proves the probe detects the defect. If an @smithy/core or @smithy/util-buffer-from upgrade
  // makes this fail (the stream is no longer empty), the plugin is no longer needed and can be removed
  // together with this test.
  test("without the plugin the same bundle is empty (control for the probe)", async () => {
    const result = await bundleAndRun("none")
    expect(result.text).toBe("")
    expect(result.finish.unified).toBe("other")
  }, 60_000)
})

describe("smithyNodeSerdePlugin scope", () => {
  function resolver() {
    let cb!: (args: { importer: string }) => unknown
    smithyNodeSerdePlugin().setup({ onResolve: (_o: unknown, f: unknown) => (cb = f as typeof cb) } as any)
    return cb
  }

  test("redirects @smithy/core/serde only for @smithy/util-buffer-from importers", () => {
    const resolve = resolver()
    const bufferFrom = require.resolve("@smithy/util-buffer-from/package.json", {
      paths: [
        path.dirname(
          require.resolve("@smithy/util-utf8/package.json", {
            paths: [path.dirname(require.resolve("@ai-sdk/amazon-bedrock/package.json"))],
          }),
        ),
      ],
    })
    const hit = resolve({ importer: path.join(path.dirname(bufferFrom), "dist-es", "index.js") }) as { path: string }
    expect(hit.path).toContain("serde")
    expect(hit.path).not.toContain("browser")
  })

  test("leaves every other importer untouched", () => {
    const resolve = resolver()
    expect(resolve({ importer: "/x/node_modules/@smithy/util-utf8/dist-es/fromUtf8.js" })).toBeUndefined()
    expect(resolve({ importer: "/x/node_modules/@smithy/eventstream-codec/dist-es/index.js" })).toBeUndefined()
    expect(resolve({ importer: "/x/src/index.ts" })).toBeUndefined()
  })
})

describe("script/build.ts wiring", () => {
  test("the release Bun.build call registers smithyNodeSerdePlugin alongside the browser condition", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "../../script/build.ts"), "utf8")
    const call = src.slice(src.indexOf("await Bun.build({"))
    expect(call).toContain('conditions: ["browser"]')
    expect(call.slice(0, call.indexOf("entrypoints:"))).toContain("smithyNodeSerdePlugin()")
  })
})
