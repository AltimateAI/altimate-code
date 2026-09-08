// altimate_change start — the single definition of the Altimate Base consent disclosure.
//
// This text is what a user actually consents against before any Base credential is minted, so it
// must be identical everywhere it is shown. Two packages render it and neither can import from the
// other: the TUI's disclosure dialog (`packages/tui`) and the HTTP disclosure route that serves
// hosts rendering their own dialog (`packages/opencode`, for the VS Code extension's chat panel).
// `packages/core` is the only module both already depend on, so the constant lives here.
//
// A new leaf file rather than an addition to an existing core module, so it adds no upstream
// rebase surface.
//
// It discloses that requests are linkable across launches rather than deferring that to
// docs/docs/configure/providers.md, which a user never sees before accepting. Keep it in sync with
// that fuller "Data handling" note.
export const ALTIMATE_BASE_DISCLOSURE =
  "Altimate Base is free and requires no signup. Requests and responses may be logged and used to improve Altimate's products, including the model. Secrets are automatically masked before storage, but don't rely on it — avoid sending secrets or confidential code. Logs are linked to a persistent per-installation identifier. Usage is rate limited."

/**
 * The one-line subtitle shown next to Altimate Base in a provider or model picker. Shared for the
 * same reason as the disclosure: it previously existed in three drifting variants across the TUI
 * pickers and the extension.
 */
export const ALTIMATE_BASE_HINT = "free · no signup · rate limited"
// altimate_change end
