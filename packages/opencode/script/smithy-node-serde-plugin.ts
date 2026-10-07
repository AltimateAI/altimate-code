// Bun.build plugin shared by script/build.ts and its regression test.
//
// The release build bundles with `conditions: ["browser"]` (needed by the TUI
// dependencies). Under that condition `@smithy/core/serde` resolves to
// `index.browser.js`, where the Node-only exports `fromString` and
// `fromArrayBuffer` are placeholder symbols (`Symbol.for("node-only")`).
// `@smithy/util-buffer-from` re-exports exactly those two names and
// `@smithy/util-utf8` calls them while `@ai-sdk/amazon-bedrock` decodes the
// `application/vnd.amazon.eventstream` body. The call throws a TypeError, which
// the SDK's decoder swallows, so every Bedrock Converse stream ended with zero
// events: finish "other", no text, no usage, no error.
//
// This plugin redirects only that one import (`@smithy/core/serde` requested
// from inside `@smithy/util-buffer-from`) to the package's Node build, which
// is the file a source run already uses. Every other importer of
// `@smithy/core/serde` and every other package keeps its resolution.
import path from "node:path"
import type { BunPlugin } from "bun"

const IMPORTER = /[\\/]@smithy[\\/]util-buffer-from[\\/]/

export function smithyNodeSerdePlugin(): BunPlugin {
  return {
    name: "smithy-util-buffer-from-node-serde",
    setup(build) {
      build.onResolve({ filter: /^@smithy\/core\/serde$/ }, (args) => {
        if (!IMPORTER.test(args.importer)) return undefined
        // Resolve from the importer's directory with Bun's default (non-browser) conditions.
        return { path: Bun.resolveSync("@smithy/core/serde", path.dirname(args.importer)) }
      })
    },
  }
}
