// altimate: ALT-F01
import path from "node:path"
import { expect, test } from "bun:test"
import identity from "../../altimate/identity.json"
import { tmpdir } from "./fixture/tmpdir"

for (const branded of [false, true]) {
  test(`${branded ? "Altimate" : "upstream"} MCP writes, TUI discovery, and inline CLI config`, async () => {
    await using directory = await tmpdir()
    const subprocess = Bun.spawn(
      [
        process.execPath,
        ...(branded ? ["--define", `globalThis.__OPENCODE_IDENTITY__=${JSON.stringify(identity)}`] : []),
        "./test/fixture/identity-config.ts",
        directory.path,
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(directory.path, "data"),
          XDG_CONFIG_HOME: path.join(directory.path, "config"),
          XDG_CACHE_HOME: path.join(directory.path, "cache"),
          XDG_STATE_HOME: path.join(directory.path, "state"),
          ALTIMATE_CLI_CLI_CONFIG_CONTENT: JSON.stringify({ animations: false }),
          OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ animations: true }),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    const app = branded ? "altimate-code" : "opencode"
    const project = path.join(directory.path, "project")
    const global = path.join(directory.path, "global")
    expect(result.empty).toBe(path.join(project, `${app}.json`))
    expect(result.fallback).toBe(path.join(project, "opencode.jsonc"))
    expect(result.competing).toBe(path.join(project, `${app}.json`))
    expect(result.initialPlugins).toEqual([path.join(global, "plugins"), path.join(project, `.${app}`, "plugins")])
    expect(result.plugins).toEqual([
      path.join(global, "plugins"),
      ...(branded ? [path.join(project, ".altimate-code", "plugins")] : []),
      path.join(project, ".opencode", "plugins"),
    ])
    expect(result.config).toEqual({ path: path.join(global, "cli.json"), value: { animations: !branded } })
  }, 30_000)
}
