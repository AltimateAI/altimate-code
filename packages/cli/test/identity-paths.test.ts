// altimate: ALT-F01
import path from "node:path"
import { expect, test } from "bun:test"
import identity from "../../altimate/identity.json"
import { tmpdir } from "./fixture/tmpdir"

for (const branded of [false, true]) {
  for (const [channel, suffix] of [
    ["latest", ""],
    ["prod", ""],
    ["local", "-local"],
    ["preview/branch", "-preview-branch"],
  ]) {
    test(`${branded ? "branded" : "stock"} ${channel} database, log and snapshot filenames`, async () => {
      await using directory = await tmpdir()
      const app = branded ? identity.app : "opencode"
      const subprocess = Bun.spawn(
        [
          process.execPath,
          "--define",
          `OPENCODE_CHANNEL=${JSON.stringify(channel)}`,
          ...(branded ? ["--define", `globalThis.__OPENCODE_IDENTITY__=${JSON.stringify(identity)}`] : []),
          "./test/fixture/identity-paths.ts",
          directory.path,
          suffix,
        ],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: {
            ...process.env,
            HOME: directory.path,
            XDG_DATA_HOME: path.join(directory.path, "data"),
            XDG_CONFIG_HOME: path.join(directory.path, "config"),
            XDG_CACHE_HOME: path.join(directory.path, "cache"),
            XDG_STATE_HOME: path.join(directory.path, "state"),
            OPENCODE_DB: undefined,
            ALTIMATE_CLI_DB: undefined,
            OPENCODE_DISABLE_CHANNEL_DB: undefined,
            ALTIMATE_CLI_DISABLE_CHANNEL_DB: undefined,
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
      expect(exitCode, stderr).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.databases.fresh.path).toBe(path.join(directory.path, "fresh", `${app}${suffix}.db`))
      expect(result.databases.both.path).toBe(path.join(directory.path, "both", `${app}${suffix}.db`))
      for (const [name, legacy] of [
        ["legacy", `opencode${suffix}.db`],
        ["v1", "opencode.db"],
      ]) {
        if (!branded) {
          expect(result.databases[name].path).toBe(path.join(directory.path, name, `${app}${suffix}.db`))
          continue
        }
        expect(result.databases[name].error).toContain(path.join(directory.path, name, legacy))
        expect(result.databases[name].error).toContain(path.join(directory.path, name, `${app}${suffix}.db`))
        expect(result.databases[name].error).toContain(`Set ${identity.envPrefixes[0]}DB to `)
        expect(result.databases[name].error).toContain("No data was moved")
      }
      expect(result.explicitLegacy).toBe(path.join(directory.path, "legacy", `opencode${suffix}.db`))
      expect(result.absolute).toBe(path.join(directory.path, "absolute.db"))
      expect(result.memory).toBe(":memory:")
      expect(result.disabled).toEqual(Array(2).fill(path.join(directory.path, "fresh", `${app}.db`)))
      expect(result.preserved).toBe("legacy sentinel")
      expect(result.legacyUnchanged).toBe(true)
      expect(result.legacyFiles.sort()).toEqual([
        `opencode${suffix}.db`,
        `opencode${suffix}.db-shm`,
        `opencode${suffix}.db-wal`,
      ])
      expect(result.logs.map((file: string) => path.basename(file))).toEqual([
        `${app}.log`,
        `${app}-local.log`,
        `${app}-preview-branch.log`,
      ])
      expect(result.snapshotFiles).toContain(`${app}.gitconfig`)
      if (branded) expect(result.snapshotFiles).not.toContain("opencode.gitconfig")
      expect(result.snapshotConfig.split(`path = ${app}.gitconfig`)).toHaveLength(2)
    }, 30_000)
  }
}
