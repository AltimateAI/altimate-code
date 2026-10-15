// altimate: ALT-F01
import { expect, test } from "bun:test"

const identity = await Bun.file(`${import.meta.dir}/../../altimate/identity.json`).json()

const matrix = [
  { name: "primary only", primary: "primary", expected: "primary" },
  { name: "fallback only", fallback: "fallback", expected: "fallback" },
  { name: "both", primary: "primary", fallback: "fallback", expected: "primary" },
  { name: "empty primary", primary: "", fallback: "fallback", expected: "fallback" },
  { name: "false primary", primary: "false", fallback: "true", expected: "false" },
]

// The experimental name remains accepted by the generic reader; v2 removed its flag consumer.
const flags = ["CONFIG", "DISABLE_AUTOUPDATE", "SERVER_PASSWORD", "EXPERIMENTAL_DISABLE_FILEWATCHER", "FILEWATCHER_DISABLE"]

test("Altimate environment matrix uses nonempty primary values before upstream fallback", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `globalThis.__OPENCODE_IDENTITY__ = ${JSON.stringify(identity)};
       const { Env } = await import(${JSON.stringify(`${import.meta.dir}/../src/env.ts`)});
       const output = ${JSON.stringify(flags)}.map((flag) => ${JSON.stringify(matrix)}.map((entry) => Env.get("OPENCODE_" + flag, {
         ["ALTIMATE_CLI_" + flag]: entry.primary,
         ["OPENCODE_" + flag]: entry.fallback,
       })));
       process.stdout.write(JSON.stringify(output));`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual(flags.map(() => matrix.map((entry) => entry.expected)))
})

test("default environment lookup ignores Altimate names and preserves upstream empty strings", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const { Env } = await import(${JSON.stringify(`${import.meta.dir}/../src/env.ts`)});
       process.stdout.write(JSON.stringify([
         Env.get("OPENCODE_CONFIG", { ALTIMATE_CLI_CONFIG: "ignored", OPENCODE_CONFIG: "" }),
         Env.get("OPENCODE_DISABLE_AUTOUPDATE", { ALTIMATE_CLI_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_AUTOUPDATE: "false" }),
         Env.get("PATH", { PATH: "literal" }),
         Env.keys("OPENCODE_CONFIG"),
       ]));`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual(["", "false", "literal", ["OPENCODE_CONFIG"]])
})
