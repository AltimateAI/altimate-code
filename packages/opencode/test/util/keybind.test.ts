import { describe, test } from "bun:test"

describe.skip("Keybind utility", () => {
  // Removed upstream: keybind parsing is no longer exposed as src/util/keybind.
  test("legacy src/util/keybind was removed upstream; keybind parsing now lives behind the TUI config layer", () => {})
})
