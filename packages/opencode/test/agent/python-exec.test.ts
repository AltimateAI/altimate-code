// altimate_change start — analyst-only Python registration and unchanged shell denial.
import { afterEach, beforeEach, expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import * as PythonExec from "../../src/altimate/tools/python-exec"
import { Permission } from "../../src/permission"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ToolRegistry } from "../../src/tool/registry"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Agent.defaultLayer, ToolRegistry.layer))
const model = { providerID: ProviderID.opencode, modelID: ModelID.make("test") }
let previousToggle: string | undefined
let available: ReturnType<typeof spyOn<typeof PythonExec, "pythonExecAvailable">>

beforeEach(() => {
  previousToggle = process.env.ALTIMATE_PYTHON_EXEC
  delete process.env.ALTIMATE_PYTHON_EXEC
  available = spyOn(PythonExec, "pythonExecAvailable").mockResolvedValue(true)
})

afterEach(() => {
  available.mockRestore()
  if (previousToggle === undefined) delete process.env.ALTIMATE_PYTHON_EXEC
  else process.env.ALTIMATE_PYTHON_EXEC = previousToggle
})

it.instance("analyst receives python_exec by default while bash stays denied", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const registry = yield* ToolRegistry.Service
    const analyst = yield* agents.get("analyst")
    expect(Permission.evaluate("python_exec", "*", analyst.permission).action).toBe("allow")
    expect(Permission.disabled(["bash"], analyst.permission)).toEqual(new Set(["bash"]))
    expect(Permission.evaluate("bash", "python3 script.py", analyst.permission).action).toBe("deny")
    const tools = yield* registry.tools({ ...model, agent: analyst })
    expect(tools.filter((tool) => tool.id === "python_exec")).toHaveLength(1)
  }),
)

it.instance("python_exec is not registered when Python dependencies are unavailable", () =>
  Effect.gen(function* () {
    available.mockResolvedValue(false)
    const agents = yield* Agent.Service
    const registry = yield* ToolRegistry.Service
    const analyst = yield* agents.get("analyst")
    const tools = yield* registry.tools({ ...model, agent: analyst })
    expect(tools.map((tool) => tool.id)).not.toContain("python_exec")
    expect(available).toHaveBeenCalled()
  }),
)

it.instance("ALTIMATE_PYTHON_EXEC=0 removes Python and can be toggled back on", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const registry = yield* ToolRegistry.Service
    const analyst = yield* agents.get("analyst")
    process.env.ALTIMATE_PYTHON_EXEC = "0"
    expect((yield* registry.tools({ ...model, agent: analyst })).map((tool) => tool.id)).not.toContain("python_exec")
    expect(available).not.toHaveBeenCalled()
    process.env.ALTIMATE_PYTHON_EXEC = "1"
    expect((yield* registry.tools({ ...model, agent: analyst })).map((tool) => tool.id)).toContain("python_exec")
  }),
)

it.instance("Python is absent for other agents and from the tool_lookup catalogue", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const registry = yield* ToolRegistry.Service
    for (const name of ["builder", "data-explorer", "reviewer", "plan"]) {
      const agent = yield* agents.get(name)
      expect((yield* registry.tools({ ...model, agent })).map((tool) => tool.id)).not.toContain("python_exec")
    }
    expect((yield* registry.tools(model)).map((tool) => tool.id)).not.toContain("python_exec")
    expect(yield* registry.ids()).not.toContain("python_exec")
    expect(available).not.toHaveBeenCalled()
    const explorer = yield* agents.get("data-explorer")
    expect(Permission.evaluate("python_exec", "*", explorer.permission).action).toBe("deny")
  }),
)
// altimate_change end
