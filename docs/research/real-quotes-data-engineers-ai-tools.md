# Real Quotes: Data Engineers & Practitioners on AI Coding Tools

**Research date:** 2026-03-09
**Sources:** Hacker News (comments via Algolia API), Substack
**Method:** Direct quote extraction from HN comment_text fields — verbatim, not paraphrased

---

## THEME 1: The Context/Architecture Control Problem

### "I'm anxious about losing control over the architecture and data model"

**Source:** HN comment by `echelon` (thread on Claude Code agentic workflows)

> "Claude Code has killed my ADHD and turned me into an always-on hyper-focused machine. I am getting 20x done. This is a literal superpower. I am not using it in agentic mode yet. I am telling it everything I want it to do. I will tell it where I want the files, what I want structs to be named, **how I want the SQL queries to join, etc.** I then review every line and make edits (typically with Claude first). I haven't tried the agentic stuff yet, but I probably will at some point soon. **I'm anxious about losing control over the architecture and data model, which is something I feel gives me my speed with Claude Code and that I know is important for my engineering work and quality.**"
>
> "I'll also reiterate what others are saying in that I think this is a tool best leveraged by engineers who know what they're doing and that care about code quality. The results you get back will also depend on your repo/project's code quality. **If your project is poorly structured or has a lot of cruft, Claude will see that and spit it right back out.** Keeping your code clean and low on tech debt is going to matter tremendously."

**Key phrases:**
- "how I want the SQL queries to join"
- "anxious about losing control over the architecture and data model"
- "Claude will see that and spit it right back out"

---

### "Context engineering is (still) most of the work"

**Source:** HN comment by `y14` (thread on building AI systems for data)

> "Thanks for the question. Avoiding context bloat and overall engineering the context is (still) most of work. What's been working:
>
> - Role scoped calls: data modeling, code gen, are separate calls where each gets its own tailored context
> - Context is divided into sections (tables, dbt, instructions, code) and each is getting a hard limit budget (required some experimentation, liked Cursor's priompt project)
> - agentic retrieval: agents can call tools to fetch or search data/metadata when needed
> - summaries for different objects: messages, widgets; reports, data samples/profiles."

**Key phrases:**
- "Avoiding context bloat and overall engineering the context is (still) most of work"
- "Context is divided into sections (tables, dbt, instructions, code)"
- "hard limit budget"

---

## THEME 2: The "It Works in Demo, Fails in Production" Problem

### "Every multi-agent framework I tried solved the demo but collapsed in production"

**Source:** HN comment by `vincentvandeth` (Show HN: VNX multi-agent governance system)

> "Hey HN. I've been running multi-agent AI coding workflows in production for 6 months now, and VNX is the governance system I built to make it actually work.
>
> The problem isn't getting AI agents to write code — it's knowing when they went wrong, why, and preventing the same failure next time.
>
> **Every multi-agent framework I tried solved the demo but collapsed in production: no audit trail, no way to scope tasks, no quality enforcement, and when something broke three agents deep, no way to trace it.**
>
> VNX is a different approach. Four components, all filesystem-based...
>
> 3. Quality gates — Deterministic, not LLM-based. The agent proposes, the gate validates: file size limits, test coverage thresholds, open blocker counts. Verdicts are APPROVE, HOLD, or ESCALATE. **The LLM never decides whether its own work is good enough.**
>
> 4. Context rotation — When an agent's context window fills up mid-task, a 3-hook pipeline detects it at 65%, has the agent write a structured handover, clears the session via tmux, and resumes with a fresh context window."

**Key phrases:**
- "solved the demo but collapsed in production"
- "no audit trail, no way to scope tasks, no quality enforcement"
- "when something broke three agents deep, no way to trace it"
- "The LLM never decides whether its own work is good enough"

---

### "The biggest challenge for many organizations right now isn't building models — it's building reliable systems around them"

**Source:** HN comment by `tmuhlestein` (AWS/GoDaddy production AI case study thread)

> "One challenge many teams are hitting right now is the gap between AI demos and production AI systems...
>
> What's interesting from a systems perspective isn't just the model usage, but the broader shift toward treating AI as part of production infrastructure:
> - data pipelines that continuously feed models
> - orchestration layers around LLM workflows
> - recursive learning platforms that allow real-world signals to continuously improve systems
> - integration into existing operational systems
>
> **The biggest challenge for many organizations right now isn't building models — it's building reliable systems around them.**
>
> Curious how others here are approaching AI infrastructure vs experimentation."

---

## THEME 3: The Verification Tax ("You Always Have to Check")

### "The 15 minutes of amazingly fast AI code gen has ballooned into taking most of the afternoon"

**Source:** HN comment by `marginalia_nu` (evaluating Claude Opus 4.6 on an existing codebase)

> "So in my experience with Opus 4.6 evaluating it in an existing code base has gone like this.
>
> You say 'Do this thing'.
> - It does the thing (takes 15 min). Looks incredibly fast. I couldn't code that fast. It's inhuman. So far all the fantastical claims hold up.
>
> But still. You ask 'Did you do the thing?'
> - it says oops I forgot to do that sub-thing. (+5m)
>
> You say is the change well integrated with the system?
> - It says not really, let me rehash this a bit. (+5m)
>
> You say does this follow best engineering practices, is it good code, something we can be proud of?
> - It says not really, here are some improvements. (+5m)
>
> You say to look carefully at the change set and see if it can spot any potential bugs or issues.
> - It says oh, **I've introduced a race condition at line 35 in file foo and an null correctness bug at line 180 of file bar. Fixing.** (+15m)
>
> You ask if there's test coverage for these latest fixes?
> - **It says 'i forgor' and adds them. (+15m)**
>
> Now the change set has shrunk a bit and is superficially looking good. Still, you must read the code line by line, and with an experienced eye will still find weird stuff happening...
>
> **Now the 15 minutes of amazingly fast AI code gen has ballooned into taking most of the afternoon.**
>
> **Telling Claude to be diligent, not write bugs, or to write high quality code flat out does not work.** And even if such prompting can reduce the odds of omissions or lapses, **you still always always always have to check the output.** It can not find all the bugs and mistakes on its own. If there are bugs in its training data, you can assume there will be bugs in its output."

**Key phrases:**
- "15 minutes of amazingly fast AI code gen has ballooned into taking most of the afternoon"
- "Telling Claude to be diligent, not write bugs, or to write high quality code flat out does not work"
- "you still always always always have to check the output"

---

### "If software engineering becomes 'AI output verification', I won't choose to be a software engineer anymore"

**Source:** HN comment by `camgunz` (thread on AI replacing software engineers)

> "But the pitch with AI is, 'just dump stuff in the text box and poof', and somewhere in tiny font or buried in fine print is, 'sometimes we goof, you should check things'. But that's completely antithetical to the product because **the more work you ask the AI to do, the more you have to check.** If I'm just like 'hey write me a fast inverse square root function' I have like 12 lines to check. If I'm like, 'hey could you build me a distributed key value store' imagine the code I have to review and the concepts I have to understand (C++?) in order to really check the work.
>
> ...
>
> **But if software engineering becomes 'AI output verification', I won't choose to be a software engineer anymore, because that's not the fun part.** I don't know how many people will want to be AI output verifiers. The level of social change this threatens is monumental; one starts imagining a world where people just kind of lounge in sunny parks pursuing their dreams, but in truth I think the future is closer to **us just reading reams of AI-generated whatever checking it for errors.**"

**Key phrases:**
- "the more work you ask the AI to do, the more you have to check"
- "AI output verification"
- "reading reams of AI-generated whatever checking it for errors"

---

## THEME 4: Hallucinations, Schema Errors & Data Mistakes

### "AI hallucinated a bunch of fields, and got many types wrong"

**Source:** HN comment by `pornel` (thread on AI coding tool limitations)

> "I've tried Claude and GPT4o for a task that required translating imperative code that writes structured data to disk field by field into explicit schema definitions. It was an easy, but tedious task (I've had many structs to convert). **AI hallucinated a bunch of fields, and got many types wrong, wasting a lot of my time on diagnosing serialization issues.** I really wanted it to work, but I've burned over $100 in API credits (not counting subscriptions) trying various editors and approaches. I've wasted time and money managing context for it, to give it enough of the codebase to stop it from hallucinating the missing parts, but also carefully trim it to avoid distracting it or causing rot. **It just couldn't do the work precisely.** In the end I had to scrap it all, and do it by hand myself.
>
> I've tried gpt4o and 4-mini-high to write me a specific image processing operation. They could discuss the problem with seemingly great understanding... But the implementation had a fundamental flaw that caused numeric overflows. **AI couldn't fix it itself** (kept inventing stupid workarounds that didn't work or even defeated the point of the whole algorithm). When told step by step what to do to fix it, **it kept breaking other things in the process.**
>
> I've tried to make AI upgrade code using an older version of a dependency to a newer one. I've provided it with relevant quotes from the docs...The AI couldn't properly copy-paste code from one function to another. It kept reverting things. **When I pointed out the issues, it kept apologising, saying what new APIs it's going to use, and then use the old APIs again!**"

**Key phrases:**
- "hallucinated a bunch of fields, and got many types wrong"
- "wasting a lot of my time on diagnosing serialization issues"
- "burned over $100 in API credits"
- "kept apologising, saying what new APIs it's going to use, and then use the old APIs again"

---

### "The AI will reproduce some rookie mistake it saw 1,000,000 times in its training data"

**Source:** HN comment by `teaearlgraycold` (thread on Vanna text-to-SQL tool)

> "I think a critical feature is tying the original SQL query to all artifacts generated by Vanna.
>
> Vanna would be helpful for someone that knows SQL when they don't know the existing schema and business logic and also just to save time as a co-pilot. **But the users that get the most value out of this are the ones without the ability to validate the generated SQL. Issues will occur** - people will give incomplete definitions to the AI, **the AI will reproduce some rookie mistake it saw 1,000,000 times in its training data** (like failing to realize that by default a UNIQUE INDEX will consider NULL != NULL), etc. At least if all distributed assets can tie back to the query people will be able to retroactively verify the query."

**Key phrases:**
- "the ones without the ability to validate the generated SQL"
- "the AI will reproduce some rookie mistake it saw 1,000,000 times in its training data"
- "retroactively verify the query"

---

## THEME 5: Security — AI-Generated Code in Production Data Systems

### "It already found 204 SQL injections in one user's production betting site — all from following AI suggestions"

**Source:** HN comment by `ThailandJohn` (Show HN: TheAuditor security scanner)

> "That's exactly why I built TheAuditor - because I DON'T trust the code I had AI write. When you can't verify code yourself, you need something that reports ground truth.
>
> The beautiful irony: I used AI to build a tool that finds vulnerabilities in AI-generated code. **It already found 204 SQL injections in one user's production betting site - all from following AI suggestions.**
>
> AI can write code, but **you NEED automated verification.** What could go wrong? Without tools like this, everything. That's the point."

---

### "Prompt injection + Data exfiltration is the new social engineering in AI Agents"

**Source:** HN comment by `rvz` (thread on AI agent security)

> "Assuming that this will be using the totally flawed MCP protocol, I can only see more cases of data exfiltration attacks on these AI systems just like before.
>
> **Prompt injection + Data exfiltration is the new social engineering in AI Agents.**"

---

### "AI coding agents are writing more of our code, but they're also introducing new attack surfaces"

**Source:** HN comment by `dchitimalla1` (MCP security scanner)

> "AI coding agents are writing more of our code, but they're also introducing new attack surfaces: **prompt injection hidden in codebases, hallucinated package names that attackers register as malware, and data exfiltration through manipulated agents.**"

---

## THEME 6: Multi-Agent Chaos — Agents That Generate Work Instead of Doing It

### "Work completely stopped while the agents were busy managing"

**Source:** HN comment by `yego` (Show HN: Solo founder built SaaS with multi-agent Claude Code)

> "I 'hired' a CEO agent. Gave it broad authority to organize the project. It went wild. Within hours it rushed to create 20 roles — CTO, DevOps Lead, QA Engineer, Helper Tester, Documentation Specialist — and wrote detailed technical regulations for each one. Then the agents started writing memos to each other. Scheduling alignment meetings. Running brainstorming sessions. **Work completely stopped while the agents were busy managing.**
>
> I went through the entire investor arc — the one that usually takes founders 3–5 years — in about a day and a half. From the hopeful optimism of hiring a CEO, to watching the org chart explode, to complete disillusionment, to demoting the CEO back to a regular worker and taking back full control.
>
> **Lesson learned: agents will happily create organizational complexity forever. You have to constrain them hard.**"

> "One Claude Code instance is powerful but limited. Give it a big task and it **either oversimplifies or loses critical details.**"

**Key phrases:**
- "agents will happily create organizational complexity forever"
- "either oversimplifies or loses critical details"
- "Work completely stopped while the agents were busy managing"

---

## THEME 7: What Actually Matters in Production Agent Systems

### "State management across multi-step workflows that can fail at any point"

**Source:** HN comment by `evara-ai` (thread on production AI agent systems)

> "Having built a bunch of production AI agent systems (workflow automation, conversational agents, **data pipelines with LLM-in-the-loop**) in Python and Node.js — my take is that language choice is genuinely the least important decision you'll make.
>
> The bottleneck in agent systems is almost never your language runtime. It's LLM API latency (200-2000ms per call), external service I/O, and retry/error handling across unreliable tool calls...
>
> **What actually matters for production agent systems: (1) state management across multi-step workflows that can fail at any point, (2) graceful degradation when one tool in a chain times out, (3) observability into what the agent decided and why.** These are design problems, not language problems.
>
> When you're iterating on agent behavior (which is 80% of the work), that ecosystem advantage compounds fast."

**Key phrases:**
- "state management across multi-step workflows that can fail at any point"
- "graceful degradation when one tool in a chain times out"
- "observability into what the agent decided and why"
- "iterating on agent behavior (which is 80% of the work)"

---

## THEME 8: Practitioner Language — How They Actually Describe Their Work

### Job post / profile language (what DEs call themselves and their work)

**Source:** HN "Who's Hiring" / "Who Wants to Be Hired" posts, multiple posters:

From `straydusk` (data engineering practitioner, Seattle):
> "AI-Assisted Development (Claude Code, Cursor) ... dbt, Tableau, Amplitude, Snowflake, Airflow, BigQuery, Athena, S3, Iceberg, Redshift, Dagster, Fivetran, Sigma, Mixpanel, Optimizely, Kafka"

From `teetertater` (fractional data/ML leader, Vienna):
> "10+ years of experience delivering end-to-end AI projects on tight deadlines. I help companies plan, prototype, and productionalize machine learning systems, modern data pipelines, and enterprise-grade Agentic systems... ML Engineering: Spark, Databricks, DuckDB, **dbt/SQLMesh**, Delta Lake/Iceberg, Airflow/Dagster, MS Agent Framework (AutoGen)"

From `londheana` (data engineer, Austin):
> "Data Engineering: ETL/ELT Pipelines, dbt, Apache Airflow, Delta Live Tables, DuckDB ... Cloud & Platforms: Databricks (Delta Lake, Unity Catalog, AgentBricks), AWS, Snowflake, Redshift ... AI & Agentic Systems: LangChain, CrewAI, A2A Protocol, LLM Orchestration, AI Gateway, Claude Code"

**Vocabulary patterns:**
- "productionalize" (not "deploy to production")
- "end-to-end" (a recurring qualifier)
- "enterprise-grade Agentic systems"
- "data pipelines with LLM-in-the-loop"
- "ETL/ELT Pipelines" (always slash both)
- Stack always listed as a dense comma-separated string

---

## THEME 9: The Human-in-the-Loop Reality

### What actually works: engineering-led, not AI-led

**Source:** HN comment by `yego` (multi-agent architecture):

> "The UI is always the source of truth. Backend serves what the UI needs — not the other way around."
> "Each agent's CLAUDE.md defines its role, tech stack, conventions, and **what it's NOT allowed to touch.**"

**Source:** HN comment by `vincentvandeth` (VNX governance):

> "Quality gates — Deterministic, not LLM-based. The agent proposes, the gate validates...  **The LLM never decides whether its own work is good enough.**"

**Source:** HN comment by `ako` (MCP for database work):

> "In my experience most AI coding tools can work with databases, especially if you give it an MCP tool to connect to your (development) database. It will generate mermaid er-diagrams by reading from your database catalog, it will generate SQL to create tables, views, etc. It will generate queries, **validate them and return data.** It will optimize your query performance by running the query, running explain plan, looking into pg_stat_statements... I will create demo data with realistic use cases like black friday or back to school discounts for prices, etc. **A SQL MCP + mermaid is all you need.**"

---

## THEME 10: Skepticism of the Hype

### "Standard LinkedIn/X influencer slop"

**Source:** HN comment by `paxys` (on AI data engineering influencer content):

> "Teaching engineers to build production AI systems | AI agents, LLMs, ML, data engineering | In the newsletter, I wrote the full timeline + what I changed so this doesn't happen again. If you found this post helpful, follow me for more content like this.
>
> So yeah, this is **standard LinkedIn/X influencer slop.**"

**Source:** HN comment by `sakopov`:

> "Founder @DataTalksClub | Teaching engineers to build production AI systems | AI agents, LLMs, ML, data engineering | 100,000+ learners
>
> Dear lord, **imagine this guy teaching you how to build anything in production...**"

---

## RAW SIGNAL SUMMARY: What Data Engineers Actually Fear

Based on the quotes above, the core fears practitioners express are:

1. **Loss of architectural control** — "anxious about losing control over the architecture and data model"
2. **Hallucinated schemas/fields** — "hallucinated a bunch of fields, and got many types wrong"
3. **The verification burden** — "the more work you ask the AI to do, the more you have to check"
4. **Production collapse** — "solved the demo but collapsed in production"
5. **Security holes from AI code** — "204 SQL injections from following AI suggestions"
6. **Agents generating complexity instead of value** — "agents will happily create organizational complexity forever"
7. **Opaque failures** — "when something broke three agents deep, no way to trace it"
8. **Reproducible rookie mistakes** — "the AI will reproduce some rookie mistake it saw 1,000,000 times in its training data"
9. **Context bleed** — "Avoiding context bloat and overall engineering the context is (still) most of work"
10. **The gap between demo and prod** — "the gap between AI demos and production AI systems"

---

## VOCABULARY: Exact Phrases Practitioners Use (Not Vendor Marketing)

| What Vendors Say | What Practitioners Say |
|---|---|
| "AI-powered data pipeline" | "data pipelines with LLM-in-the-loop" |
| "Intelligent automation" | "productionalize" |
| "Seamless integration" | "when something broke three agents deep, no way to trace it" |
| "10x productivity" | "the 15 minutes of amazingly fast AI code gen has ballooned into taking most of the afternoon" |
| "Trust the AI" | "The LLM never decides whether its own work is good enough" |
| "AI handles it" | "you still always always always have to check the output" |
| "Agentic workflows" | "state management across multi-step workflows that can fail at any point" |
| "Context-aware" | "avoiding context bloat is (still) most of work" |
| "Reliable" | "solved the demo but collapsed in production" |
| "Smart suggestions" | "AI will reproduce some rookie mistake it saw 1,000,000 times in its training data" |

---

*All quotes sourced directly from HN comment_text fields via Algolia API. Dates: 2024-2026.*
