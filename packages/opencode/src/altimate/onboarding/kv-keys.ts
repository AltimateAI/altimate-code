/**
 * KV storage keys for the first-run activation feature.
 *
 * These keys live in `Global.Path.state/kv.json`, which is externally durable
 * across launches, npm upgrades, npx invocations, and switching between
 * global-vs-local installs (verified via packages/tui/src/context/kv.tsx —
 * writes with `Flock` + `writeJsonAtomic` to an XDG state file outside the
 * package).
 *
 * Split into four keys (rather than one blob) so the state machine stays
 * inspectable — a support engineer can look at any single key without
 * decoding a struct. And a divergence between KV and the on-disk sample
 * marker (see marker.ts) is easier to reason about with distinct keys.
 *
 * Naming convention: `onboarding.<what>` so grep-by-prefix reveals every
 * key this feature touches.
 */

/** ISO timestamp when the user last dismissed the activation dialog (either
 *  by explicit "not now" OR by making any choice). Once set, the activation
 *  dialog does not auto-fire on future launches. The `/activation` slash
 *  command is the escape hatch that re-opens it manually. */
export const KV_ACTIVATION_DISMISSED_AT = "onboarding.activation.dismissed_at"

/** Which choice the user made when they first engaged with the dialog. */
export const KV_ACTIVATION_COMPLETED_CHOICE = "onboarding.activation.completed_choice"

/** Absolute path where the sample project was materialized on this machine.
 *  Convenience index — the marker file at that path is the authoritative
 *  source of truth for "does the sample still exist and is it ours?".
 *  If KV points at a path that no longer exists / has no marker /
 *  marker version doesn't match, KV gets rewritten on the next /starter. */
export const KV_SAMPLE_PROJECT_PATH = "onboarding.sample_project.path"

/** Version of the sample that was materialized. Mirrors the marker file's
 *  `version` field. Used to detect drift when a user upgrades the CLI —
 *  a bumped sample version can trigger an upgrade-in-place offer. */
export const KV_SAMPLE_PROJECT_VERSION = "onboarding.sample_project.version"

/** Enum of choices the user can pick in the activation dialog. Persisted
 *  as-is into KV_ACTIVATION_COMPLETED_CHOICE. */
export const ACTIVATION_CHOICES = ["connect_data", "sample_project", "describe_use_case", "dismissed"] as const
export type ActivationChoice = (typeof ACTIVATION_CHOICES)[number]
