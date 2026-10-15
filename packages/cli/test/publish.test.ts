// altimate: ALT-F03
import { expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

const cli = path.resolve(import.meta.dir, "..")
const identity = path.resolve(cli, "../altimate/identity.json")
const platform = process.platform === "win32" ? "windows" : process.platform

test("pack-only preserves the stock wrapper and skips release publication", async () => {
  await using directory = await tmpdir()
  const fixture = await distribution(directory.path, "opencode")
  const result = await pack(fixture)
  expect(result.code).toBe(0)
  expect(result.output).not.toContain("dry-run artifact")
  expect(await Bun.file(path.join(directory.path, "npm-called")).exists()).toBe(false)
  expect(await Bun.file(path.join(fixture.root, "@opencode/cli/package.json")).json()).toEqual({
    name: "@opencode/cli",
    bin: { opencode: "./bin/opencode.exe", opencode2: "./bin/opencode.exe" },
    scripts: { postinstall: "node ./postinstall.mjs" },
    version: "0.0.1-spike",
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/anomalyco/opencode.git" },
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
    optionalDependencies: { [fixture.package]: "0.0.1-spike" },
  })
  expect(await Bun.file(path.join(fixture.root, "@opencode/cli/opencode-cli-0.0.1-spike.tgz")).exists()).toBe(true)
})

test.skipIf(process.platform === "win32")("branded wrapper packs and installs its binary with H5 sidecars offline", async () => {
  await using directory = await tmpdir()
  const fixture = await distribution(directory.path, "altimate-code")
  const result = await pack(fixture, [`--identity=${identity}`])
  expect(result.code).toBe(0)
  expect(result.output).not.toContain("opencode.ai")
  expect(await Bun.file(path.join(directory.path, "npm-called")).exists()).toBe(false)
  const wrapper = path.join(fixture.root, "@altimateai/altimate-code")
  expect(await Bun.file(path.join(wrapper, "package.json")).json()).toMatchObject({
    name: "@altimateai/altimate-code",
    bin: { "altimate-code": "./bin/altimate-code.exe" },
    optionalDependencies: { [fixture.package]: "0.0.1-spike" },
  })
  const installed = path.join(directory.path, "installed/node_modules")
  const target = path.join(installed, "@altimateai/altimate-code")
  await mkdir(target, { recursive: true })
  await mkdir(path.join(installed, fixture.package), { recursive: true })
  for (const item of [
    {
      tarball: path.join(wrapper, "altimateai-altimate-code-0.0.1-spike.tgz"),
      destination: target,
    },
    {
      tarball: path.join(fixture.root, fixture.directory, `${fixture.package}-0.0.1-spike.tgz`),
      destination: path.join(installed, fixture.package),
    },
  ]) {
    const unpack = Bun.spawn(["tar", "-xzf", item.tarball, "--strip-components=1", "-C", item.destination], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await unpack.exited).toBe(0)
  }
  const install = Bun.spawn([process.execPath, path.join(target, "postinstall.mjs")], {
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await new Response(install.stderr).text()).toBe("")
  expect(await install.exited).toBe(0)
  expect(await Bun.file(path.join(target, "lib/altimate/drivers/proof.txt")).text()).toBe("packaged sidecar\n")
  const binary = Bun.spawn([path.join(target, "bin/altimate-code.exe"), "--sidecar"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await new Response(binary.stdout).text()).toBe("packaged sidecar\n")
  expect(await binary.exited).toBe(0)
  expect(await Bun.file(path.join(directory.path, "npm-called")).exists()).toBe(false)
})

test("branded wrappers refuse the upstream publication path", async () => {
  await using directory = await tmpdir()
  const fixture = await distribution(directory.path, "altimate-code")
  const result = await pack(fixture, [`--identity=${identity}`], false)
  expect(result.code).not.toBe(0)
  expect(result.output).toContain("Distribution identities require --pack-only")
  expect(await Bun.file(path.join(directory.path, "npm-called")).exists()).toBe(false)
})

test("pack-only requires a local version before loading release metadata", async () => {
  await using directory = await tmpdir()
  const fixture = await distribution(directory.path, "opencode")
  fixture.env.OPENCODE_VERSION = ""
  const result = await pack(fixture)
  expect(result.code).not.toBe(0)
  expect(result.output).toContain("--pack-only requires an explicit OPENCODE_VERSION")
  expect(result.output).not.toContain("opencode script")
  expect(await Bun.file(path.join(directory.path, "npm-called")).exists()).toBe(false)
})

async function distribution(directory: string, app: string) {
  const root = path.join(directory, "dist")
  const name = `${app === "opencode" ? "cli" : app}-${platform}-${process.arch}`
  const binary = path.join(root, name, "bin", app)
  await Bun.write(
    binary,
    `#!/bin/sh\nif [ "$1" = "--sidecar" ]; then cat "$(dirname "$0")/../lib/altimate/drivers/proof.txt"; else echo "${app} v0.0.1-spike"; fi\n`,
  )
  await chmod(binary, 0o755)
  if (app !== "opencode")
    await Bun.write(path.join(root, name, "lib/altimate/drivers/proof.txt"), "packaged sidecar\n")
  const packageName = app === "opencode" ? `@opencode/${name}` : name
  await Bun.write(path.join(root, name, "package.json"), JSON.stringify({ name: packageName, version: "0.0.1-spike" }))
  await Bun.write(path.join(directory, "commands/npm"), '#!/bin/sh\ntouch "$PACK_TEST_NPM_CALLED"\nexit 99\n')
  await chmod(path.join(directory, "commands/npm"), 0o755)
  return {
    root,
    package: packageName,
    directory: name,
    env: {
      ...process.env,
      OPENCODE_CLI_DIST: root,
      OPENCODE_CHANNEL: "latest",
      OPENCODE_VERSION: "0.0.1-spike",
      OPENCODE_RELEASE: "1",
      PACK_TEST_NPM_CALLED: path.join(directory, "npm-called"),
      PATH: [path.join(directory, "commands"), path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    },
  }
}

async function pack(fixture: Awaited<ReturnType<typeof distribution>>, args: string[] = [], packOnly = true) {
  const child = Bun.spawn([process.execPath, "script/publish.ts", ...(packOnly ? ["--pack-only"] : []), ...args], {
    cwd: cli,
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, output: stdout + stderr }
}
