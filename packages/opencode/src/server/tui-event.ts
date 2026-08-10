import { SessionID } from "@/session/schema"
import { PositiveInt } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Schema } from "effect"

const DEFAULT_TOAST_DURATION = 5000

export const TuiEvent = {
  PromptAppend: EventV2.define({ type: "tui.prompt.append", schema: { text: Schema.String } }),
  CommandExecute: EventV2.define({
    type: "tui.command.execute",
    schema: {
      command: Schema.Union([
        Schema.Literals([
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
        Schema.String,
      ]),
    },
  }),
  ToastShow: EventV2.define({
    type: "tui.toast.show",
    schema: {
      title: Schema.optional(Schema.String),
      message: Schema.String,
      variant: Schema.Literals(["info", "success", "warning", "error"]),
      duration: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_TOAST_DURATION))).annotate({
        description: "Duration in milliseconds",
      }),
    },
  }),
  SessionSelect: EventV2.define({
    type: "tui.session.select",
    schema: {
      sessionID: SessionID.annotate({ description: "Session ID to navigate to" }),
    },
  }),
  // altimate_change start — WorkspaceLink Path B trigger (docs/workspace-plan/CONTRACT.md §3).
  // Published from the `project_scan` tool.execute.after hook
  // (altimate/plugin/onboarding-telemetry.ts) once a scan completes, behind
  // Flag.ALTIMATE_WORKSPACE_LINK. The TUI subscribes to this (app.tsx) to open the deterministic
  // native Y/N consent dialog — never LLM prompt text. Carries a small display-only summary (not
  // the full scan payload) so the dialog can render its consent card without an extra round trip;
  // the actual creation call (which reads the fuller workspace_link_scan_cache row server-side)
  // only happens if the user says Yes.
  WorkspaceLinkOffer: EventV2.define({
    type: "tui.workspacelink.offer",
    schema: {
      // altimate_change — project name, so the consent card can show a "project" line matching
      // BRIEF.md's itemized consent block exactly (name/remote/adapter/models) — the createDevice
      // handler already sends this server-side (instance.project.name); it just wasn't in what
      // gets shown to the user before they say yes.
      name: Schema.NullOr(Schema.String),
      adapter: Schema.NullOr(Schema.String),
      gitRemote: Schema.NullOr(Schema.String),
      modelCount: Schema.NullOr(Schema.Number),
      hasWarehouse: Schema.Boolean,
    },
  }),
  // altimate_change end
}
