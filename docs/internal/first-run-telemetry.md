# First-run health telemetry

CLI telemetry lands in Azure Application Insights (`altimate-code-os`). Event names are the
`Telemetry.Event` `type`; string properties are in `customDimensions`, numbers in
`customMeasurements`, and `session_id` is lifted into the `session_Id` column.

## Why these events exist

On 2026-09-09 a fresh 0.11.0 install froze for 2.5 to 5 minutes on first use (an in-process
`@npmcli/arborist` install blocked Bun's event loop). Nothing in telemetry showed it:

- no event timed startup or registration, so a silent freeze produced no number anywhere;
- events flush on a 5 s interval on the same loop, so a frozen-then-killed process died with
  its buffer and left only `session_start` + `task_classified` (a "dead session");
- the only place it was visible was first-generation latency split by brand-new versus
  returning machines, which no default view does.

Three events and one behaviour change close the gap:

| Event | Emitted | Key fields |
|---|---|---|
| `startup_ready` | once per process when `tui`, `serve` or `run` can do work | `command`, `duration_ms` (process uptime), `fresh_install` |
| `event_loop_stall` | when a 250 ms monitor tick fires more than 1 s late, capped at 20 per process | `blocked_ms`, `since_start_ms`, `thread`, `command` |
| `altimate_base_registration` | on every `registerAfterConsent` outcome (TUI and HTTP consent paths) | `result`, `duration_ms`, `status` |

Anchor events (`first_launch`, `startup_ready`, `event_loop_stall`, `altimate_base_registration`,
`session_start`) flush immediately instead of waiting for the interval.

## Queries (KQL)

Startup time by command, fresh versus returning machines:

```kusto
customEvents
| where timestamp > ago(7d) and name == "startup_ready"
| extend v=tostring(customDimensions.cli_version), cmd=tostring(customDimensions.command), fresh=tostring(customDimensions.fresh_install)
| summarize n=count(), p50_s=percentile(todouble(customMeasurements.duration_ms)/1000,50), p90_s=percentile(todouble(customMeasurements.duration_ms)/1000,90) by v, cmd, fresh
| order by v desc
```

Event-loop stalls (the freeze, measured directly):

```kusto
customEvents
| where timestamp > ago(7d) and name == "event_loop_stall"
| extend v=tostring(customDimensions.cli_version), cmd=tostring(customDimensions.command), thread=tostring(customDimensions.thread)
| summarize stalls=count(), machines=dcount(user_Id), p50_blocked_s=percentile(todouble(customMeasurements.blocked_ms)/1000,50), max_blocked_s=max(todouble(customMeasurements.blocked_ms))/1000 by v, cmd, thread
| order by machines desc
```

Registration outcome and latency:

```kusto
customEvents
| where timestamp > ago(7d) and name == "altimate_base_registration"
| extend v=tostring(customDimensions.cli_version), result=tostring(customDimensions.result)
| summarize n=count(), p50_s=percentile(todouble(customMeasurements.duration_ms)/1000,50), p90_s=percentile(todouble(customMeasurements.duration_ms)/1000,90) by v, result
```

Dead-session rate, fresh versus returning (works on historical data too):

```kusto
let fresh = customEvents
| where timestamp > ago(30d) and name == "first_launch" and tostring(customDimensions.is_upgrade) == "false"
| summarize launch=min(timestamp) by user_Id;
customEvents
| where timestamp > ago(30d) and isnotempty(session_Id)
| extend v=tostring(customDimensions.cli_version)
| summarize started=countif(name=="session_start"), gens=countif(name=="generation"), errors=countif(name in ("error","provider_error")), start=minif(timestamp, name=="session_start"), last_ts=max(timestamp), ver=any(v) by session_Id, user_Id
| where started > 0
| join kind=leftouter fresh on user_Id
| extend fresh_machine = isnotnull(launch) and start between (launch .. (launch + 24h))
| extend dead = gens == 0 and errors == 0 and datetime_diff("second", last_ts, start) <= 2
| summarize sessions=count(), dead_pct=round(100.0*countif(dead)/count(),1), generated_pct=round(100.0*countif(gens > 0)/count(),1) by ver, fresh_machine
| order by ver desc, fresh_machine desc
```

Gotchas: the `az monitor app-insights query --analytics-query` argument must be a single line;
`last` is a reserved word; `percentileif` does not exist (filter first, then `percentile`).
