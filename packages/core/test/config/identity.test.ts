// altimate: ALT-F01
import path from "node:path"
import { expect, test } from "bun:test"
import identity from "../../../altimate/identity.json"
import { tmpdir } from "../fixture/tmpdir"

for (const branded of [false, true]) {
  test(`${branded ? "Altimate" : "upstream"} config discovery, precedence, and write targets`, async () => {
    await using directory = await tmpdir()
    const subprocess = Bun.spawn(
      [
        process.execPath,
        ...(branded ? ["--define", `globalThis.__OPENCODE_IDENTITY__=${JSON.stringify(identity)}`] : []),
        "./test/fixture/config-identity.ts",
        directory.path,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(directory.path, "data"),
          XDG_CONFIG_HOME: path.join(directory.path, "config"),
          XDG_CACHE_HOME: path.join(directory.path, "cache"),
          XDG_STATE_HOME: path.join(directory.path, "state"),
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
    const global = branded
      ? ["opencode.json", "opencode.jsonc", "altimate-code.json", "altimate-code.jsonc"]
      : ["opencode.json", "opencode.jsonc"]
    const hidden = branded ? ["altimate-code.json", "altimate-code.jsonc", "opencode.json", "opencode.jsonc"] : global
    expect(result.names).toEqual(global)
    expect(result.entries).toEqual([
      ...global.map((name) => `global/${name}`),
      ...global.map((name) => `project/${name}`),
      ...(branded ? hidden.map((name) => `project/.altimate-code/${name}`) : []),
      ...hidden.map((name) => `project/.opencode/${name}`),
      ...hidden.map((name) => `system/${name}`),
    ])
    const app = branded ? "altimate-code" : "opencode"
    expect(result.created).toEqual([`${app}.jsonc`])
    expect(result.updated.find((entry: { name: string }) => entry.name === app).value.shell).toBe("updated")
    expect(result.system).toBe(`/etc/${app}`)
    expect(result.preferences).toEqual([
      `/Library/Managed Preferences/alice/ai.${app}.managed.plist`,
      `/Library/Managed Preferences/ai.${app}.managed.plist`,
    ])
  }, 30_000)
}
