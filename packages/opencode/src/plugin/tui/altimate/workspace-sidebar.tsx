// altimate_change - new file
// Right-pane sidebar tile that shows the workspace the current project
// directory is bound to (or "Not linked" with a hint). Reads from the local
// binding cache written by `../workspace.tsx` (post-scan dialog, on-demand
// picker, browser handoff).
//
// Deliberately read-only. All bind mutations live in workspace.tsx / link.ts;
// this tile just reflects state.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { onBindingChanged, resolveBindingOutcome, type CachedBinding } from "@/altimate/workspace/state"
// altimate_change start - status lines
import * as Manage from "@/altimate/workspace/manage"
// altimate_change end
import { buildManageUrl, resolveWorkspaceWebUrl } from "@/altimate/workspace/browser-handoff"
import { getResolvedWorkspaceId } from "@/altimate/workspace/session-context"
import { AltimateApi } from "@/altimate/api/client"
import { openManageUrl } from "./workspace"

const id = "altimate:sidebar-workspace"

/** Cache-file poll cadence. Longer than a "reactive" ideal but the cheapest
 * option that does not require plumbing an event bus through the binding
 * writers. Trade-off documented (m1 in the consensus review): a fresh bind
 * surfaces within one interval instead of instantly; a mostly-idle CLI reads
 * the small cache file twice per minute. In-flight guard below prevents
 * overlap when the file grows / the disk is slow. */
const POLL_MS = 30_000

/** Cached credential lookup — the API is a network round-trip candidate in
 * the general case, but the credentials source here (local file) rarely
 * changes within a single CLI process. We memoize the resolved manage-URL
 * base per (apiUrl, tenant) pair for the life of the process; if the file
 * changes mid-session, the binding cache invalidation (in state.ts) still
 * catches it via its own (tenant, apiUrl) top-level scoping. */
let cachedManageBase: { apiUrl: string; tenant: string; base: URL | null } | null = null
async function resolveManageBase(): Promise<URL | null> {
  try {
    const creds = await AltimateApi.getCredentials()
    if (
      cachedManageBase &&
      cachedManageBase.apiUrl === creds.altimateUrl &&
      cachedManageBase.tenant === creds.altimateInstanceName
    ) {
      return cachedManageBase.base
    }
    const base = resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName)
    cachedManageBase = { apiUrl: creds.altimateUrl, tenant: creds.altimateInstanceName, base }
    return base
  } catch {
    return null
  }
}

// altimate_change start - status lines
/** Coarse relative age. Deliberately not a timestamp: the point is "is this
 * stale?", and a clock time makes the reader do the subtraction. */
function describeAge(at: number): string {
  // Floored from the raw elapsed time, so every label owns a full window:
  // "1m ago" is 60–119s. Rounding — and rounding twice, seconds then minutes
  // — had squeezed it into ~30s (89.5s → 90s → "2m ago").
  const ms = Math.max(0, Date.now() - at)
  if (ms < 60_000) return "just now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(ms / 3_600_000)}h ago`
}
// altimate_change end

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  // Three states, not two. `undefined` is "the first read has not come back
  // yet"; `null` is "read, and this project is not linked". Starting at `null`
  // made the pane assert "Not linked — run altimate-code link" for the first
  // moments of every session, including projects that ARE linked — a false
  // statement plus an instruction to run a command the user does not need.
  const [binding, setBinding] = createSignal<CachedBinding | null | undefined>(undefined)
  const [manageUrl, setManageUrl] = createSignal<string | null>(null)
  // altimate_change start - status lines
  const [detail, setDetail] = createSignal<Manage.StatusReport | null>(null)
  // altimate_change end

  let refreshInFlight = false
  let refreshQueued = false
  let disposed = false
  /** `tenant|apiUrl` the current binding was resolved under. */
  let boundScope: string | null = null
  const currentScope = async (): Promise<string | null> => {
    try {
      const creds = await AltimateApi.getCredentials()
      return `${creds.altimateInstanceName}|${creds.altimateUrl}`
    } catch {
      return null
    }
  }
  const refresh = async () => {
    // Coalesce rather than drop. A binding-change notification can land while a
    // poll is mid-flight, and that pass may already have read the old binding —
    // returning early would leave the tile stale until the next tick, which is
    // exactly the lag the listener exists to remove. One queued re-run is
    // enough however many notifications arrive while we are busy.
    if (refreshInFlight) {
      refreshQueued = true
      return
    }
    refreshInFlight = true
    try {
      const dir = props.api.state.path.directory
      // Resolve, don't just read the cache. `readLocalBinding` never touches the
      // network, so on a cold cache it returns null and this tile asserted
      // "Not linked — run altimate-code link" about a project that IS linked,
      // until some unrelated code path happened to warm the cache. Same shape as
      // the counts bug directly above.
      //
      // `resolveBindingOutcome` is already safe to poll: a confirmed "unbound"
      // is memoized for MISS_TTL_MS and a known binding is trusted for
      // REVALIDATE_MS, so the worst case is one request per five minutes.
      // "unknown" (unreachable, 5xx) deliberately leaves the last answer
      // standing — a network blip must not downgrade a working tile to
      // "Not linked", which is the one state that tells the user to go and run
      // a command.
      const outcome = await resolveBindingOutcome(dir).catch(() => ({ status: "unknown" }) as const)
      if (outcome.status === "bound") {
        // Counts and the manage URL belong to a SPECIFIC workspace. On a rebind
        // they would otherwise keep describing the old one until the new status
        // resolved — the wrong numbers under the right name. Cleared only on a
        // real change; an "unknown" outcome deliberately leaves everything
        // standing rather than blanking a working tile over a blip. (cubic P2
        // on #1279.)
        // Compared with the account scope, not the id alone. Workspace ids are
        // tenant-local, so after an account switch a same-numbered workspace
        // in the new tenant would otherwise be treated as unchanged and keep
        // the old counts under the new name.
        const scope = await currentScope()
        if (binding()?.datamateId !== outcome.binding.datamateId || scope !== boundScope) {
          setDetail(null)
          setManageUrl(null)
        }
        boundScope = scope
        setBinding(outcome.binding)
      } else if (outcome.status === "unbound") {
        setDetail(null)
        setManageUrl(null)
        setBinding(null)
      }
      const b = binding()
      // No clear here: every path that reaches this with no binding has already
      // cleared the manage URL, or never set one.
      if (!b) return
      const base = await resolveManageBase()
      setManageUrl(base ? buildManageUrl(base, b.datamateId) : null)
      // altimate_change start - status lines
      // `poll: true` marks this as the POLLER path: `status` then resolves the
      // memory setting through a rate-limited resolver that asks at most once
      // every few minutes on a "no" and never once it is "yes", instead of once
      // per POLL_MS. It is a bound, not a ban — reading it as "never ask" is
      // what left these counts blank until something else happened to warm the
      // cache. The `/workspace` menu, by contrast, is cache-only, because it is
      // awaited before the dialog can open. See `Manage.status`.
      setDetail(await Manage.status(dir, { poll: true }).catch(() => null))
      // altimate_change end
    } finally {
      refreshInFlight = false
      // Not after disposal. A notification can land mid-refresh and unmount can
      // follow before it settles, and the queued run would then do network and
      // status work for a view nobody is looking at, writing to signals that no
      // longer render. (cubic P3 on #1279.)
      if (refreshQueued && !disposed) {
        refreshQueued = false
        void refresh()
      }
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(timer as any)?.unref?.()
    // Link and unlink happen in THIS process, so the tile can hear about them
    // directly instead of waiting out the poll. Without this, Unlink shows a
    // success toast while the pane beside it keeps naming the workspace for up
    // to POLL_MS — the UI contradicting itself, with the stale half looking
    // authoritative. The interval stays: it is what catches a change made by
    // another process, which no in-process listener can see.
    const unsubscribe = onBindingChanged(() => void refresh())
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
      unsubscribe()
    })
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Workspace</b>
      </text>
      <Show
        when={binding()}
        fallback={
          // Only once a read has actually returned `null`. While the answer is
          // still unknown the tile shows its heading and nothing under it,
          // which reads as "loading" rather than as a claim.
          <Show when={binding() === null}>
            <text fg={theme().textMuted}>
              Not linked — run <b>altimate-code link</b>
            </text>
          </Show>
        }
      >
        {(b) => (
          <>
            {/* Clicking the name (or the URL line below) opens the workspace
              * in the browser — the manage URL is deterministic from tenant
              * + id (see resolveManageBase above), so there's no extra
              * round-trip before it's clickable. The whole line is the click
              * target (mouse events only land on block-level `<text>`/`<box>`,
              * not inline `<span>`/`<a>` nodes), while only the name itself
              * is styled to look like a link — matching the footer's docs/
              * community links (sidebar/footer.tsx), which use the same
              * span-style + onMouseUp pair because raw `<a href>` hyperlink
              * nodes crash in this JSX layer. ``onMouseUp`` is omitted
              * entirely (not just a no-op) when there's no URL yet, so the
              * name never advertises a click target that does nothing. The
              * "pinned via --workspace" hint lives on its own line below
              * (rather than appended inline here) so the click region
              * doesn't extend over text that isn't part of the link — same
              * reasoning as the URL line already being separate. (multi-model
              * review, PR #1274.) */}
            <text fg={theme().textMuted} onMouseUp={manageUrl() ? () => openManageUrl(props.api, manageUrl()!) : undefined}>
              <Show when={manageUrl()} fallback={b().datamateName}>
                {(_u) => <span style={{ fg: theme().accent, underline: true }}>{b().datamateName}</span>}
              </Show>
            </text>
            {/* ``pinned via --workspace`` means "this SESSION was launched
              * with --workspace and it resolved to this id". It does NOT
              * mean "the current binding was set by --workspace" — if the
              * user relinks mid-session to a different workspace, the pin
              * disappears (id mismatch); if they relink to the same id,
              * the pin correctly stays because the launch fact is
              * unchanged. Known imprecision: relink-to-same-id looks
              * indistinguishable from "never relinked". Accepted per
              * altimate-harness-bot round 8 (option b of the review).
              * ``getResolvedWorkspaceId`` returns null when the launch
              * had no --workspace flag or the flag failed to resolve,
              * so the pin never falsely appears for a session that
              * wasn't launched with the flag. */}
            <Show when={getResolvedWorkspaceId() === b().datamateId}>
              <text fg={theme().textMuted}>(pinned via --workspace)</text>
            </Show>
            {/* altimate_change start - status lines: what has drifted, so the
              * reason to run `/workspace` is visible before you need it. */}
            <Show when={detail()?.memory}>
              {(m) => (
                <text fg={theme().textMuted}>
                  {m().local} {m().local === 1 ? "memory" : "memories"}
                  {m().unsynced !== null && m().unsynced! > 0 ? ` · ${m().unsynced} not synced` : ""}
                </text>
              )}
            </Show>
            <Show when={detail()?.skillsSyncedAt}>
              {(at) => <text fg={theme().textMuted}>{`skills synced ${describeAge(at())}`}</text>}
            </Show>
            {/* altimate_change end */}
            <Show when={manageUrl()}>
              {(u) => (
                <text fg={theme().textMuted} onMouseUp={() => openManageUrl(props.api, u())}>
                  <span style={{ fg: theme().accent, underline: true }}>{u()}</span>
                </text>
              )}
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // Below MCP (200) and above LSP (300) — workspace identity is high-signal
    // when present, but not more useful than the connection status above.
    order: 250,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
