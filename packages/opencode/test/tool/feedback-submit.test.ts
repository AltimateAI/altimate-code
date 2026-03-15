import { describe, expect, test, beforeEach, afterAll } from "bun:test"
import Bun from "bun"

// ---------------------------------------------------------------------------
// Mock state — controls what the mocked bun `$` returns per sequential call
// ---------------------------------------------------------------------------

let shellResults: Array<{
  text: string
  exitCode: number
  throw?: boolean
}> = []
let shellCallIndex = 0
let shellCalls: string[][] = []

function resetShellMock() {
  shellResults = []
  shellCallIndex = 0
  shellCalls = []
}

function pushShellResult(text: string, exitCode = 0) {
  shellResults.push({ text, exitCode })
}

function pushShellThrow() {
  shellResults.push({ text: "", exitCode: 1, throw: true })
}

// ---------------------------------------------------------------------------
// Replace Bun.$ with a controllable mock BEFORE importing the tool module.
// The tool does `import Bun from "bun"` — since Bun.$ is writable,
// replacing it here means dynamically imported modules will pick up our mock.
// ---------------------------------------------------------------------------

const originalBunShell = Bun.$
afterAll(() => {
  Bun.$ = originalBunShell
})

Bun.$ = function mockedShell(strings: TemplateStringsArray, ...values: any[]) {
  const parts: string[] = []
  strings.forEach((s, i) => {
    parts.push(s)
    if (i < values.length) parts.push(String(values[i]))
  })
  shellCalls.push(parts)

  const idx = shellCallIndex++
  const result = shellResults[idx] || { text: "", exitCode: 1 }

  if (result.throw) {
    throw new Error("ENOENT: spawn failed")
  }

  const stdoutBuf = Buffer.from(result.text)
  const stderrBuf = Buffer.from("")

  const chainable = {
    quiet() {
      return chainable
    },
    nothrow() {
      return chainable
    },
    async text() {
      return result.text
    },
    exitCode: result.exitCode,
    stdout: stdoutBuf,
    stderr: stderrBuf,
  }
  return chainable
} as any

// ---------------------------------------------------------------------------
// Import module under test — AFTER mock setup
// ---------------------------------------------------------------------------

const { FeedbackSubmitTool } = await import("../../src/altimate/tools/feedback-submit")

// ---------------------------------------------------------------------------
// Shared test context
// ---------------------------------------------------------------------------

const ctx = {
  sessionID: "test-session-123",
  messageID: "test-message",
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
} as any

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool.feedback_submit", () => {
  beforeEach(() => {
    resetShellMock()
  })

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  describe("initialization", () => {
    test("has correct tool id", () => {
      expect(FeedbackSubmitTool.id).toBe("feedback_submit")
    })

    test("has correct description mentioning feedback and GitHub", async () => {
      const tool = await FeedbackSubmitTool.init()
      expect(tool.description).toContain("feedback")
      expect(tool.description).toContain("GitHub issue")
      expect(tool.description).toContain("gh")
    })

    test("has parameter schema defined", async () => {
      const tool = await FeedbackSubmitTool.init()
      expect(tool.parameters).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // Parameter validation
  // -------------------------------------------------------------------------

  describe("parameter validation", () => {
    test("accepts valid parameters with all fields", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({
        title: "Test issue",
        category: "bug",
        description: "Something is broken",
        include_context: true,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.title).toBe("Test issue")
        expect(result.data.category).toBe("bug")
        expect(result.data.description).toBe("Something is broken")
        expect(result.data.include_context).toBe(true)
      }
    })

    test("defaults include_context to false when omitted", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({
        title: "Test",
        category: "bug",
        description: "test",
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.include_context).toBe(false)
      }
    })

    test("rejects empty title", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({
        title: "",
        category: "bug",
        description: "test",
      })
      expect(result.success).toBe(false)
    })

    test("rejects whitespace-only title", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({
        title: "   ",
        category: "bug",
        description: "test",
      })
      expect(result.success).toBe(false)
    })

    test("rejects empty description", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({
        title: "Test",
        category: "bug",
        description: "",
      })
      expect(result.success).toBe(false)
    })

    test("rejects whitespace-only description", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({
        title: "Test",
        category: "bug",
        description: "   ",
      })
      expect(result.success).toBe(false)
    })

    test("rejects missing title", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({
        category: "bug",
        description: "test",
      })
      expect(result.success).toBe(false)
    })

    test("rejects missing category", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({
        title: "Test",
        description: "test",
      })
      expect(result.success).toBe(false)
    })

    test("rejects invalid category", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({
        title: "Test",
        category: "invalid-category",
        description: "test",
      })
      expect(result.success).toBe(false)
    })

    test("rejects missing description", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({
        title: "Test",
        category: "bug",
      })
      expect(result.success).toBe(false)
    })

    test("rejects empty object", async () => {
      const tool = await FeedbackSubmitTool.init()
      const result = tool.parameters.safeParse({})
      expect(result.success).toBe(false)
    })

    test("accepts all valid categories", async () => {
      const tool = await FeedbackSubmitTool.init()
      for (const category of ["bug", "feature", "improvement", "ux"]) {
        const result = tool.parameters.safeParse({
          title: "Test",
          category,
          description: "test",
        })
        expect(result.success).toBe(true)
      }
    })
  })

  // -------------------------------------------------------------------------
  // gh CLI not available
  // -------------------------------------------------------------------------

  describe("gh CLI not available", () => {
    test("returns error with install instructions when gh is not found", async () => {
      const tool = await FeedbackSubmitTool.init()

      // gh --version returns empty string (not found)
      pushShellResult("")

      const result = await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(result.title).toBe("Feedback submission failed")
      expect(result.metadata.error).toBe("gh_not_installed")
      expect(result.metadata.issueUrl).toBe("")
      expect(result.output).toContain("gh")
      expect(result.output).toContain("brew install gh")
      expect(result.output).toContain("gh auth login")
    })

    test("returns error when gh --version output does not start with 'gh version'", async () => {
      const tool = await FeedbackSubmitTool.init()

      pushShellResult("command not found: gh")

      const result = await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(result.title).toBe("Feedback submission failed")
      expect(result.metadata.error).toBe("gh_not_installed")
    })

    test("returns error when gh binary spawn throws ENOENT", async () => {
      const tool = await FeedbackSubmitTool.init()

      // Simulate ENOENT — binary not on PATH
      pushShellThrow()

      const result = await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(result.title).toBe("Feedback submission failed")
      expect(result.metadata.error).toBe("gh_not_installed")
    })
  })

  // -------------------------------------------------------------------------
  // gh auth status throws
  // -------------------------------------------------------------------------

  describe("gh auth status throws", () => {
    test("returns gh_auth_check_failed (not gh_not_installed) when auth check throws", async () => {
      const tool = await FeedbackSubmitTool.init()

      // gh --version succeeds
      pushShellResult("gh version 2.40.0")
      // gh auth status throws
      pushShellThrow()

      const result = await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(result.title).toBe("Feedback submission failed")
      expect(result.metadata.error).toBe("gh_auth_check_failed")
      expect(result.output).toContain("gh auth status")
    })
  })

  // -------------------------------------------------------------------------
  // gh CLI not authenticated
  // -------------------------------------------------------------------------

  describe("gh CLI not authenticated", () => {
    test("returns error with auth instructions when not logged in", async () => {
      const tool = await FeedbackSubmitTool.init()

      // gh --version succeeds
      pushShellResult("gh version 2.40.0")
      // gh auth status fails (exitCode !== 0)
      pushShellResult("", 1)

      const result = await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(result.title).toBe("Feedback submission failed")
      expect(result.metadata.error).toBe("gh_not_authenticated")
      expect(result.metadata.issueUrl).toBe("")
      expect(result.output).toContain("gh auth login")
    })
  })

  // -------------------------------------------------------------------------
  // Successful issue creation
  // -------------------------------------------------------------------------

  describe("successful issue creation", () => {
    test("returns success with issue URL", async () => {
      const tool = await FeedbackSubmitTool.init()

      // gh --version
      pushShellResult("gh version 2.40.0")
      // gh auth status — exitCode 0
      pushShellResult("Logged in as user", 0)
      // gh issue create — returns URL
      pushShellResult("https://github.com/AltimateAI/altimate-code/issues/42")

      const result = await tool.execute(
        {
          title: "Test feedback",
          category: "bug" as const,
          description: "Something is broken",
          include_context: false,
        },
        ctx,
      )

      expect(result.title).toBe("Feedback submitted")
      expect(result.metadata.error).toBe("")
      expect(result.metadata.issueUrl).toBe(
        "https://github.com/AltimateAI/altimate-code/issues/42",
      )
      expect(result.output).toContain("successfully")
      expect(result.output).toContain(
        "https://github.com/AltimateAI/altimate-code/issues/42",
      )
    })

    test("returns failure when issue creation output has no github URL", async () => {
      const tool = await FeedbackSubmitTool.init()

      // gh --version
      pushShellResult("gh version 2.40.0")
      // gh auth status
      pushShellResult("Logged in as user", 0)
      // gh issue create fails with unexpected output
      pushShellResult("some error occurred")

      const result = await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(result.title).toBe("Feedback submission failed")
      expect(result.metadata.error).toBe("issue_creation_failed")
      expect(result.output).toContain("Failed to create GitHub issue")
    })

    test("returns failure when issue creation returns empty output", async () => {
      const tool = await FeedbackSubmitTool.init()

      pushShellResult("gh version 2.40.0")
      pushShellResult("Logged in", 0)
      pushShellResult("")

      const result = await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(result.title).toBe("Feedback submission failed")
      expect(result.metadata.error).toBe("issue_creation_failed")
    })

    test("returns failure when issue creation has non-zero exitCode even with stdout", async () => {
      const tool = await FeedbackSubmitTool.init()

      pushShellResult("gh version 2.40.0")
      pushShellResult("Logged in", 0)
      // gh issue create exits non-zero (e.g. label doesn't exist) with partial output
      shellResults.push({ text: "https://github.com/AltimateAI/altimate-code/issues/1", exitCode: 1 })

      const result = await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(result.title).toBe("Feedback submission failed")
      expect(result.metadata.error).toBe("issue_creation_failed")
    })

    test("returns failure when issue creation throws", async () => {
      const tool = await FeedbackSubmitTool.init()

      pushShellResult("gh version 2.40.0")
      pushShellResult("Logged in", 0)
      // gh issue create throws ENOENT
      pushShellThrow()

      const result = await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(result.title).toBe("Feedback submission failed")
      expect(result.metadata.error).toBe("issue_creation_failed")
    })
  })

  // -------------------------------------------------------------------------
  // Category label mapping
  // -------------------------------------------------------------------------

  describe("category label mapping", () => {
    async function createIssueWithCategory(category: string) {
      const tool = await FeedbackSubmitTool.init()
      resetShellMock()

      pushShellResult("gh version 2.40.0")
      pushShellResult("Logged in", 0)
      pushShellResult("https://github.com/AltimateAI/altimate-code/issues/1")

      await tool.execute(
        {
          title: "Test",
          category: category as any,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      // The third shell call is the gh issue create command
      // shellCalls[2] contains the template string parts + interpolated values
      return shellCalls[2]
    }

    test("maps 'bug' to 'bug' label", async () => {
      const callParts = await createIssueWithCategory("bug")
      const joined = callParts.join("")
      expect(joined).toContain("user-feedback,from-cli,bug")
    })

    test("maps 'feature' to 'enhancement' label", async () => {
      const callParts = await createIssueWithCategory("feature")
      const joined = callParts.join("")
      expect(joined).toContain("user-feedback,from-cli,enhancement")
    })

    test("maps 'improvement' to 'improvement' label", async () => {
      const callParts = await createIssueWithCategory("improvement")
      const joined = callParts.join("")
      expect(joined).toContain("user-feedback,from-cli,improvement")
    })

    test("maps 'ux' to 'ux' label", async () => {
      const callParts = await createIssueWithCategory("ux")
      const joined = callParts.join("")
      expect(joined).toContain("user-feedback,from-cli,ux")
    })
  })

  // -------------------------------------------------------------------------
  // Metadata in issue body
  // -------------------------------------------------------------------------

  describe("metadata in issue body", () => {
    async function getIssueBody(includeContext: boolean) {
      const tool = await FeedbackSubmitTool.init()
      resetShellMock()

      pushShellResult("gh version 2.40.0")
      pushShellResult("Logged in", 0)
      pushShellResult("https://github.com/AltimateAI/altimate-code/issues/1")

      await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "My feedback description",
          include_context: includeContext,
        },
        ctx,
      )

      // The third call is gh issue create; join interpolated parts to get full command
      const callParts = shellCalls[2]
      return callParts.join("")
    }

    test("includes CLI version in issue body", async () => {
      const body = await getIssueBody(false)
      expect(body).toContain("CLI Version")
    })

    test("includes platform info in issue body", async () => {
      const body = await getIssueBody(false)
      expect(body).toContain("Platform")
      expect(body).toContain(process.platform)
    })

    test("includes architecture in issue body", async () => {
      const body = await getIssueBody(false)
      expect(body).toContain("Architecture")
      expect(body).toContain(process.arch)
    })

    test("includes OS release in issue body", async () => {
      const os = await import("os")
      const body = await getIssueBody(false)
      expect(body).toContain("OS Release")
      expect(body).toContain(os.release())
    })

    test("includes category in issue body", async () => {
      const body = await getIssueBody(false)
      expect(body).toContain("Category")
    })

    test("includes description text in issue body", async () => {
      const body = await getIssueBody(false)
      expect(body).toContain("My feedback description")
    })

    test("includes session context when include_context is true", async () => {
      const body = await getIssueBody(true)
      expect(body).toContain("Working Directory")
      expect(body).toContain("Session ID")
      expect(body).toContain("test-session-123")
    })

    test("excludes session context when include_context is false", async () => {
      const body = await getIssueBody(false)
      expect(body).not.toContain("Working Directory")
      expect(body).not.toContain("Session ID")
    })
  })

  // -------------------------------------------------------------------------
  // Issue creation targets correct repo
  // -------------------------------------------------------------------------

  describe("issue creation", () => {
    test("targets the AltimateAI/altimate-code repository", async () => {
      const tool = await FeedbackSubmitTool.init()

      pushShellResult("gh version 2.40.0")
      pushShellResult("Logged in", 0)
      pushShellResult("https://github.com/AltimateAI/altimate-code/issues/1")

      await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      const createCall = shellCalls[2].join("")
      expect(createCall).toContain("AltimateAI/altimate-code")
    })

    test("passes the title to gh issue create", async () => {
      const tool = await FeedbackSubmitTool.init()

      pushShellResult("gh version 2.40.0")
      pushShellResult("Logged in", 0)
      pushShellResult("https://github.com/AltimateAI/altimate-code/issues/1")

      await tool.execute(
        {
          title: "My specific title",
          category: "feature" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      const createCall = shellCalls[2].join("")
      expect(createCall).toContain("My specific title")
    })

    test("makes exactly 3 shell calls for successful submission", async () => {
      const tool = await FeedbackSubmitTool.init()

      pushShellResult("gh version 2.40.0")
      pushShellResult("Logged in", 0)
      pushShellResult("https://github.com/AltimateAI/altimate-code/issues/1")

      await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(shellCalls.length).toBe(3)
    })

    test("makes only 1 shell call when gh is not installed", async () => {
      const tool = await FeedbackSubmitTool.init()

      pushShellResult("")

      await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(shellCalls.length).toBe(1)
    })

    test("makes only 2 shell calls when gh is not authenticated", async () => {
      const tool = await FeedbackSubmitTool.init()

      pushShellResult("gh version 2.40.0")
      pushShellResult("", 1)

      await tool.execute(
        {
          title: "Test",
          category: "bug" as const,
          description: "test",
          include_context: false,
        },
        ctx,
      )

      expect(shellCalls.length).toBe(2)
    })
  })
})
