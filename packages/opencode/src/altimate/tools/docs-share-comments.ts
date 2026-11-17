import z from "zod"
import { Tool } from "../../tool/tool"

export const DocsShareCommentsTool = Tool.define("docs_share_comments", {
  description: "Comment threads on shared dbt docs: list open threads, reply to one, or resolve one.",
  parameters: z.object({
    action: z.enum(["list", "reply", "resolve"]).describe("What to do"),
    project: z.string().optional().describe("dbt project name the shared docs belong to"),
    share_id: z.number().int().optional().describe("Shared docs id"),
    group_id: z.number().int().optional().describe("Comment thread id"),
    text: z.string().optional().describe("Reply text"),
  }),
  async execute() {
    return {
      title: "docs_share_comments: not implemented",
      metadata: { success: false, error: "not implemented" },
      output: "docs_share_comments is not implemented in this build of altimate-code yet.",
    }
  },
})
