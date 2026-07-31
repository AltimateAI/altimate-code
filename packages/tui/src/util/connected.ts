// altimate_change — shared "is any provider connected?" predicate.
//
// Two call sites need this: `component/use-connected.tsx` (welcome / picker
// gating) and `feature-plugins/home/tips.tsx` (first-run tip visibility).
// They previously each carried their own copy of the same logic; that meant
// a future refactor in one could silently diverge from the other, and the
// rationale below only lived in one.
//
// The predicate: a user is "connected" if ANY registered provider is
// connectable. For providers whose id is not `"opencode"` we treat
// "registered" AS connected — custom `altimate-code.json` entries, BYOK
// entries with no per-token cost metadata, and self-hosted deployments
// legitimately omit the `cost` field, and we should not force them
// through the welcome picker on upgrade. For the built-in `"opencode"`
// provider specifically, `cost.input === 0` is a deliberate marker of
// its free tier (no gateway key), which does NOT count as connected —
// a nonzero (real) cost is what signals a paid gateway key.
export type ConnectedProviderShape = {
  id: string
  models: Record<string, { cost?: { input?: number | null } | null }>
}

export function isAnyProviderConnected(providers: readonly ConnectedProviderShape[]): boolean {
  return providers.some((provider) => {
    if (provider.id !== "opencode") return true
    return Object.values(provider.models).some(
      (model) => model.cost?.input != null && model.cost.input !== 0,
    )
  })
}
