// altimate_change — what `altimate-code run --output <file>` writes.
//
// The file is the answer, not the transcript. A model often narrates between tool
// calls ("Mixed time formats. Let me check all formats.") and that text is superseded
// by the step that follows it; only the text of the last model step is the reply.
// Everything is still kept so a run that ended without a final reply (silent turn,
// error line) writes what it has instead of the placeholder.

import { DONE_TOKEN } from "../../session/termination"

export const NO_TEXT_OUTPUT = "(no text output — tool-only response)"

// The completion check and the post-compaction nudge ask the model to reply with the bare
// token when the deliverable is already complete; that acknowledgement is not a new reply.
const ACKNOWLEDGEMENT = new RegExp(`^${DONE_TOKEN}\\.?$`, "i")

export class OutputCollector {
  private readonly all: string[] = []
  private final: string[] = []
  private previous: string[] = []

  /** A new model step starts; text before it is no longer the reply. Compaction steps do not count. */
  stepStart(compaction = false) {
    if (compaction) return
    if (this.final.length) this.previous = this.final
    this.final = []
  }

  /** Completed assistant text. Synthetic/compaction text is kept for the fallback only. */
  text(text: string, opts: { synthetic?: boolean; compaction?: boolean } = {}) {
    const trimmed = text.trim()
    if (!trimmed) return
    this.all.push(trimmed)
    if (opts.synthetic || opts.compaction) return
    if (ACKNOWLEDGEMENT.test(trimmed) && this.final.length === 0) {
      this.final = this.previous
      return
    }
    this.final.push(trimmed)
  }

  private readonly notes: string[] = []

  /** A harness-generated line (silent turn, exhausted budget) that explains why there is no reply. */
  note(line: string) {
    if (line.trim()) this.notes.push(line.trim())
  }

  /**
   * The reply when there is one; otherwise the harness notes alone (earlier commentary is not
   * an answer and would read as one); otherwise everything that was said.
   */
  content(): string {
    const chosen = this.final.length ? this.final : this.notes.length ? this.notes : this.all
    return chosen.join("\n\n") || NO_TEXT_OUTPUT
  }
}
