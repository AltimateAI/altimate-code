// altimate_change start — shared "is this the keyless public Zen tier?" predicate, kept as a flat
// module (not a `Provider` namespace member; see packages/opencode/AGENTS.md "Module shape").
//
// OpenCode Zen's free tier rejects keyless traffic outright (2026-09-17), so every place that
// weighs public Zen against registered Altimate Base must agree on what "public Zen" means. A
// provider counts only when it is the built-in `opencode` provider AND was auto-configured with the
// `"public"` placeholder key AND the user never supplied a real one (`key` is set only by an
// authenticated key, never by the placeholder).
export function isPublicZen(provider: {
  id: string
  options: Record<string, unknown>
  key?: string
}): boolean {
  return provider.id === "opencode" && provider.options["apiKey"] === "public" && !provider.key
}
// altimate_change end
