import { expect, test } from "bun:test"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previousPassword = process.env.OPENCODE_PASSWORD
  const previousLegacyPassword = process.env.OPENCODE_SERVER_PASSWORD
  const previousValue = process.env.OPENCODE_SESSION_ENV_TEST
  process.env.OPENCODE_PASSWORD = "password"
  process.env.OPENCODE_SERVER_PASSWORD = "legacy"
  process.env.OPENCODE_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD
  else process.env.OPENCODE_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.OPENCODE_SESSION_ENV_TEST
  else process.env.OPENCODE_SESSION_ENV_TEST = previousValue

  expect(environment.OPENCODE_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SESSION_ENV_TEST).toBe("included")
})

// altimate: ALT-F01
test("Altimate server password matrix resolves through the Effect ConfigProvider and strips both namespaces", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `globalThis.__OPENCODE_IDENTITY__ = await Bun.file(${JSON.stringify(`${import.meta.dir}/../../altimate/identity.json`)}).json();
       const { ConfigProvider, Effect, Redacted } = await import("effect");
       const { Env } = await import(${JSON.stringify(`${import.meta.dir}/../src/env.ts`)});
       const cases = [
         { ALTIMATE_CLI_SERVER_PASSWORD: "primary" },
         { OPENCODE_SERVER_PASSWORD: "fallback" },
         { ALTIMATE_CLI_SERVER_PASSWORD: "primary", OPENCODE_SERVER_PASSWORD: "fallback" },
         { ALTIMATE_CLI_SERVER_PASSWORD: "", OPENCODE_SERVER_PASSWORD: "fallback" },
         { ALTIMATE_CLI_SERVER_PASSWORD: "false", OPENCODE_SERVER_PASSWORD: "true" },
         { ALTIMATE_CLI_SERVER_PASSWORD: "primary", OPENCODE_PASSWORD: "fallback" },
         { ALTIMATE_CLI_PASSWORD: "new", ALTIMATE_CLI_SERVER_PASSWORD: "legacy" },
       ];
       const values = await Promise.all(cases.map(async (env) => {
         const value = await Effect.runPromise(Env.password.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))));
         return value === undefined ? null : Redacted.value(value);
       }));
       process.env.ALTIMATE_CLI_PASSWORD = "primary";
       process.env.ALTIMATE_CLI_SERVER_PASSWORD = "legacy";
       process.env.OPENCODE_PASSWORD = "fallback";
       process.env.OPENCODE_SERVER_PASSWORD = "fallback-legacy";
       process.env.ALTIMATE_CLI_SESSION_ENV_TEST = "included";
       const session = Env.session();
       process.stdout.write(JSON.stringify({ values, credentials: Object.keys(session).filter((key) => /^(ALTIMATE_CLI_|OPENCODE_)(SERVER_)?PASSWORD$/.test(key)), included: session.ALTIMATE_CLI_SESSION_ENV_TEST }));`,
    ],
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual({
    values: ["primary", "fallback", "primary", "fallback", "false", "primary", "new"],
    credentials: [],
    included: "included",
  })
})
