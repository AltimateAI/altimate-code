import z from "zod"
import { Tool } from "../../tool/tool"
// altimate_change — onboarding activation menu. Instead of printing a numbered
// text menu, the agent calls this tool with the options it composed for the
// current environment; the TUI renders them as an arrow-selectable picker (via
// the existing TuiEvent bus, same pattern as the post-scan toast). The user's
// selection is submitted as their next message, so the agent's routing logic is
// unchanged. Keeps the menu dynamic (the agent still decides the options) while
// making it navigable like the rest of the TUI.
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"

export const ActivationMenuTool = Tool.define("activation_menu", {
  description:
    "Show the onboarding activation menu as an interactive, arrow-selectable picker in the TUI, instead of printing a numbered text menu. Call this exactly once at the activation step. Pass a short intro line and the option labels (in job language, never slash commands) composed for what the current environment can do. The user selects one and their choice is sent back as their next message. After calling this, END your turn and wait for the selection; do not also print the menu as text.",
  parameters: z.object({
    intro: z
      .string()
      .optional()
      .describe(
        "Short lead-in shown above the options, e.g. a personalized summary like 'You've got 12 dbt models and a Snowflake connection.'",
      ),
    options: z
      .array(z.string())
      .min(2)
      .max(6)
      .describe("Option labels in job language (no slash commands). The selected label is submitted as the user's next message."),
  }),
  async execute(args) {
    await Bus.publish(TuiEvent.ActivationMenuShow, {
      intro: args.intro,
      options: args.options,
    })
    return {
      title: "Activation menu shown",
      metadata: { option_count: args.options.length },
      output: "Interactive activation menu shown to the user. Waiting for their selection (it arrives as their next message).",
    }
  },
})
