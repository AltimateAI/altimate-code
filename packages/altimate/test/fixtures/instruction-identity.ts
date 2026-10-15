import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { driverInstallDir } from "@altimateai/drivers/resolve"
import { claudeInstructions } from "../../src/instructions"
import { createFixture, createHost } from "../lib/host"

const scenarios = ["default", "config", "fallback", "false", "disable-code", "disable-prompt"]
const results = []
for (const scenario of scenarios) {
  await using fixture = await createFixture()
  const primary = join(fixture.path, "primary-home")
  const fallback = join(fixture.path, "fallback-home")
  await mkdir(join(fixture.path, "project"), { recursive: true })
  await Bun.write(join(primary, ".claude", "CLAUDE.md"), "primary-home-instructions")
  await Bun.write(join(fallback, ".claude", "CLAUDE.md"), "fallback-home-instructions")
  await Bun.write(join(fixture.path, "project", "CLAUDE.md"), "project-instructions")
  for (const key of Object.keys(process.env)) {
    if (
      /^(ALTIMATE_CLI_|OPENCODE_)(TEST_HOME|CONFIG_DIR|DISABLE_PROJECT_CONFIG|DISABLE_CLAUDE_CODE(_PROMPT)?)$/.test(key)
    )
      delete process.env[key]
  }
  process.env.ALTIMATE_CLI_TEST_HOME = primary
  process.env.OPENCODE_TEST_HOME = fallback
  process.env.XDG_CONFIG_HOME = join(fixture.path, "xdg-config")
  if (scenario === "default") {
    await Bun.write(join(process.env.XDG_CONFIG_HOME, "altimate-code", "AGENTS.md"), "brand-only-agents")
  }
  if (scenario === "config" || scenario === "fallback") {
    process.env.ALTIMATE_CLI_CONFIG_DIR = scenario === "fallback" ? "" : join(fixture.path, "primary-config")
    process.env.OPENCODE_CONFIG_DIR = join(fixture.path, "fallback-config")
    await Bun.write(
      join(fixture.path, scenario === "fallback" ? "fallback-config" : "primary-config", "AGENTS.md"),
      "selected-config-agents",
    )
  }
  if (scenario === "fallback") process.env.ALTIMATE_CLI_TEST_HOME = ""
  if (scenario === "false") {
    for (const suffix of ["DISABLE_PROJECT_CONFIG", "DISABLE_CLAUDE_CODE", "DISABLE_CLAUDE_CODE_PROMPT"]) {
      process.env[`ALTIMATE_CLI_${suffix}`] = "false"
      process.env[`OPENCODE_${suffix}`] = "true"
    }
  }
  if (scenario === "disable-code") process.env.ALTIMATE_CLI_DISABLE_CLAUDE_CODE = "true"
  if (scenario === "disable-prompt") process.env.ALTIMATE_CLI_DISABLE_CLAUDE_CODE_PROMPT = "true"

  const data = process.env.XDG_DATA_HOME
  delete process.env.XDG_DATA_HOME
  delete process.env.ALTIMATE_DRIVER_DIR
  const driverDirectory = driverInstallDir().replace(fixture.path, "<fixture>")
  process.env.XDG_DATA_HOME = data

  await using host = await createHost({
    directory: fixture.path,
    sessionDirectory: join(fixture.path, "project"),
    altimate: false,
    plugins: [claudeInstructions()],
  })
  const session = await host.createSession()
  await host.run(session.id, [])
  const system = host.model.calls[0].prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n")
  results.push({
    scenario,
    primary: system.includes("primary-home-instructions"),
    fallback: system.includes("fallback-home-instructions"),
    project: system.includes("project-instructions"),
    driverDirectory,
  })
}
console.log(JSON.stringify(results))
