// altimate_change start — upstream_fix: regression coverage for TUI command shipped-path fixes
import { describe, expect, test } from "bun:test"

const tuiCommandSource = () => Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

describe("tui command", () => {
  test("resolves network options through the config-aware resolver", async () => {
    const source = await tuiCommandSource()

    // Assertions use regex (not string literals) so Bun's transpiler doesn't
    // statically resolve `@/cli/network` into `file:///…/network.ts` in the
    // expected value — a CI-only cache quirk that inverts the comparison.
    expect(source).toMatch(/import \{ withNetworkOptions, resolveNetworkOptions \} from "@\/cli\/network"/)
    expect(source).toMatch(/import \{ AppRuntime \} from "@\/effect\/app-runtime"/)
    expect(source).toContain("await AppRuntime.runPromise(resolveNetworkOptions(args))")
    expect(source).not.toContain("resolveNetworkOptionsNoConfig(args)")
  })

  test("session validation failures still run worker cleanup", async () => {
    const source = await tuiCommandSource()
    const start = source.indexOf(
      "// altimate_change start — upstream_fix: clean up TUI worker after failed --session validation",
    )
    expect(start).toBeGreaterThan(-1)

    const end = source.indexOf(
      "// altimate_change end — upstream_fix: clean up TUI worker after failed --session validation",
      start,
    )
    expect(end).toBeGreaterThan(start)

    const block = source.slice(start, end)
    const validate = block.indexOf("await validateSession")
    const run = block.indexOf("await Effect.runPromise")
    const cleanup = block.indexOf("await stop()")

    expect(validate).toBeGreaterThan(-1)
    expect(run).toBeGreaterThan(validate)
    expect(cleanup).toBeGreaterThan(run)
    expect(block).toMatch(/finally\s*\{\s*await stop\(\)\s*\}/)
  })
})
// altimate_change end
