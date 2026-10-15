import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import descriptor from "../identity.json"
import { defaults, type Descriptor } from "../../util/src/identity"

const fixture = path.join(import.meta.dir, "fixtures/host-identity.ts")
const preload = path.join(import.meta.dir, "../script/identity-preload.ts")

test("host defaults preserve upstream service discovery, ports, logo and titles", async () => {
  const result = await inspect(false)
  expect(result.app).toBe("opencode")
  expect(result.ports.slice(0, 5)).toEqual([0xc0de, 0xc0de, 0xc0de, 0xc0de, 0xc0df])
  expect(result.file).toEndWith("/state/opencode/service.json")
  expect(result.logo).toEqual(defaults.logo)
  expect(result.narrowLogo).toEqual(defaults.narrowLogo)
  expect(result.title).toEqual({ home: "OpenCode", prefix: "OC" })
  expect(result.selfCommand).toEqual([process.execPath, fixture])
}, 30_000)

test("branded source host and its spawned command share identity and independent service discovery", async () => {
  const branded = await inspect(false, [
    process.execPath,
    "--preload",
    "./" + path.relative(process.cwd(), preload),
    fixture,
    "--change-directory",
  ])
  const upstream = await inspect(false)
  expect(branded.app).toBe(descriptor.app)
  expect(branded.ports.slice(0, 5)).toEqual([57241, 57241, 57241, 57241, 57242])
  expect(branded.ports[5]).not.toBe(upstream.ports[5])
  expect(branded.file).toEndWith("/state/altimate-code/service.json")
  expect(branded.logo).toEqual(descriptor.logo)
  expect(branded.narrowLogo).toEqual(descriptor.narrowLogo)
  expect(branded.title).toEqual(descriptor.title)
  expect(branded.selfCommand).toEqual([process.execPath, "--preload", preload, fixture])
  expect((await inspect(false, branded.selfCommand)).app).toBe(descriptor.app)
}, 30_000)

test("Bun compile-time identity define reaches the production logo module without a preload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "altimate-host-define-"))
  try {
    const entry = path.join(root, "entry.ts")
    await Bun.write(
      entry,
      `import { logo, go } from ${JSON.stringify(path.join(import.meta.dir, "../../tui/src/logo.ts"))}; console.log(JSON.stringify({logo, narrowLogo: go}))`,
    )
    const built = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      define: { "globalThis.__OPENCODE_IDENTITY__": JSON.stringify(descriptor) },
    })
    expect(built.success).toBe(true)
    const output = path.join(root, "compiled.js")
    await Bun.write(output, built.outputs[0])
    const result = Bun.spawn([process.execPath, output], { stdout: "pipe", stderr: "pipe" })
    expect(await result.exited, await new Response(result.stderr).text()).toBe(0)
    expect(JSON.parse(await new Response(result.stdout).text())).toEqual({
      logo: descriptor.logo,
      narrowLogo: descriptor.narrowLogo,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

async function inspect(branded: boolean, command?: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "altimate-host-identity-"))
  try {
    const result = Bun.spawn(command ?? [process.execPath, ...(branded ? ["--preload", preload] : []), fixture], {
      env: {
        ...process.env,
        HOME: root,
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        TMPDIR: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await result.exited, await new Response(result.stderr).text()).toBe(0)
    return JSON.parse(await new Response(result.stdout).text()) as {
      app: string
      ports: number[]
      file: string
      logo: Descriptor["logo"]
      narrowLogo: Descriptor["narrowLogo"]
      title: typeof descriptor.title
      selfCommand: string[]
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
