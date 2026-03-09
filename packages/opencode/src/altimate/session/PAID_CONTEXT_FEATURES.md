# Paid Context Management Features

These features are planned for implementation in altimate-core (Rust) and gated behind license key verification.

## 1. Precise Token Counting

**Bridge method:** `context.count_tokens(text, model_family) -> number`

Uses tiktoken-rs in altimate-core for exact model-specific token counts. Replaces the heuristic estimation in `token.ts`. Supports cl100k_base (GPT-4/Claude), o200k_base (GPT-4o), and future tokenizers.

**Benefits:**
- Eliminates 20-30% estimation error
- Precise compaction triggering — no late/early compaction
- Accurate token budget allocation

## 2. Smart Context Scoring

**Bridge method:** `context.score_relevance(items[], query) -> scored_items[]`

Embedding-based relevance scoring for context items. Used before compaction to drop lowest-scoring items first, preserving the most relevant conversation history. Uses a local embeddings model (no external API calls required).

**Benefits:**
- Drops irrelevant context before compaction
- Preserves high-value conversation segments
- Reduces unnecessary compaction cycles

## 3. Schema Compression

**Bridge method:** `context.compress_schema(schema_ddl, token_budget) -> compressed_schema`

Schemonic-style ILP (Integer Linear Programming) optimization. Extends the existing `altimate_core_optimize_context` tool. Achieves ~2x token reduction on schema DDL without accuracy loss by intelligently abbreviating column names, removing redundant constraints, and merging similar table definitions.

**Benefits:**
- Fits 2x more schema context in the same token budget
- No accuracy loss on downstream SQL generation
- Works with all warehouse dialects

## 4. Lineage-Aware Context Selection

**Bridge method:** `context.select_by_lineage(model_name, manifest, hops) -> relevant_tables[]`

Uses dbt DAG / lineage graph to scope relevant tables. PageRank-style relevance scoring weights tables by proximity and importance in the dependency graph. Configurable hop distance for breadth of context.

**Benefits:**
- Only includes tables relevant to the current model/query
- Reduces schema context by 60-80% for large warehouses
- Leverages existing dbt manifest parsing

## 5. Semantic Schema Catalog

**Bridge method:** `context.generate_catalog(schema, sample_data) -> yaml_catalog`

YAML-based semantic views (similar to Snowflake Cortex Analyst). Auto-generates business descriptions, data types, and relationships from schema + sample data. Serves as a compressed, human-readable schema representation.

**Benefits:**
- Business-friendly context for the LLM
- More token-efficient than raw DDL
- Auto-generates from existing schema metadata

## 6. Context Budget Allocator

**Bridge method:** `context.allocate_budget(model_limit, task_type) -> { system, schema, conversation, output }`

Explicit token allocation across categories. Dynamic adjustment based on task type (query writing vs. debugging vs. optimization). Prevents any single category from consuming the entire context window.

**Benefits:**
- Prevents schema from crowding out conversation history
- Task-appropriate allocation (more schema for query writing, more conversation for debugging)
- Works with the compaction system to respect budgets
