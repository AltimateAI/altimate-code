import z from "zod"
import { Tool } from "./tool"

export const WebSearchTool = Tool.define("websearch", {
  description: "Search the web for information.",
  parameters: z.object({
    query: z.string().describe("The search query"),
  }),
  async execute(input) {
    // TODO: Implement web search integration
    return {
      output: "Web search is not yet implemented.",
      title: "Web Search",
      metadata: {},
    }
  },
})
