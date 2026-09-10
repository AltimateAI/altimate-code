# Telemetry queries — 2026-09-02 analysis

Workspace `b511e30e-4b93-4093-98a5-b80fc4718111` (`altimate-code-os`), table `AppEvents`. Every query below was run with timespan P45D on 2026-09-02/03 via the Log Analytics REST data plane. Each shares the same prelude (window lets, strict-semver `rel` flag, `mid`/`src` extends). Batch prefixes: b = first sweep, c = property fixes + anomalies, d = fleet/CI/funnel, e = native_call/upgrade/provider, f = rate limit/CI review, g = reconciliation after review.

## b00_samples

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | summarize n=count(), p=any(tostring(Properties)) by Name | order by n desc | take 60
```

## b01_scale

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
All | extend test = tostring(Properties.provider_id)=="test" or tostring(Properties.cli_version)=="local" | summarize events=count(), machines=dcount(mid), sessions=dcount(SessionId) by win, rel, test | order by win, events desc
```

## b02_versions

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | summarize machines=dcount(mid), sessions=dcount(SessionId), events=count(), first=min(TimeGenerated) by AppVersion | order by machines desc
```

## b03_source

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | summarize machines=dcount(mid), sessions=dcount(SessionId), events=count() by win, src | order by src, win
```

## b04_os

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="session_start" | summarize machines=dcount(mid), sessions=dcount(SessionId) by win, os=tostring(Properties.os), src | order by src, os, win
```

## b05_daily

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
AppEvents | where TimeGenerated > ago(45d) | where AppVersion matches regex @"^[0-9]+\.[0-9]+\.[0-9]+$" | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source) | summarize machines=dcount(mid), sessions=dcount(SessionId) by day=bin(TimeGenerated,1d), src | order by day asc, src
```

## b06_events

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | summarize events=count(), machines=dcount(mid) by Name, win | order by Name, win
```

## b07_outcome

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="agent_outcome" | summarize n=count(), machines=dcount(mid) by win, agent=tostring(Properties.agent), outcome=tostring(Properties.outcome) | order by agent, win, outcome
```

## b08_outcome_src

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="agent_outcome" | summarize n=count(), machines=dcount(mid) by src, outcome=tostring(Properties.outcome) | order by src, outcome
```

## b09_err_reasons

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="agent_outcome" and tostring(Properties.outcome)=="error" | summarize n=count(), machines=dcount(mid) by reason=substring(tostring(Properties.error_message),0,140), src | order by machines desc | take 40
```

## b10_core_failure

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="core_failure" | summarize n=count(), machines=dcount(mid) by win, tool=tostring(Properties.tool), class=tostring(Properties.error_class) | order by machines desc | take 60
```

## b11_core_failure_msgs

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="core_failure" | summarize n=count(), machines=dcount(mid) by tool=tostring(Properties.tool), msg=substring(tostring(Properties.error_message),0,150) | order by machines desc | take 50
```

## b12_task

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="tool_call" and tostring(Properties.tool_name)=="task" | summarize n=count(), machines=dcount(mid) by success=tostring(Properties.success), err=substring(tostring(Properties.error_message),0,120) | order by n desc | take 20
```

## b13_warehouse

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name in ("warehouse_query","schema_inspect","sql_execute_failure") | summarize n=count(), errs=countif(tostring(Properties.success)=="false" or Name=="sql_execute_failure"), machines=dcount(mid) by Name, wh=tostring(Properties.warehouse_type) | order by n desc
```

## b13b_npm

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where tostring(Properties) has "npm install" | summarize n=count(), machines=dcount(mid) by Name, msg=extract(@"(npm install [^\s\\\"]+(?: [^\s\\\"]+)?)", 1, tostring(Properties)) | order by machines desc | take 20
```

## b14_upgrade

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="upgrade_attempted" | summarize n=count(), machines=dcount(mid) by win, status=tostring(Properties.status), method=tostring(Properties.method), err=substring(tostring(Properties.error_message),0,100) | order by win, n desc
```

## b15_permission

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="permission_denied" | summarize n=count(), machines=dcount(mid) by win, tool=tostring(Properties.tool) | order by machines desc | take 20
```

## b16_skills

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name has "skill" | summarize n=count(), machines=dcount(mid) by win, Name, skill=tostring(Properties.skill_name) | order by machines desc | take 40
```

## b17_onboarding

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name startswith "onboarding" or Name in ("model_picker_shown","provider_selected","scan_gate_shown","first_launch") | summarize n=count(), machines=dcount(mid) by win, Name | order by Name, win
```

## b18_review

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name startswith "review" | summarize n=count(), machines=dcount(mid), p=any(tostring(Properties)) by win, Name | order by Name, win
```

## b19_filetime

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="filetime_drift" | summarize n=count(), machines=dcount(mid) by win, ahead=tostring(Properties.mtime_ahead)
```

## b20_overflow

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where tostring(Properties) has "BufferOverflow" | summarize n=count(), machines=dcount(mid) by Name
```

## b21_mcp

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="mcp_server_status" | summarize n=count(), machines=dcount(mid) by server=tostring(Properties.server_name), status=tostring(Properties.status) | order by machines desc | take 25
```

## b22_ratelimit

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where tostring(Properties) has "Rate limit" | summarize n=count(), machines=dcount(mid) by day=bin(TimeGenerated,1d), src | order by day asc
```

## b23_tokens

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="generation" or Name=="llm_generation" or Name has "generation" | summarize n=count(), machines=dcount(mid), tin=sum(todouble(Measurements.tokens_input)), tout=sum(todouble(Measurements.tokens_output)), cost=sum(todouble(Measurements.cost)) by Name, provider=tostring(Properties.provider_id), model=tostring(Properties.model_id) | order by n desc | take 40
```

## b24_toolcalls

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="tool_call" | summarize n=count(), errs=countif(tostring(Properties.success)=="false"), machines=dcount(mid) by tool=tostring(Properties.tool_name) | order by n desc | take 50
```

## b25_retention

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where src=="cli" | summarize first=min(TimeGenerated), last=max(TimeGenerated), days=dcount(bin(TimeGenerated,1d)) by mid | summarize machines=count(), new_in_cur=countif(first>=W0), active_cur=countif(last>=W0), retained_prev_to_cur=countif(first<W0 and last>=W0), multi_day=countif(days>=2), d5plus=countif(days>=5)
```

## b26_datamates_churn

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where src=="datamates" | summarize days=dcount(bin(TimeGenerated,1d)) by mid | summarize machines=count(), one_day=countif(days==1), two_plus=countif(days>=2), five_plus=countif(days>=5)
```

## b27_top_machines

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | summarize n=count() by mid, src | top 10 by n | extend share=round(100.0*n/toscalar(Cur|count),1)
```

## c01_devbuilds

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
All | where not(rel) and win=="cur" | summarize machines=dcount(mid), sessions=dcount(SessionId), events=count(), providers=make_set(tostring(Properties.provider_id),5), oss=make_set(tostring(Properties.os),4) by ver=extract(@"^(0\.0\.0-[a-z]+)", 1, AppVersion), src | order by events desc | take 25
```

## c01b_devbuilds_ver

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
All | where not(rel) and win=="cur" | summarize machines=dcount(mid), sessions=dcount(SessionId), events=count() by AppVersion | order by machines desc | take 15
```

## c02_versions

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | summarize machines=dcount(mid), sessions=dcount(SessionId), events=count(), firstSeen=min(TimeGenerated) by AppVersion | order by machines desc
```

## c03_emptysrc

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where src=="" | summarize machines=dcount(mid), sessions=dcount(SessionId), events=count() by win, AppVersion, os=tostring(Properties.os) | order by machines desc | take 20
```

## c04_sources45

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
AppEvents | where TimeGenerated > ago(45d) | where AppVersion matches regex @"^[0-9]+\.[0-9]+\.[0-9]+$" | summarize machines=dcount(tostring(Properties.machine_id)), events=count(), lastSeen=max(TimeGenerated) by src=tostring(Properties.source)
```

## c05_err_reasons

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="agent_outcome" and tostring(Properties.outcome)=="error" | summarize n=count(), machines=dcount(mid) by src, cls=tostring(Properties.error_class), reason=substring(tostring(Properties.reason),0,140) | order by machines desc | take 40
```

## c06_datamates_outcome

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="agent_outcome" and src=="datamates" | summarize n=count(), machines=dcount(mid) by AppVersion, outcome=tostring(Properties.outcome) | order by AppVersion, outcome
```

## c07_core_failure

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="core_failure" | summarize n=count(), machines=dcount(mid) by win, tool=tostring(Properties.tool_name), class=tostring(Properties.error_class) | order by machines desc | take 60
```

## c08_task

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="tool_call" and tostring(Properties.tool_name)=="task" | summarize n=count(), machines=dcount(mid) by win, status=tostring(Properties.status), err=substring(tostring(Properties.error_message),0,120) | order by win, n desc | take 20
```

## c09_toolcalls

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="tool_call" | summarize n=count(), errs=countif(tostring(Properties.status)!="success"), machines=dcount(mid), err_machines=dcountif(mid, tostring(Properties.status)!="success") by tool=tostring(Properties.tool_name) | order by n desc | take 60
```

## c10_permission

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="permission_denied" | summarize n=count(), machines=dcount(mid) by win, tool=tostring(Properties.tool_name), src | order by machines desc | take 25
```

## c11_upgrade

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="upgrade_attempted" | summarize n=count(), machines=dcount(mid) by win, status=tostring(Properties.status), method=tostring(Properties.method), err=substring(tostring(Properties.error),0,100), fromv=tostring(Properties.from_version), tov=tostring(Properties.to_version) | order by win, machines desc | take 40
```

## c12_error_event

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="error" | summarize n=count(), machines=dcount(mid) by win, src, ename=tostring(Properties.error_name), ctx=tostring(Properties.context), msg=substring(tostring(Properties.error_message),0,100) | order by machines desc | take 40
```

## c13_grep

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="core_failure" and tostring(Properties.tool_name) in ("grep","glob") | summarize n=count(), machines=dcount(mid) by win, msg=substring(tostring(Properties.error_message),0,110) | order by machines desc | take 20
```

## c14_pii_paths

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="core_failure" | extend m=tostring(Properties.error_message) | summarize n=count(), machines=dcount(mid), leaked=countif(m matches regex @"(/Users/|/home/|C:\\Users\\|D:\\)"), leaked_machines=dcountif(mid, m matches regex @"(/Users/|/home/|C:\\Users\\|D:\\)"), masked=countif(m has "?") by win, AppVersion | order by AppVersion
```

## c15_funnel

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let FL = Cur | where Name=="first_launch" and src=="cli" and AppVersion in ("0.9.5","0.9.6","0.9.7","0.10.0") | distinct mid; Cur | where mid in (FL) | summarize fl=dcountif(mid,Name=="first_launch"), onb_start=dcountif(mid,Name=="onboarding_started"), picker=dcountif(mid,Name=="model_picker_shown"), provider=dcountif(mid,Name=="provider_selected"), scan=dcountif(mid,Name=="scan_gate_shown"), onb_done=dcountif(mid,Name=="onboarding_completed"), abandoned=dcountif(mid,Name=="onboarding_abandoned"), first_prompt=dcountif(mid,Name=="first_prompt_sent"), sess=dcountif(mid,Name=="session_start"), gen=dcountif(mid,Name=="generation"), outcome=dcountif(mid,Name=="agent_outcome"), completed=dcountif(mid,Name=="agent_outcome" and tostring(Properties.outcome)=="completed"), returned=dcountif(mid, Name=="session_start" and TimeGenerated > W1 - 1d)
```

## c15b_funnel_ver

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="first_launch" | summarize machines=dcount(mid) by win, AppVersion, src, upg=tostring(Properties.is_upgrade) | order by machines desc | take 30
```

## c16_retention

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where src=="cli" | summarize firstT=min(TimeGenerated), lastT=max(TimeGenerated), days=dcount(bin(TimeGenerated,1d)) by mid | summarize machines=count(), new_in_cur=countif(firstT>=W0), active_cur=countif(lastT>=W0), retained_prev_to_cur=countif(firstT<W0 and lastT>=W0), churned=countif(firstT<W0 and lastT<W0), multi_day=countif(days>=2), d5plus=countif(days>=5)
```

## c16b_retention_all

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | summarize firstT=min(TimeGenerated), lastT=max(TimeGenerated), days=dcount(bin(TimeGenerated,1d)) by mid, src | summarize machines=count(), new_in_cur=countif(firstT>=W0), retained_prev_to_cur=countif(firstT<W0 and lastT>=W0), churned=countif(firstT<W0 and lastT<W0), multi_day=countif(days>=2), d5plus=countif(days>=5) by src
```

## c17_weekly

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
AppEvents | where TimeGenerated > ago(63d) | where AppVersion matches regex @"^[0-9]+\.[0-9]+\.[0-9]+$" | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), pid=tostring(Properties.provider_id) | where not(pid startswith "shs-dx-it") | summarize machines=dcount(mid), sessions=dcount(SessionId), gen_machines=dcountif(mid, Name=="generation") by wk=startofweek(TimeGenerated), src | order by wk asc, src
```

## c18_finish

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="generation" | summarize n=count(), machines=dcount(mid) by win, fr=tostring(Properties.finish_reason) | order by win, n desc
```

## c19_measurements

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name in ("session_end","generation","agent_outcome","tool_call","compaction_triggered") | summarize any(tostring(Measurements)) by Name
```

## c20_intent

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="task_classified" | summarize n=count(), machines=dcount(mid) by win, intent=tostring(Properties.intent) | order by intent, win
```

## c21_wh_connect

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="warehouse_connect" | summarize n=count(), machines=dcount(mid) by win, wh=tostring(Properties.warehouse_type), ok=tostring(Properties.success), cat=tostring(Properties.error_category), err=substring(tostring(Properties.error),0,90) | order by machines desc | take 30
```

## c23_drivers

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | extend m=tostring(Properties) | where m has "driver not installed" or m has "npm install" | summarize n=count(), machines=dcount(mid) by Name, drv=extract(@"npm install ([@a-z/\-\.]+)", 1, m) | order by machines desc
```

## c24_compaction

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="compaction_triggered" | summarize n=count(), machines=dcount(mid), sessions=dcount(SessionId) by win, trig=tostring(Properties.trigger) | order by win
```

## c25_doom

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="doom_loop_detected" | summarize n=count(), machines=dcount(mid) by win, tool=tostring(Properties.tool_name)
```

## c26_top_machines

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let T = Cur | summarize n=count() by mid | top 12 by n; Cur | where mid in (T) | summarize n=count(), sessions=dcount(SessionId), ver=any(AppVersion), src=any(src), prov=make_set(tostring(Properties.provider_id),3), model=make_set(tostring(Properties.model_id),3), os=any(tostring(Properties.os)), wh=make_set(tostring(Properties.warehouse_type),3), agents=make_set(tostring(Properties.agent),4), skills=make_set(tostring(Properties.skill_name),4) by mid | order by n desc
```

## c27_invalid

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="tool_call" and tostring(Properties.tool_name)=="invalid" | summarize n=count(), machines=dcount(mid) by p=substring(tostring(Properties),0,300) | order by n desc | take 8
```

## c28_review

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="review_run" | summarize n=count(), machines=dcount(mid) by win, status=tostring(Properties.status), verdict=tostring(Properties.verdict), ideal=tostring(Properties.ideal_verdict), tier=tostring(Properties.tier), degraded=tostring(Properties.degraded), inv=tostring(Properties.invocation) | order by win, n desc
```

## c29_session_len

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="session_end" | extend d=todouble(Measurements.duration_ms), t=todouble(Measurements.turn_count), tc=todouble(Measurements.tool_calls) | summarize n=count(), p50_dur_min=percentile(d,50)/60000, p90_dur_min=percentile(d,90)/60000, p50_turns=percentile(t,50), p90_turns=percentile(t,90), p50_tools=percentile(tc,50) by src
```

## c30_ratelimit_effect

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let RL = Cur | where tostring(Properties) has "Rate limit exceeded" | distinct mid; Cur | where src=="datamates" | summarize days=dcount(bin(TimeGenerated,1d)), gens=countif(Name=="generation"), completed=countif(Name=="agent_outcome" and tostring(Properties.outcome)=="completed") by mid, rl=mid in (RL) | summarize machines=count(), multi_day=countif(days>=2), avg_gens=avg(gens), any_completed=countif(completed>0) by rl
```

## c31_bigpickle_err

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where tostring(Properties.provider_id)=="opencode" | where Name in ("agent_outcome","error") | summarize n=count(), machines=dcount(mid) by Name, o=tostring(Properties.outcome), ename=tostring(Properties.error_name), msg=substring(tostring(Properties.error_message),0,90) | order by machines desc | take 15
```

## c32_provider_machines

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="session_start" | summarize machines=dcount(mid), sessions=dcount(SessionId) by win, prov=tostring(Properties.provider_id) | order by machines desc | take 40
```

## d01_acp

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
AppEvents | where TimeGenerated > ago(75d) | where AppVersion matches regex @"^[0-9]+\.[0-9]+\.[0-9]+$" | where tostring(Properties.source)=="acp" | summarize machines=dcount(tostring(Properties.machine_id)), sessions=dcount(SessionId), events=count() by wk=startofweek(TimeGenerated), AppVersion | order by wk asc
```

## d01b_acp_any

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
AppEvents | where TimeGenerated > ago(45d) | extend p=tostring(Properties) | where p has "acp" | summarize n=count(), machines=dcount(tostring(Properties.machine_id)) by AppVersion, src=tostring(Properties.source), Name | order by n desc | take 15
```

## d02_v073

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where AppVersion=="0.7.3" | summarize machines=dcount(mid), sessions=dcount(SessionId), events=count(), projects=dcount(tostring(Properties.project_id)), prov=make_set(tostring(Properties.provider_id),4), wh=make_set(tostring(Properties.warehouse_type),4) by day=bin(TimeGenerated,1d) | order by day asc
```

## d02b_v073_names

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where AppVersion=="0.7.3" | summarize n=count(), machines=dcount(mid) by Name, os=tostring(Properties.os) | order by n desc | take 20
```

## d02c_v073_project

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where AppVersion=="0.7.3" | summarize n=count(), machines=dcount(mid), sessions=dcount(SessionId) by pid=tostring(Properties.project_id) | order by machines desc | take 8
```

## d03_v093

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where AppVersion=="0.9.3" | summarize n=count(), machines=dcount(mid) by Name, src, upg=tostring(Properties.is_upgrade) | order by machines desc | take 20
```

## d03b_v093_daily

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where AppVersion=="0.9.3" and Name=="first_launch" | summarize machines=dcount(mid) by day=bin(TimeGenerated,1d), os=tostring(Properties.os) | order by day asc
```

## d04_temp_top_p

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | extend p=tostring(Properties) | where p has "cannot both be specified" | summarize n=count(), machines=dcount(mid) by win, Name, AppVersion, src | order by machines desc
```

## d04b_temp_top_p_prov

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let S = Rel | extend p=tostring(Properties) | where p has "cannot both be specified" | distinct SessionId; Rel | where SessionId in (S) and Name=="session_start" | summarize machines=dcount(mid) by prov=tostring(Properties.provider_id), model=tostring(Properties.model_id), AppVersion | order by machines desc
```

## d05_fl_nosession

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let FL = Cur | where Name=="first_launch" and src=="cli" and AppVersion in ("0.9.5","0.9.6","0.9.7") | distinct mid; let S = Cur | where Name=="session_start" | distinct mid; Cur | where mid in (FL) and not(mid in (S)) | summarize n=count(), machines=dcount(mid) by Name | order by machines desc
```

## d05b_fl_nosession_os

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let FL = Cur | where Name=="first_launch" and src=="cli" and AppVersion in ("0.9.5","0.9.6","0.9.7") | distinct mid; let S = Cur | where Name=="session_start" | distinct mid; Cur | where mid in (FL) and Name=="first_launch" | summarize machines=dcount(mid), no_session=dcountif(mid, not(mid in (S))) by os=tostring(Properties.os), upg=tostring(Properties.is_upgrade)
```

## d05c_fl_props

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="first_launch" | take 3 | project Properties, Measurements
```

## d06_datamates_daily

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where src=="datamates" | summarize machines=dcount(mid), gen=dcountif(mid,Name=="generation"), completed=dcountif(mid,Name=="agent_outcome" and tostring(Properties.outcome)=="completed"), errored=dcountif(mid,Name=="agent_outcome" and tostring(Properties.outcome)=="error"), rl=dcountif(mid, tostring(Properties) has "Rate limit exceeded"), notauth=dcountif(mid, tostring(Properties) has "Not authenticated") by day=bin(TimeGenerated,1d) | order by day asc
```

## d07_notauth

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let S = Cur | extend p=tostring(Properties) | where p has "Not authenticated" | distinct SessionId; Cur | where SessionId in (S) and Name=="session_start" | summarize machines=dcount(mid), sessions=dcount(SessionId) by prov=tostring(Properties.provider_id), model=tostring(Properties.model_id), AppVersion, src | order by machines desc | take 10
```

## d08_schema_inspect

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="core_failure" and tostring(Properties.tool_name)=="schema_inspect" | summarize n=count(), machines=dcount(mid) by cls=tostring(Properties.error_class), msg=substring(tostring(Properties.error_message),0,120) | order by machines desc | take 12
```

## d09_webfetch

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="core_failure" and tostring(Properties.tool_name)=="webfetch" | summarize n=count(), machines=dcount(mid) by msg=substring(tostring(Properties.error_message),0,120) | order by machines desc | take 10
```

## d10_memory_emitters

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name in ("memory_operation","memory_injection","native_call","filetime_drift","sql_pre_validation") | summarize n=count() by Name, mid | summarize machines=count(), total=sum(n), top1=max(n), top3=sum(iff(n>5000,n,0)), machines_over_5k=countif(n>5000) by Name
```

## d10b_memory_ops

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="memory_operation" | summarize n=count(), machines=dcount(mid), sessions=dcount(SessionId) by op=tostring(Properties.operation), scope=tostring(Properties.scope), upd=tostring(Properties.is_update) | order by n desc
```

## d11_genlocal

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where tostring(Properties.provider_id)=="genlocal" or tostring(Properties.model_id)=="altimate-base" | summarize n=count(), machines=dcount(mid) by Name, AppVersion, src, o=tostring(Properties.outcome) | order by machines desc | take 15
```

## d12_bigpickle

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let BP = Cur | where Name=="session_start" and tostring(Properties.provider_id)=="opencode" | distinct mid; let RL = Cur | extend p=tostring(Properties) | where p has "Rate limit exceeded" | distinct mid; Cur | where mid in (BP) | summarize machines=dcount(mid), rl=dcountif(mid, mid in (RL)), gen=dcountif(mid,Name=="generation"), completed=dcountif(mid, Name=="agent_outcome" and tostring(Properties.outcome)=="completed"), errored=dcountif(mid, Name=="agent_outcome" and tostring(Properties.outcome)=="error") by src
```

## d12b_bigpickle_by_model

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="session_start" and tostring(Properties.provider_id)=="opencode" | summarize machines=dcount(mid), sessions=dcount(SessionId) by model=tostring(Properties.model_id), src | order by machines desc
```

## d13_sessions_zero_gen

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let G = Cur | where Name=="generation" | distinct SessionId; Cur | where Name=="session_start" | summarize sessions=dcount(SessionId), no_gen=dcountif(SessionId, not(SessionId in (G))), machines=dcount(mid), machines_no_gen_only=dcount(mid) - dcountif(mid, SessionId in (G)) by src
```

## d14_pii_sample

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="core_failure" and AppVersion=="0.9.7" | extend m=tostring(Properties.error_message) | where m matches regex @"(/Users/|/home/|C:\\Users\\)" | summarize n=count(), machines=dcount(mid), sample=any(substring(m,0,160)), args=any(substring(tostring(Properties.masked_args),0,160)) by tool=tostring(Properties.tool_name), cls=tostring(Properties.error_class) | order by machines desc
```

## d15_outcome_dur

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="agent_outcome" and tostring(Properties.outcome)=="completed" | extend d=todouble(Measurements.duration_ms)/60000, tc=todouble(Measurements.tool_calls), g=todouble(Measurements.generations) | summarize n=count(), p50_min=round(percentile(d,50),1), p90_min=round(percentile(d,90),1), p50_tools=percentile(tc,50), p90_tools=percentile(tc,90), p50_gens=percentile(g,50) by src
```

## d18_event_diff

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | summarize cur=countif(win=="cur"), prev=countif(win=="prev"), cur_m=dcountif(mid,win=="cur"), prev_m=dcountif(mid,win=="prev") by Name | where cur==0 or prev==0 | order by cur desc, prev desc
```

## d19_review_cats

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="review_run" | extend bc=parse_json(tostring(Properties.by_category)) | summarize runs=count(), machines=dcount(mid), lineage=sum(toint(bc.lineage_breakage)), semantic=sum(toint(bc.semantic_change)), pii=sum(toint(bc.pii_exposure)), cost=sum(toint(bc.warehouse_cost)), sqlq=sum(toint(bc.sql_quality)), sqlc=sum(toint(bc.sql_correctness)), join_risk=sum(toint(bc.join_risk)), fanout=sum(toint(bc.fanout)), contract=sum(toint(bc.contract_violation)), degraded=countif(tostring(Properties.degraded)=="true")
```

## d22_env

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="environment_census" | summarize machines=dcount(mid) by dbt=tostring(Properties.dbt_detected), wh=tostring(Properties.warehouse_types), src | order by machines desc | take 15
```

## d22b_wh_census

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="warehouse_census" | summarize machines=dcount(mid) by wh=tostring(Properties.warehouse_types) | order by machines desc | take 12
```

## d24_cli_core

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let C = Cur | where src=="cli" | summarize days=dcount(bin(TimeGenerated,1d)), gens=countif(Name=="generation") by mid | where days>=3 and gens>0; Cur | where mid in (C) and Name=="session_start" | summarize machines=dcount(mid), sessions=dcount(SessionId) by prov=tostring(Properties.provider_id), AppVersion, os=tostring(Properties.os) | order by machines desc | take 25
```

## d24b_cli_core_count

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where src=="cli" | summarize days=dcount(bin(TimeGenerated,1d)), gens=countif(Name=="generation"), completed=countif(Name=="agent_outcome" and tostring(Properties.outcome)=="completed") by mid | summarize total=count(), gen_any=countif(gens>0), d2=countif(days>=2 and gens>0), d3=countif(days>=3 and gens>0), d5=countif(days>=5 and gens>0), d10=countif(days>=10 and gens>0), completed_any=countif(completed>0)
```

## d24c_dm_core_count

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where src=="datamates" | summarize days=dcount(bin(TimeGenerated,1d)), gens=countif(Name=="generation"), completed=countif(Name=="agent_outcome" and tostring(Properties.outcome)=="completed") by mid | summarize total=count(), gen_any=countif(gens>0), d2=countif(days>=2 and gens>0), d3=countif(days>=3 and gens>0), d5=countif(days>=5 and gens>0), completed_any=countif(completed>0)
```

## d25_sql_exec_fail

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="sql_execute_failure" | summarize n=count(), machines=dcount(mid) by wh=tostring(Properties.warehouse_type), msg=substring(tostring(Properties.error_message),0,100) | order by machines desc | take 20
```

## d26_duckdb_timeout

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | extend p=tostring(Properties) | where p has "Timed out opening DuckDB" | summarize n=count(), machines=dcount(mid) by AppVersion, src, os=tostring(Properties.os), Name | order by n desc
```

## d27_abandon_reason

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="agent_outcome" and tostring(Properties.outcome) in ("abandoned","aborted") | summarize n=count(), machines=dcount(mid) by src, o=tostring(Properties.outcome), reason=substring(tostring(Properties.reason),0,80), ft=tostring(Properties.final_tool) | order by machines desc | take 20
```

## d28_task_signal

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="task_outcome_signal" | summarize n=count(), machines=dcount(mid) by win, sig=tostring(Properties.signal) | order by win, n desc
```

## d29_first_prompt

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name in ("first_prompt_sent","activation_menu_shown","activation_job_selected","environment_scan_completed","big_pickle_choice","gateway_device_code_issued","gateway_auth_failed") | summarize n=count(), machines=dcount(mid), p=any(substring(tostring(Properties),0,200)) by win, Name | order by Name, win
```

## e01_native_093

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where AppVersion=="0.9.3" and Name=="native_call" | summarize n=count(), machines=dcount(mid) by method=tostring(Properties.method), status=tostring(Properties.status), src | order by n desc | take 15
```

## e02_native_nosession

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let S = Cur | where Name=="session_start" | distinct mid; Cur | where Name=="native_call" and not(mid in (S)) | summarize n=count(), machines=dcount(mid) by AppVersion, method=tostring(Properties.method), src | order by machines desc | take 20
```

## e03_native_methods

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="native_call" | summarize n=count(), machines=dcount(mid), errs=countif(tostring(Properties.status)!="success") by method=tostring(Properties.method) | order by machines desc | take 25
```

## e04_fleet_project_history

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
AppEvents | where TimeGenerated > ago(90d) | where tostring(Properties.project_id)=="faf13d3e2eb7aa9ddd80dc82357926b0126f1f8f" | summarize machines=dcount(tostring(Properties.machine_id)), events=count(), vers=make_set(AppVersion,5), node=make_set(tostring(Properties.node_version),3), arch=make_set(tostring(Properties.arch),3) by wk=startofweek(TimeGenerated) | order by wk asc
```

## e05_v093_machines_history

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let M = AppEvents | where TimeGenerated between (datetime(2026-08-27) .. datetime(2026-09-02)) and AppVersion=="0.9.3" and Name=="first_launch" | distinct mid=tostring(Properties.machine_id); AppEvents | where TimeGenerated > ago(30d) | where tostring(Properties.machine_id) in (M) | summarize n=count(), machines=dcount(tostring(Properties.machine_id)) by Name, AppVersion, pid=tostring(Properties.project_id), os=tostring(Properties.os) | order by n desc | take 15
```

## e06_upgrade_by_src

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="upgrade_attempted" | summarize n=count(), machines=dcount(mid) by src, status=tostring(Properties.status), method=tostring(Properties.method) | order by src, status
```

## e07_upgrade_success_followup

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let U = Cur | where Name=="upgrade_attempted" and tostring(Properties.status)=="error" | distinct mid; Cur | where mid in (U) | summarize maxv=max(AppVersion), minv=min(AppVersion), later_ok=countif(Name=="upgrade_attempted" and tostring(Properties.status)=="success") by mid | summarize machines=count(), eventually_upgraded=countif(later_ok>0 or maxv=="0.9.7")
```

## e08_ripgrep

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Rel | where Name=="core_failure" and tostring(Properties.error_message) has "Ripgrep" | summarize n=count(), machines=dcount(mid) by win, msg=substring(tostring(Properties.error_message),0,60), AppVersion | order by machines desc
```

## e09_dm_version_daily

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where src=="datamates" and Name=="session_start" | summarize machines=dcount(mid) by day=bin(TimeGenerated,1d), AppVersion | order by day asc, AppVersion
```

## e10_cli_new_by_week

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
AppEvents | where TimeGenerated > ago(63d) | where AppVersion matches regex @"^[0-9]+\.[0-9]+\.[0-9]+$" | where Name=="first_launch" | summarize installs=dcount(tostring(Properties.machine_id)) by wk=startofweek(TimeGenerated), src=tostring(Properties.source), upg=tostring(Properties.is_upgrade) | order by wk asc
```

## e11_cli_completed_share_by_provider

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let SS = Cur | where Name=="session_start" | project SessionId, prov=tostring(Properties.provider_id); Cur | where Name=="agent_outcome" | join kind=inner SS on SessionId | summarize n=count(), completed=countif(tostring(Properties.outcome)=="completed"), error=countif(tostring(Properties.outcome)=="error"), machines=dcount(mid) by prov | where n>=20 | extend completion=round(100.0*completed/n,1), err=round(100.0*error/n,1) | order by machines desc
```

## e12_masked_args_pii

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="core_failure" | extend a=tostring(Properties.masked_args) | summarize n=count(), machines=dcount(mid), with_home=countif(a matches regex @"(/Users/[^/]+|/home/[^/]+|C:\\Users\\[^\\]+)"), with_home_m=dcountif(mid, a matches regex @"(/Users/[^/]+|/home/[^/]+|C:\\Users\\[^\\]+)") by AppVersion | where n>20 | order by AppVersion
```

## e13_toolchain

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="tool_chain_outcome" | summarize n=count(), machines=dcount(mid) by src, had_errors=tostring(Properties.had_errors), fo=tostring(Properties.final_outcome) | order by n desc
```

## e14_generation_dur

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="generation" | extend d=todouble(Measurements.duration_ms)/1000 | summarize n=count(), p50_s=round(percentile(d,50),1), p90_s=round(percentile(d,90),1), cache_read_share=round(100.0*sum(todouble(Measurements.tokens_cache_read))/sum(todouble(Measurements.tokens_input_total)),1) by prov=tostring(Properties.provider_id) | where n>300 | order by n desc
```

## e15_sessions_per_machine

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="session_start" | summarize s=dcount(SessionId) by mid, src | summarize machines=count(), p50=percentile(s,50), p90=percentile(s,90), one=countif(s==1) by src
```

## e16_intent_by_src

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="task_classified" | summarize machines=dcount(mid), n=count() by src, intent=tostring(Properties.intent) | order by src, machines desc
```

## e17_completion_trend

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
AppEvents | where TimeGenerated > ago(63d) | where AppVersion matches regex @"^[0-9]+\.[0-9]+\.[0-9]+$" | where Name=="agent_outcome" | extend src=tostring(Properties.source), o=tostring(Properties.outcome) | where src in ("cli","datamates") | summarize n=count(), completion=round(100.0*countif(o=="completed")/count(),1), error=round(100.0*countif(o=="error")/count(),1), machines=dcount(tostring(Properties.machine_id)) by wk=startofweek(TimeGenerated), src | order by wk asc, src
```

## f01_rl_hourly

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where src=="datamates" | summarize gens=countif(Name=="generation"), rl=countif(Name=="error" and tostring(Properties.error_message) has "Rate limit exceeded"), rl_machines=dcountif(mid, Name=="error" and tostring(Properties.error_message) has "Rate limit exceeded"), machines=dcount(mid) by h=hourofday(TimeGenerated) | extend rl_per_100gen=round(100.0*rl/gens,1) | order by h asc
```

## f02_rl_sessions

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let RLS = Cur | where Name=="error" and tostring(Properties.error_message) has "Rate limit exceeded" | distinct SessionId; Cur | where SessionId in (RLS) | summarize gens=countif(Name=="generation"), outcome=anyif(tostring(Properties.outcome), Name=="agent_outcome"), tools=countif(Name=="tool_call") by SessionId | summarize sessions=count(), zero_gen=countif(gens==0), p50_gens=percentile(gens,50), completed=countif(outcome=="completed"), errored=countif(outcome=="error"), no_outcome=countif(isempty(outcome))
```

## f03_rl_first_gen

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let RLS = Cur | where Name=="error" and tostring(Properties.error_message) has "Rate limit exceeded" | summarize rl_t=min(TimeGenerated) by SessionId; Cur | where Name=="session_start" | join kind=inner RLS on SessionId | extend secs=datetime_diff("second", rl_t, TimeGenerated) | summarize sessions=count(), p50_secs_to_rl=percentile(secs,50), p90=percentile(secs,90), under_10s=countif(secs<10)
```

## f04_bedrock

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let BS = Cur | where Name=="session_start" and tostring(Properties.provider_id)=="amazon-bedrock" | project SessionId, AppVersion, src, mid; Cur | where Name=="agent_outcome" | join kind=inner BS on SessionId | summarize n=count(), machines=dcount(mid) by AppVersion, src, o=tostring(Properties.outcome), reason=substring(tostring(Properties.reason),0,90) | order by machines desc
```

## f05_ci_review_daily

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
AppEvents | where TimeGenerated > ago(63d) | where Name=="native_call" and tostring(Properties.method) in ("altimate_core.review_ai_prompt","altimate_core.review_lexical_scan") | summarize runs=dcount(tostring(Properties.machine_id)), events=count() by wk=startofweek(TimeGenerated), AppVersion | order by wk asc
```

## f06_ci_review_sessionless

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let S = Cur | where Name=="session_start" | distinct mid; Cur | where Name=="native_call" and tostring(Properties.method)=="altimate_core.review_ai_prompt" | summarize machines=dcount(mid), sessionless=dcountif(mid, not(mid in (S))), with_review_run=dcountif(mid, mid in (toscalar(Cur | where Name=="review_run" | summarize make_set(mid)))) by AppVersion
```

## f07_notauth_recovery

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let NA = Cur | where Name=="error" and tostring(Properties.error_message) has "Not authenticated" | summarize first_na=min(TimeGenerated) by mid; Cur | where Name=="agent_outcome" | join kind=inner NA on mid | summarize later_completed=dcountif(mid, tostring(Properties.outcome)=="completed" and TimeGenerated>first_na), machines=dcount(mid)
```

## f08_dm_first_session_outcome

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let FS = Cur | where src=="datamates" and Name=="session_start" | summarize arg_min(TimeGenerated, SessionId) by mid | project mid, SessionId; Cur | where Name=="agent_outcome" | join kind=inner FS on SessionId | summarize machines=dcount(mid) by o=tostring(Properties.outcome), cls=tostring(Properties.error_class) | order by machines desc
```

## f09_win_share

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="session_start" and src in ("cli","datamates") | summarize machines=dcount(mid) by src, os=tostring(Properties.os) | order by src, machines desc
```

## f10_events_share

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | summarize n=count() by Name | extend share=round(100.0*n/toscalar(Cur|count),1) | top 8 by n
```

## f11_dm_rl_repeat

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let RL = Cur | where Name=="error" and tostring(Properties.error_message) has "Rate limit exceeded" | summarize days=dcount(bin(TimeGenerated,1d)), n=count() by mid; RL | summarize machines=count(), one_day=countif(days==1), two_plus=countif(days>=2), p50_hits=percentile(n,50), p90_hits=percentile(n,90)
```

## f12_gateway_users

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="session_start" and tostring(Properties.provider_id)=="altimate-backend" | summarize machines=dcount(mid), sessions=dcount(SessionId) by src, AppVersion | order by machines desc
```

## f13_compaction_sessions

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let C = Cur | where Name=="compaction_triggered" | distinct SessionId; Cur | where Name=="agent_outcome" | summarize n=count(), completed=countif(tostring(Properties.outcome)=="completed"), errors=countif(tostring(Properties.outcome)=="error") by compacted=SessionId in (C) | extend completion=round(100.0*completed/n,1)
```

## g01_dm_weekly_decomp

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let R = AppEvents | where TimeGenerated > ago(63d) | where AppVersion matches regex @"^[0-9]+\.[0-9]+\.[0-9]+$" | extend src=tostring(Properties.source), mid=tostring(Properties.machine_id);
let RLS = R | where Name=="error" and tostring(Properties.error_message) has "Rate limit exceeded" | distinct SessionId;
let SS = R | where Name=="session_start" | summarize prov=any(tostring(Properties.provider_id)) by SessionId;
R | where Name=="agent_outcome" and src=="datamates" | extend o=tostring(Properties.outcome), rl=SessionId in (RLS) | join kind=leftouter SS on SessionId
| summarize n=count(), completed=countif(o=="completed"), error=countif(o=="error"), abandoned=countif(o=="abandoned"), aborted=countif(o=="aborted"), rl_sessions=dcountif(SessionId, rl), rl_errors=countif(rl and o=="error"), bp=countif(prov=="opencode"), bp_completed=countif(prov=="opencode" and o=="completed"), bp_error=countif(prov=="opencode" and o=="error"), gw=countif(prov=="altimate-backend"), gw_completed=countif(prov=="altimate-backend" and o=="completed"), gw_error=countif(prov=="altimate-backend" and o=="error"), nonrl=countif(not(rl)), nonrl_completed=countif(not(rl) and o=="completed"), nonrl_error=countif(not(rl) and o=="error"), machines=dcount(mid) by wk=startofweek(TimeGenerated)
| extend comp_pct=round(100.0*completed/n,1), err_pct=round(100.0*error/n,1), comp_excl_ab=round(100.0*completed/(completed+error),1), nonrl_comp=round(100.0*nonrl_completed/nonrl,1), nonrl_err=round(100.0*nonrl_error/nonrl,1), bp_comp=round(100.0*bp_completed/bp,1), bp_err=round(100.0*bp_error/bp,1), gw_comp=round(100.0*gw_completed/gw,1), gw_err=round(100.0*gw_error/gw,1)
| order by wk asc
```

## g02_rl_sessions_full

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let RLS = Cur | where Name=="error" and tostring(Properties.error_message) has "Rate limit exceeded" | distinct SessionId; Cur | where Name=="agent_outcome" and SessionId in (RLS) | summarize n=count(), sessions=dcount(SessionId) by o=tostring(Properties.outcome)
```

## g02b_rl_machines

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let A = Cur | where Name=="error" and tostring(Properties.error_message) has "Rate limit exceeded" | distinct mid; let B = Cur | where Name=="agent_outcome" and tostring(Properties.reason) has "Rate limit exceeded" | distinct mid; Cur | where Name=="session_start" and src=="datamates" | summarize dm=dcount(mid), err_event=dcountif(mid, mid in (A)), outcome_reason=dcountif(mid, mid in (B)), bp=dcountif(mid, tostring(Properties.provider_id)=="opencode"), bp_rl=dcountif(mid, tostring(Properties.provider_id)=="opencode" and mid in (A))
```

## g03_first_session_full

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let FS = Cur | where src=="datamates" and Name=="session_start" | summarize arg_min(TimeGenerated, SessionId) by mid | project mid, SessionId; Cur | where Name=="agent_outcome" | join kind=inner FS on SessionId | summarize machines=dcount(mid) by o=tostring(Properties.outcome) | order by machines desc
```

## g04_upgrade_cohort

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="upgrade_attempted" and src=="datamates" | summarize ok=countif(tostring(Properties.status)=="success"), err=countif(tostring(Properties.status)=="error"), n=count() by mid | summarize machines=count(), events=sum(n), any_ok=countif(ok>0), any_err=countif(err>0), err_only=countif(err>0 and ok==0), ok_only=countif(ok>0 and err==0), both=countif(ok>0 and err>0)
```

## g05_review_per_run

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
Cur | where Name=="review_run" | extend bc=parse_json(tostring(Properties.by_category)) | extend total=toint(bc.lineage_breakage)+toint(bc.semantic_change)+toint(bc.contract_violation)+toint(bc.pii_exposure)+toint(bc.materialization)+toint(bc.warehouse_cost)+toint(bc.test_coverage)+toint(bc.sql_quality)+toint(bc.idempotency)+toint(bc.freshness)+toint(bc.join_risk)+toint(bc.fanout)+toint(bc.dedup)+toint(bc.sql_correctness) | summarize runs=count(), sum_total=sum(total), p50=percentile(total,50), p90=percentile(total,90), max=max(total), degraded_p50=percentileif(total,50,tostring(Properties.degraded)=="true"), full_p50=percentileif(total,50,tostring(Properties.degraded)=="false")
```

## g06_d7_retention

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let FL = Cur | where Name=="first_launch" and src=="cli" and AppVersion in ("0.9.5","0.9.6","0.9.7") and TimeGenerated < W1 - 7d | summarize fl=min(TimeGenerated) by mid; let S = Cur | where Name=="session_start" | distinct mid; FL | join kind=leftouter (Cur | where Name in ("session_start","generation") | project mid, t=TimeGenerated) on mid | summarize interactive=max(iff(isnotempty(t),1,0)), d1=max(iff(t >= fl + 1d and t < fl + 7d,1,0)), d7=max(iff(t >= fl + 7d,1,0)) by mid | summarize installs=count(), any_session=countif(interactive==1), active_d1_to_d6=countif(d1==1), active_d7plus=countif(d7==1)
```

## g07_bedrock_causes

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let BS = Cur | where Name=="session_start" and tostring(Properties.provider_id)=="amazon-bedrock" | distinct SessionId; Cur | where Name=="agent_outcome" and SessionId in (BS) | extend r=tostring(Properties.reason) | extend cause=case(r has "parseKnownFiles","bundling", r has "SigV4 authentication requires","no_credentials", r has "security token","bad_or_expired_token", r has "model identifier","bad_model_id", r has "use case" or r has "verified","account_not_enabled", tostring(Properties.outcome)!="error","non_error", "other") | summarize outcomes=count(), machines=dcount(mid) by cause | order by outcomes desc
```

## g08_population_union

```kql
let W0=datetime(2026-08-19); let W1=datetime(2026-09-02); let P0=datetime(2026-08-05);
let RX = @"^[0-9]+\.[0-9]+\.[0-9]+$";
let All = AppEvents | where TimeGenerated between (P0 .. W1) | extend mid=tostring(Properties.machine_id), src=tostring(Properties.source), win=iff(TimeGenerated>=W0,"cur","prev"), rel=AppVersion matches regex RX;
let Rel = All | where rel;
let Cur = Rel | where win=="cur";
let Prev = Rel | where win=="prev";
let Fleet = Cur | where AppVersion in ("0.7.3","0.9.3","0.8.3") | distinct mid; Cur | summarize srcs=make_set(src) by mid | extend fleet=mid in (Fleet), has_dm=set_has_element(srcs,"datamates"), has_cli=set_has_element(srcs,"cli") | summarize total=count(), fleet_ids=countif(fleet), dm_only=countif(not(fleet) and has_dm and not(has_cli)), cli_only=countif(not(fleet) and has_cli and not(has_dm)), dm_and_cli=countif(not(fleet) and has_dm and has_cli), neither=countif(not(fleet) and not(has_dm) and not(has_cli))
```
