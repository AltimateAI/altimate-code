// altimate_change - new file
//
// On-demand reload of this session's workspace memory.
//
// `hydrate` is idempotent for the life of a session — deliberately, so the
// per-turn injection stays cheap. The cost is that a session started before a
// teammate (or this user on another machine) wrote a block never sees it. This
// tool is the "on user's demand" half of the requirement: the user asks, the
// agent calls this, and the session picks up everything written since.
import z from "zod"
import { Tool } from "../../tool/tool"
import { refresh, isEnabled } from "@/altimate/workspace/memory-sync"

export const MemoryRefreshTool = Tool.define("altimate_memory_refresh", {
  description: [
    "Reload memory from the Altimate workspace this project is linked to.",
    "",
    "Use when the user asks to refresh, reload, re-read or re-sync memory, or",
    "says a teammate added something they want picked up now. A session loads",
    "workspace memory once at start; anything written after that is invisible",
    "until this runs.",
    "",
    "Does nothing when the project is not linked to a workspace.",
  ].join("\n"),
  parameters: z.object({}),
  async execute(_args, ctx) {
    if (!isEnabled()) {
      return {
        title: "Memory: workspace sync off",
        metadata: { success: false, refreshed: false, count: 0, reason: "off" },
        output: "Workspace memory is not enabled, so there is nothing to reload.",
      }
    }
    if (!ctx?.sessionID) {
      return {
        title: "Memory: no session",
        metadata: { success: false, refreshed: false, count: 0, reason: "no-session" },
        output: "No session context, so there is no memory overlay to reload.",
      }
    }
    try {
      const { count, ok, status } = await refresh(ctx.sessionID)
      if (!ok) {
        // Each of these is a distinct thing to tell the user. Collapsing them
        // into "reloaded, nothing here" is how an unreachable workspace reads
        // as an empty one.
        const message =
          status === "error"
            ? `Could not reach the workspace, so memory was not reloaded. This session still has its existing ${count} block(s).`
            : status === "unlinked"
              ? "This project is not linked to a workspace, so there is no workspace memory to load."
              : "This workspace has memory turned off, so there is nothing to load."
        return {
          title:
            status === "error"
              ? "Memory: could not reach the workspace"
              : status === "unlinked"
                ? "Memory: project not linked"
                : "Memory: workspace memory disabled",
          metadata: { success: false, refreshed: false, count, reason: status },
          output: message,
        }
      }
      return {
        title: `Memory: reloaded ${count} workspace block(s)`,
        metadata: { success: true, refreshed: true, count, reason: status },
        output:
          count === 0
            ? "Reloaded workspace memory. This workspace has no memory blocks visible to this project."
            : `Reloaded workspace memory: ${count} block(s) now available. Use altimate_memory_read to see them.`,
      }
    } catch (e) {
      // Never fail the turn over a refresh — the session keeps whatever it had.
      return {
        title: "Memory: reload failed",
        metadata: { success: false, refreshed: false, count: 0, reason: "exception" },
        output: `Could not reload workspace memory: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  },
})
