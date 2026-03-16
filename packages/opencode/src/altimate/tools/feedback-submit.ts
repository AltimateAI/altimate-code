import z from "zod"
// Use Bun.$ (namespace access) instead of destructured $ to support test mocking
import Bun from "bun"
import os from "os"
import path from "path"
import { Tool } from "../../tool/tool"
import { Installation } from "@/installation"

const CATEGORY_LABELS = {
  bug: "bug",
  feature: "enhancement",
  improvement: "improvement",
  ux: "ux",
} satisfies Record<"bug" | "feature" | "improvement" | "ux", string>

export const FeedbackSubmitTool = Tool.define("feedback_submit", {
  description:
    "Submit user feedback as a GitHub issue to the altimate-code repository. " +
    "Creates an issue with appropriate labels and metadata. " +
    "Requires the `gh` CLI to be installed and authenticated.",
  parameters: z.object({
    title: z.string().trim().min(1).describe("A concise title for the feedback issue"),
    category: z
      .enum(["bug", "feature", "improvement", "ux"])
      .describe("The category of feedback: bug, feature, improvement, or ux"),
    description: z.string().trim().min(1).describe("Detailed description of the feedback"),
    include_context: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether to include session context (working directory basename, platform info) in the issue body"),
  }),
  async execute(args, ctx) {
    const ghNotInstalled = {
      title: "Feedback submission failed",
      metadata: { error: "gh_not_installed", issueUrl: "" },
      output:
        "The `gh` CLI is not installed. Please install it to submit feedback:\n" +
        "  - macOS: `brew install gh`\n" +
        "  - Linux: https://github.com/cli/cli/blob/trunk/docs/install_linux.md\n" +
        "  - Windows: `winget install GitHub.cli`\n\n" +
        "Then authenticate with: `gh auth login`",
    }

    // Check if gh CLI is available
    let ghVersion: string
    try {
      ghVersion = await Bun.$`gh --version`.quiet().nothrow().text()
    } catch {
      // ENOENT — gh binary not found on PATH
      return ghNotInstalled
    }
    if (!ghVersion.trim().startsWith("gh version")) {
      return ghNotInstalled
    }

    // Check if authenticated
    let authStatus: { exitCode: number }
    try {
      authStatus = await Bun.$`gh auth status`.quiet().nothrow()
    } catch {
      return {
        title: "Feedback submission failed",
        metadata: { error: "gh_auth_check_failed", issueUrl: "" },
        output:
          "Failed to verify `gh` authentication status. Please check your installation with:\n" + "  `gh auth status`",
      }
    }
    if (authStatus.exitCode !== 0) {
      return {
        title: "Feedback submission failed",
        metadata: { error: "gh_not_authenticated", issueUrl: "" },
        output:
          "The `gh` CLI is not authenticated. Please run:\n" +
          "  `gh auth login`\n\n" +
          "Then try submitting feedback again.",
      }
    }

    // Collect metadata
    const version = Installation.VERSION
    const platform = process.platform
    const arch = process.arch
    const osRelease = os.release()

    // Build issue body
    let body = `${args.description}\n\n`
    body += `---\n\n`
    body += `### Metadata\n\n`
    body += `| Field | Value |\n`
    body += `|-------|-------|\n`
    body += `| CLI Version | ${version} |\n`
    body += `| Platform | ${platform} |\n`
    body += `| Architecture | ${arch} |\n`
    body += `| OS Release | ${osRelease} |\n`
    body += `| Category | ${args.category} |\n`

    if (args.include_context) {
      const cwdBasename = path.basename(process.cwd()) || "unknown"
      body += `| Working Directory | ${cwdBasename} |\n`
      body += `| Session ID | ${ctx.sessionID} |\n`
    }

    // Build labels
    const labels = ["user-feedback", "from-cli", CATEGORY_LABELS[args.category]]

    // Create the issue — try with labels first, fall back without labels
    // if it fails (e.g. when labels don't exist in the repository yet)
    let issueResult: { stdout: Buffer; stderr: Buffer; exitCode: number }
    try {
      issueResult =
        await Bun.$`gh issue create --repo AltimateAI/altimate-code --title ${args.title} --body ${body} --label ${labels.join(",")}`
          .quiet()
          .nothrow()
    } catch {
      return {
        title: "Feedback submission failed",
        metadata: { error: "issue_creation_failed", issueUrl: "" },
        output:
          "Failed to create GitHub issue. The `gh` CLI encountered an unexpected error.\n\nPlease check your gh CLI installation and try again.",
      }
    }

    let stdout = issueResult.stdout.toString().trim()
    let stderr = issueResult.stderr.toString().trim()

    // If creation failed (e.g. missing labels), retry without labels
    if (issueResult.exitCode !== 0 || !stdout || !stdout.includes("github.com")) {
      try {
        issueResult = await Bun.$`gh issue create --repo AltimateAI/altimate-code --title ${args.title} --body ${body}`
          .quiet()
          .nothrow()
      } catch {
        return {
          title: "Feedback submission failed",
          metadata: { error: "issue_creation_failed", issueUrl: "" },
          output:
            "Failed to create GitHub issue. The `gh` CLI encountered an unexpected error.\n\nPlease check your gh CLI installation and try again.",
        }
      }

      stdout = issueResult.stdout.toString().trim()
      stderr = issueResult.stderr.toString().trim()
    }

    if (issueResult.exitCode !== 0 || !stdout || !stdout.includes("github.com")) {
      const errorDetail = stderr || stdout || "No output from gh CLI"
      return {
        title: "Feedback submission failed",
        metadata: { error: "issue_creation_failed", issueUrl: "" },
        output: `Failed to create GitHub issue.\n\n${errorDetail}\n\nPlease check your gh CLI authentication and try again.`,
      }
    }

    return {
      title: "Feedback submitted",
      metadata: { error: "", issueUrl: stdout },
      output: `Feedback submitted successfully!\n\nIssue URL: ${stdout}`,
    }
  },
})
