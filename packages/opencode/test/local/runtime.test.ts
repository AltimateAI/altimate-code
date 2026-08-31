import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import { isWorkingRuntime, locateLlamaServer, RUNTIME_ASSETS } from "../../src/local/runtime"
import type { LocalPaths } from "../../src/local/paths"

const BIN_NAME = process.platform === "win32" ? "llama-server.exe" : "llama-server"

function paths(bin: string): LocalPaths {
  return {
    root: bin,
    bin,
    models: path.join(bin, "models"),
    downloads: path.join(bin, "downloads"),
    certificates: path.join(bin, "certificates"),
    state: path.join(bin, "state.json"),
    pid: path.join(bin, "server.pid"),
    log: path.join(bin, "server.log"),
    environment: path.join(bin, "environment.json"),
    recipes: path.join(bin, "recipes.json"),
    recipesMeta: path.join(bin, "recipes.meta.json"),
  }
}

describe("locateLlamaServer", () => {
  test("treats a present-but-broken install as not found instead of throwing", async () => {
    await using tmp = await tmpdir()
    const binary = path.join(tmp.path, BIN_NAME)
    // A script that is executable but always fails `--version` reproduces an
    // install broken in place (e.g. missing shared libs after a bad unpack).
    await fs.writeFile(binary, "#!/bin/sh\nexit 1\n")
    await fs.chmod(binary, 0o755)

    const result = await locateLlamaServer({ env: {}, paths: paths(tmp.path) })
    expect(result).toBeUndefined()
  }, 10_000)

  // Skipped on win32: this fixture is a POSIX #!/bin/sh script written to a
  // path ending in .exe. Windows dispatches execution by file extension, not
  // shebang, so a real win32 run can't launch it at all — that's a genuine
  // difference from every other platform here, not something this fixture
  // can paper over without a real compiled Windows binary.
  test.skipIf(process.platform === "win32")(
    "returns the installed runtime once it is executable and reports a version",
    async () => {
      await using tmp = await tmpdir()
      const binary = path.join(tmp.path, BIN_NAME)
      await fs.writeFile(binary, '#!/bin/sh\necho "llama-server build 1"\nexit 0\n')
      await fs.chmod(binary, 0o755)

      const result = await locateLlamaServer({ env: {}, paths: paths(tmp.path) })
      expect(result?.source).toBe("installed")
      expect(result?.version).toBe("llama-server build 1")
    },
  )
})

describe("isWorkingRuntime", () => {
  // installLlamaServer uses this to decide whether an already-installed
  // target binary is good enough to keep (discarding the freshly downloaded
  // replacement). It must check that the binary actually runs, not just
  // that its execute bit is set — otherwise a broken-but-chmod'd install
  // (e.g. missing shared libs after a bad unpack) can never be repaired.
  test("is false for a file that has the execute bit but fails to run", async () => {
    await using tmp = await tmpdir()
    const binary = path.join(tmp.path, BIN_NAME)
    await fs.writeFile(binary, "#!/bin/sh\nexit 1\n")
    await fs.chmod(binary, 0o755)

    expect(await isWorkingRuntime(binary)).toBe(false)
  })

  // Same reason as the skip above: a POSIX shebang script named *.exe cannot
  // actually run on native Windows.
  test.skipIf(process.platform === "win32")("is true for a binary that runs and reports a version", async () => {
    await using tmp = await tmpdir()
    const binary = path.join(tmp.path, BIN_NAME)
    await fs.writeFile(binary, '#!/bin/sh\necho "llama-server build 1"\nexit 0\n')
    await fs.chmod(binary, 0o755)

    expect(await isWorkingRuntime(binary)).toBe(true)
  })
})

describe("RUNTIME_ASSETS coverage", () => {
  test("only lists platform-arch pairs llama.cpp actually publishes builds for", () => {
    expect(Object.keys(RUNTIME_ASSETS).sort()).toEqual(
      ["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"].sort(),
    )
  })
})
