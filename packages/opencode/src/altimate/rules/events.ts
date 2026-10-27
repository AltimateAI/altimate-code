// altimate_change - new file
//
// Rule events on the Bus wildcard, so they reach `/event` (the TUI, and the IDE extension later). A client
// renders `rule.proposal.asked` as the proposal card and answers with `POST /rule-proposal/:id/reply`.
import z from "zod"
import { BusEvent } from "@/bus/bus-event"

export const ProposalCard = z.object({
  id: z.string(),
  sessionID: z.string(),
  text: z.string(),
  applies_to: z.array(z.string()),
  why: z.string().optional(),
  change: z.enum(["add", "edit", "retire"]),
  /** For an edit: the active rule it replaces, shown struck through. */
  replaces: z.object({ public_id: z.string(), text: z.string(), version: z.number().int() }).optional(),
  origin: z.enum(["session", "explicit"]),
  evidence: z.object({
    sessions: z.number().int(),
    correction: z.object({ excerpt: z.string(), at: z.string() }).optional(),
  }),
  chars: z.number().int(),
  weakens_verification: z.string().optional(),
  /** Absent when the project is not linked: the card then offers to save the rule for this project only. */
  workspace: z.object({ name: z.string(), owner_name: z.string().nullable().optional(), is_owner: z.boolean() }).optional(),
  actions: z.array(z.enum(["send", "approve", "edit", "dismiss", "save_local", "save_memory"])),
  /** The wording did not say rule or memory: the card asks "Save as: Memory · Team rule · Skip". */
  choose: z.boolean().optional(),
  /** Topics a "Not a rule" suppresses for 30 days. */
  topics: z.array(z.string()),
})
export type ProposalCard = z.infer<typeof ProposalCard>

export const Event = {
  Asked: BusEvent.define("rule.proposal.asked", ProposalCard),
  /** The card changed after an edit: same id, new text. */
  Updated: BusEvent.define("rule.proposal.updated", ProposalCard),
  Replied: BusEvent.define(
    "rule.proposal.replied",
    z.object({ id: z.string(), sessionID: z.string(), action: z.string(), message: z.string() }),
  ),
  /** The owner reviewed one of this person's proposals. */
  Reviewed: BusEvent.define(
    "rule.proposal.reviewed",
    z.object({
      public_id: z.string(),
      text: z.string(),
      status: z.string(),
      reason: z.string().optional(),
      reviewer: z.string().optional(),
    }),
  ),
  /** The local rules state changed (pull, send, review): clients refresh their summary. */
  Changed: BusEvent.define("altimate.rules.changed", z.object({ directory: z.string() })),
}

export * as RuleEvents from "./events"
