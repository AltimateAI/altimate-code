// altimate_change — what `altimate-code run --output <file>` writes.
//
// The file is the answer, not the transcript. A model often narrates between tool
// calls ("Mixed time formats. Let me check all formats.") and that text is superseded
// by the step that follows it; only the text of the last model step is the reply.
// Everything is still kept so a run that ended without a final reply (silent turn,
// error line) writes what it has instead of the placeholder.

export const NO_TEXT_OUTPUT = "(no text output — tool-only response)"

export class OutputCollector {
  private readonly all: string[] = []
  private final: string[] = []

  /** A new model step starts; text before it is no longer the reply. Compaction steps do not count. */
  stepStart(compaction = false) {
    if (!compaction) this.final = []
  }

  /** Completed assistant text. Synthetic/compaction text is kept for the fallback only. */
  text(text: string, opts: { synthetic?: boolean; compaction?: boolean } = {}) {
    const trimmed = text.trim()
    if (!trimmed) return
    this.all.push(trimmed)
    if (!opts.synthetic && !opts.compaction) this.final.push(trimmed)
  }

  /** A harness-generated line (e.g. the silent-turn notice) that belongs in the file when there is no reply. */
  note(line: string) {
    if (line.trim()) this.all.push(line.trim())
  }

  content(): string {
    return (this.final.length ? this.final : this.all).join("\n\n") || NO_TEXT_OUTPUT
  }
}
