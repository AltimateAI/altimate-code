import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "@/session/schema"
import z from "zod"

export const TuiEvent = {
  PromptAppend: BusEvent.define("tui.prompt.append", z.object({ text: z.string() })),
  CommandExecute: BusEvent.define(
    "tui.command.execute",
    z.object({
      command: z.union([
        z.enum([
          "session.list",
          "session.new",
          "session.share",
          "session.interrupt",
          "session.compact",
          "session.page.up",
          "session.page.down",
          "session.line.up",
          "session.line.down",
          "session.half.page.up",
          "session.half.page.down",
          "session.first",
          "session.last",
          "prompt.clear",
          "prompt.submit",
          "agent.cycle",
        ]),
        z.string(),
      ]),
    }),
  ),
  ToastShow: BusEvent.define(
    "tui.toast.show",
    z.object({
      title: z.string().optional(),
      message: z.string(),
      variant: z.enum(["info", "success", "warning", "error"]),
      duration: z.number().default(5000).optional().describe("Duration in milliseconds"),
    }),
  ),
  SessionSelect: BusEvent.define(
    "tui.session.select",
    z.object({
      sessionID: SessionID.zod.describe("Session ID to navigate to"),
    }),
  ),
  // altimate_change — onboarding activation menu: the agent composes the options
  // (per branch) and hands them to the TUI to render as an arrow-selectable picker
  // instead of a plain-text numbered list. Selecting a row submits that label as
  // the user's next message. Fired by the `activation_menu` tool.
  ActivationMenuShow: BusEvent.define(
    "tui.activation.menu.show",
    z.object({
      intro: z.string().optional().describe("Short lead-in line shown above the options"),
      options: z.array(z.string()).min(2).max(6).describe("Job labels; the selected one is submitted as the next message"),
    }),
  ),
}
