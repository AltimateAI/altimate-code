# Onboarding Flow Diagrams

*v1 (`plg-onboarding-prototype`) = Diagram 1 + Diagram 2.*
*v2 (`plg-onboarding-prototype-v2`) = Diagram 1 + Diagram 2 + Diagram 3.*
The two versions are identical through the scan gate; v2 continues every Part-2
endpoint into the activation menu instead of stopping at chat-live.

GitHub renders these Mermaid blocks natively.

---

## Diagram 1 — Part 1: get a working model (both versions)

```mermaid
flowchart TD
    A([Launch CLI]) --> B{Valid credentials<br/>already stored?}
    B -- "yes — returning user" --> B1{Gateway key<br/>still valid?}
    B1 -- yes --> CHAT0([Straight to chat<br/>no onboarding])
    B1 -- "401/403 — expired" --> G1
    B -- "no — fresh install" --> C[Boot screen +<br/>curated picker opens immediately]

    C --> D{Pick a provider}
    D -- esc --> C2[Home, calm hint:<br/>“Type /connect…”<br/>any message reopens picker]
    C2 -.-> D

    D -- "Altimate LLM Gateway<br/>(Recommended · 10M free tokens)" --> G1
    D -- "Anthropic / OpenAI / Google<br/>(bring your own key)" --> K1
    D -- "Big Pickle (free)" --> P1{Interstitial:<br/>“often fails at data tasks”<br/>default **No**}
    P1 -- No --> D
    P1 -- Yes --> READY

    subgraph WEB ["Browser signup (stub = future backend)"]
      G2["/register — Google-only<br/>+ value section"]
      G2 -- "Continue with Google" --> G3["Google chooser<br/>(workspace only — hd param)"]
      G2 -- "or use email instead" --> G4["work email + password<br/>(personal domains blocked)"]
      G4 --> G5["/verify → click link in inbox"]
      G3 --> G6
      G5 --> G6["/instance — name pre-filled from<br/>email domain, live availability<br/>(taken → suggests acme-2)"]
      G6 -- Continue --> G7["provisioning (~8s)<br/>key minted server-side"]
    end

    G1[CLI starts OAuth device flow<br/>opens browser] --> G2
    G7 --> G8[CLI has been polling silently:<br/>awaiting_name → provisioning → ready]
    G8 --> G9["creds saved (name + key together)<br/>key never displayed<br/>✓ Instance ready · 10M free tokens"] --> READY

    K1[Existing auth-method screens<br/>UNCHANGED] --> K2{Stage 1<br/>key ping}
    K2 -- invalid --> K3["exactly two options:<br/>enter a valid key /<br/>use Altimate Gateway"] --> K1
    K2 -- valid --> K4{Stage 2<br/>forced tool call}
    K4 -- fail --> K5["Retry / use Gateway /<br/>type “continue”<br/>→ ⚠ unreliable-model chip"] --> READY
    K4 -- pass --> READY

    READY([Model ready — chat live])
```

Invariant: chat is unreachable until READY — enforced by guidance (picker-first,
filtered slash menu, submit gate that opens the picker), never by error copy.

---

## Diagram 2 — Part 2: connect the data environment (both versions)

```mermaid
flowchart TD
    R([Model ready]) --> G{"Scan your environment?<br/>(fires once, honest help text,<br/>no auto-scan)"}

    G -- Yes --> PS["project_scan<br/>local, read-only"]
    PS --> W{What was found?}

    W -- "warehouse found<br/>(with or without dbt)" --> F1["repo's /discover flow AS-IS:<br/>friendly summary → offer to add +<br/>test connections → index schemas →<br/>next steps"]
    W -- "dbt project,<br/>no warehouse" --> F2["“Which warehouse does it run<br/>against?” → warehouse_add walk-through"]
    W -- "no dbt,<br/>but a git repo" --> F3["“/discover looks up from where you<br/>launched — cd into your project<br/>and run it again”"]
    W -- "genuinely nothing" --> F4["“Nothing to connect yet” →<br/>explain a concept / review pasted SQL /<br/>scaffold a project"]

    G -- No --> F5["“No problem. What are you working<br/>on — dbt project, warehouse,<br/>or just exploring?”"]

    F1 --> E
    F2 --> E
    F3 --> E
    F4 --> E
    F5 --> E

    E(["v1 ENDS HERE: chat live<br/>(two valid exits: connected, or<br/>come-back-with-data via /discover)"])
```

No branch ever ends on a bare “nothing found” — every outcome converts into a
connection, a question, or a concrete next action.

---

## Diagram 3 — Part 3: activation menu + sample (v2 only)

```mermaid
flowchart TD
    E([Any Part-2 endpoint]) --> M{"Activation menu<br/>“What would you like to do?”<br/>(JTBD wording, composed for what<br/>THIS environment can do)"}

    M -- "connected path —<br/>personalized from scan<br/>(“You've got N dbt models…”)" --> J1
    M -- connected path --> J2
    M -- "connected path<br/>REAL warehouse only" --> J3["Find what's driving warehouse cost<br/>→ cost-report skill"]
    M -- "no-data / declined —<br/>LEAD option" --> SMP["Try Altimate on a sample dbt project<br/>(jaffle-shop DuckDB — nothing touches<br/>your warehouse)"]
    M -- any path --> FREE["Something else — describe it<br/>→ free chat"]

    SMP --> SS["sample_setup tool:<br/>deterministic DuckDB seed<br/>(customers 100 · orders 300 · payments 326)<br/>+ real dbt project (5 models, 13 tests)<br/>+ connection registered via warehouse.add"]
    SS --> M2{"Sample menu<br/>(cost-report deliberately absent —<br/>DuckDB has no cost data)"}

    M2 --> J1["See what breaks downstream before<br/>you change a model<br/>→ dbt-analyze skill"]
    M2 --> J2["Review a SQL PR with every finding<br/>explained → sql-review skill"]
    M2 --> J4["Build & query it →<br/>real dbt build + sql_execute"]

    J1 --> ACT
    J2 --> ACT
    J3 --> ACT
    J4 --> ACT
    ACT([First real job runs =<br/>ACTIVATION])
```

Selecting a job **starts** it (skills are the verified built-ins: `dbt-analyze`,
`sql-review`, `cost-report`) — the menu is the last menu the user sees.
