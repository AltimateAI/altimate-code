import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

async function withInstance(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn })
}

describe("/feedback command", () => {
  describe("command registration", () => {
    test("feedback is present in default commands", async () => {
      await withInstance(async () => {
        const commands = await Command.list()
        const names = commands.map((c) => c.name)
        expect(names).toContain("feedback")
      })
    })

    test("feedback command has correct metadata", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("feedback")
        expect(cmd).toBeDefined()
        expect(cmd.name).toBe("feedback")
        expect(cmd.source).toBe("command")
        expect(cmd.description).toBe("submit product feedback as a GitHub issue")
      })
    })

    test("feedback is in Command.Default constants", () => {
      expect(Command.Default.FEEDBACK).toBe("feedback")
    })
  })

  describe("template content", () => {
    test("template references feedback_submit tool", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("feedback")
        const template = await cmd.template
        expect(template).toContain("feedback_submit")
      })
    })

    test("template has $ARGUMENTS placeholder", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("feedback")
        expect(cmd.hints).toContain("$ARGUMENTS")
      })
    })

    test("template mentions all four categories", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("feedback")
        const template = await cmd.template
        expect(template).toContain("bug")
        expect(template).toContain("feature")
        expect(template).toContain("improvement")
        expect(template).toContain("ux")
      })
    })

    test("template describes the multi-step collection flow", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("feedback")
        const template = await cmd.template
        // Should have steps for collecting feedback details
        expect(template).toContain("Title")
        expect(template).toContain("Category")
        expect(template).toContain("Description")
      })
    })

    test("template mentions session context opt-in", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("feedback")
        const template = await cmd.template
        expect(template).toContain("include_context")
        expect(template).toContain("session context")
      })
    })

    test("template warns about not including credentials", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("feedback")
        const template = await cmd.template
        expect(template).toContain("credentials")
      })
    })

    test("template includes confirmation step", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("feedback")
        const template = await cmd.template
        expect(template).toContain("confirm")
      })
    })
  })

  describe("command isolation", () => {
    test("feedback command is not a subtask", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("feedback")
        expect(cmd.subtask).toBeUndefined()
      })
    })

    test("feedback command has source 'command'", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("feedback")
        expect(cmd.source).toBe("command")
      })
    })

    test("feedback does not interfere with other default commands", async () => {
      await withInstance(async () => {
        const commands = await Command.list()
        const names = commands.map((c) => c.name)
        expect(names).toContain("init")
        expect(names).toContain("discover")
        expect(names).toContain("review")
        expect(names).toContain("feedback")
      })
    })
  })
})
