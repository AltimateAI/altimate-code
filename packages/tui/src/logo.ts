export const logo = {
  // altimate_change start — rebrand shared wordmark from opencode to the Altimate Code wordmark.
  // Clean 2-row block font (content in rows 1-2, rows 0/3 are padding); left = "ALTIMATE",
  // right = "CODE". NOTE: a lowercase 4-row variant was tried but rendered cramped/ambiguous through
  // the TUI subpixel renderer (thin half-block strokes collapse), so the uppercase wordmark is the
  // chosen mark. Guarded by test/upstream/fork-feature-guards.test.ts (rebrand present, not opencode).
  left: ["                                ", "▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀", "█▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄", "                                "],
  right: ["                 ", "█▀▀ █▀█ █▀▄ █▀▀", "█▄▄ █▄█ █▄▀ ██▄", "                 "],
  // altimate_change end
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
