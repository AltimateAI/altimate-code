// altimate: ALT-F01
import path from "node:path"
import { expect, test } from "bun:test"
import identity from "../../altimate/identity.json"
import { isolatedEnv } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

for (const branded of [false, true]) {
  for (const alias of [undefined, "stock-alias"]) {
    test(`${branded ? "branded" : "stock"} CLI identity${alias ? " with stock build alias" : ""}`, async () => {
      await using directory = await tmpdir()
      const name = branded ? identity.app : (alias ?? "opencode")
      const display = branded ? identity.displayName : "OpenCode"
      const run = async (entry: string, args: string[] = []) => {
        const child = Bun.spawn(
          [
            process.execPath,
            ...(branded
              ? ["--preload", path.resolve(import.meta.dir, "../../altimate/script/identity-preload.ts")]
              : []),
            ...(alias ? ["--define", `OPENCODE_CLI_NAME=${JSON.stringify(alias)}`] : []),
            entry,
            ...args,
          ],
          {
            cwd: path.resolve(import.meta.dir, ".."),
            env: isolatedEnv(directory.path),
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { stdout, stderr, exitCode }
      }
      const [help, version, hints, usage] = await Promise.all([
        run("./src/index.ts", ["--help"]),
        run("./src/index.ts", ["--version"]),
        run("./test/fixture/identity-cli.ts"),
        run("./src/index.ts", ["service", "get", "port", "extra"]),
      ])
      for (const result of [help, version, hints])
        expect({ code: result.exitCode, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
      expect(help.stdout).toContain(`${display} command line interface`)
      expect(help.stdout).toContain(`${name} <subcommand> [flags]`)
      expect(help.stdout).toContain(`Directory to start ${display} in`)
      expect(help.stdout).toContain(`Run ${display} with a message`)
      expect(version.stdout).toContain(`${name} v`)
      expect(usage.exitCode).not.toBe(0)
      expect(usage.stderr).toContain(`Usage: ${name} service get port`)
      const result = JSON.parse(hints.stdout)
      expect(result.cliName).toBe(name)
      expect(result.interactiveError).toBe(`${name} mini requires a controlling terminal for input`)
      expect(result.conflict).toBe(
        `Managed service port 55555 on 127.0.0.1 is already in use by another process. Configure another port with \`${name} service set port <port>\` and start the service again.`,
      )
      expect(result.preservesCause).toBe(true)
      expect(result.auth.description).toBe(`Run \`${name} auth login\` in the terminal`)
      expect(result.auth.name).toBe(`Login with ${name}`)
      expect(result.auth.id).toBe("opencode-login")
      expect(result.auth._meta["terminal-auth"]).toEqual({
        command: name,
        args: ["auth", "login"],
        label: `${display} Login`,
      })
      expect(result.standardAuth).toMatchObject({ type: "terminal", args: ["--login"] })
      expect(result.plainAuth._meta).toBeUndefined()
      expect(result.remoteWarning).toContain(`run \`${name} pair\``)
    }, 30_000)
  }
}
