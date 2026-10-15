// altimate: ALT-F02
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { format } from "../src/commands/handlers/plugin/list"

test("plugin list --builtin includes an active host contribution", () => {
  const plugins = [
    {
      id: "altimate",
      source: { type: "builtin" as const },
      features: { server: true as const, tui: true as const, rpc: true as const },
      state: { status: "active" as const },
    },
  ]
  expect(format(plugins, [])).toBe("")
  expect(format(plugins, [], true)).toMatch(/altimate\s+-\s+builtin/)
})

test("plugin list --builtin includes the branded TUI contribution without config", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "../../altimate/script/identity-preload.ts"),
      "--eval",
      'const { format } = await import("./src/commands/handlers/plugin/list.ts"); console.log(format([], [], true));',
    ],
    { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(stdout).toMatch(/altimate\s+-\s+builtin \(tui\)/)
})

test("plugin remove explains protected host builtins without changing configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "altimate-plugin-remove-"))
  try {
    const config = path.join(root, "config", "altimate-code", "altimate-code.json")
    const original = '{ "plugins": ["altimate", "example"] }\n'
    await Bun.write(config, original)
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(import.meta.dir, "../../altimate/script/identity-preload.ts"),
        "src/index.ts",
        "plugin",
        "remove",
        "altimate",
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain('Plugin "altimate" is a protected host builtin and cannot be removed')
    expect(await Bun.file(config).text()).toBe(original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
