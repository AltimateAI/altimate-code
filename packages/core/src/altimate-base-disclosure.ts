// altimate_change start — the single definition of the Altimate Base disclosure notice.
//
// Altimate Base auto-registers with no consent gate — this text is shown once, as a notice, either
// right after registration or (for a headless surface) alongside it, not as a blocking prompt
// before any credential is minted. It must still be identical everywhere it's shown. Two packages
// render it and neither can import from the other: the TUI's onboarding notice (`packages/tui`)
// and the HTTP disclosure route that serves hosts rendering their own notice (`packages/opencode`,
// for the VS Code extension's chat panel). `packages/core` is the only module both already depend
// on, so the constant lives here.
//
// A new leaf file rather than an addition to an existing core module, so it adds no upstream
// rebase surface.
//
// It states the core data terms up front. The persistent per-install-id linkage detail is
// disclosed in docs/docs/configure/providers.md ("Data handling") rather than repeated in the
// notice (see #1268); keep the core terms in sync with that note.
export const ALTIMATE_BASE_DISCLOSURE =
  "Altimate Base is free and requires no signup. Requests and responses may be logged and used to improve Altimate's products, including the model. Secrets are automatically masked before storage, but don't rely on it — avoid sending secrets or confidential code. Usage can be rate limited."

/**
 * The one-line subtitle shown next to Altimate Base in a provider or model picker. Shared for the
 * same reason as the disclosure: it previously existed in three drifting variants across the TUI
 * pickers and the extension.
 */
export const ALTIMATE_BASE_HINT = "free · no signup · rate limited"
// altimate_change end
