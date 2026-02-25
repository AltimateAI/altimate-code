import z from "zod"
import { Tool } from "./tool"

export const CodeSearchTool = Tool.define("codesearch", {
  description: "Search for code symbols, definitions, and references across the codebase.",
  parameters: z.object({
    query: z.string().describe("The search query for code symbols"),
    path: z.string().optional().describe("Directory to search in"),
  }),
  async execute(input) {
    // TODO: Implement code search using tree-sitter or LSP
    return {
      output: "Code search is not yet implemented.",
      title: "Code Search",
      metadata: {},
    }
  },
})
