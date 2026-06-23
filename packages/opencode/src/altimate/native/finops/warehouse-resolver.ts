/**
 * Shared warehouse resolution for finops.* handlers.
 *
 * The finops tools (analyze_credits, query_history, etc.) all need to map a
 * caller-supplied warehouse name to a configured connection and validate that
 * its driver type supports the requested operation. Before this helper, each
 * handler returned `{ success: false, error: "Credit analysis is not available
 * for unknown warehouses." }` when the warehouse was missing or unknown —
 * which the LLM cannot fix because the error doesn't say which warehouses are
 * available or how to add one.
 *
 * Telemetry (memory/telemetry-analysis-2026-05-21.md) showed `finops_*` tools
 * at 100% error rate. The dominant failure mode was the LLM passing an
 * unconfigured warehouse name and getting a dead-end response. This helper
 * fixes both: it falls back to the first compatible warehouse when none is
 * specified, and produces actionable errors when resolution fails.
 */

import * as Registry from "../connections/registry"

/**
 * Default supported driver types for finops operations that work against any
 * cloud warehouse with usage/billing tables (credit analysis, sizing advice,
 * unused-resource detection, etc.). Centralized here so adding a new
 * warehouse driver doesn't require touching 3+ handler files.
 *
 * Operations with narrower support (e.g. Snowflake-only role hierarchy,
 * postgres-aware query history) declare their own const arrays.
 */
export const DEFAULT_FINOPS_TYPES = ["snowflake", "bigquery", "databricks"] as const

export type FinopsWarehouseResolution =
  | { kind: "ok"; warehouse: string; type: string; autoPicked: boolean }
  | { kind: "error"; error: string }

export interface ResolveOptions {
  /** Caller-supplied warehouse name. May be empty/undefined. */
  requested?: string
  /** Driver types this finops operation supports (e.g. ["snowflake", "bigquery", "databricks"]). */
  supportedTypes: readonly string[]
  /** Operation name for error messages (e.g. "Credit analysis"). */
  operationName: string
}

/**
 * Resolve a warehouse for a finops operation.
 *
 * Resolution order:
 * 1. If `requested` is provided and configured AND its type is supported -> ok.
 * 2. If `requested` is provided but not configured -> error listing available.
 * 3. If `requested` is provided and configured but the type is unsupported -> error.
 * 4. If `requested` is not provided -> auto-pick first warehouse with a supported type.
 * 5. If no warehouses are configured at all -> error pointing at warehouse_add.
 */
export function resolveFinopsWarehouse(opts: ResolveOptions): FinopsWarehouseResolution {
  const { requested, supportedTypes, operationName } = opts
  const all = Registry.list().warehouses
  const supportedList = supportedTypes.join(", ")

  if (all.length === 0) {
    return {
      kind: "error",
      error:
        `${operationName} requires a configured warehouse, but none are set up. ` +
        `Add one with the warehouse_add tool, or via your altimate-code config. ` +
        `Supported types for this operation: ${supportedList}.`,
    }
  }

  if (requested && requested.trim() !== "") {
    // Trim before matching — LLMs occasionally surface warehouse names with
    // stray whitespace from prompt copy-paste or YAML/JSON serialization
    // edge cases. Without this, `" prod_wh"` reports as unknown even though
    // the configured warehouse is `"prod_wh"`. The trim is on the lookup
    // key only; configured names are stored as-is.
    const requestedTrimmed = requested.trim()
    const match = all.find((w) => w.name === requestedTrimmed)
    if (!match) {
      // Error messages enumerate configured warehouse names so the LLM can
      // self-correct. This is intentional — names are already accessible via
      // the warehouse_list tool, so this is not new information disclosure;
      // it just shortens the recovery path.
      const availableNames = all.map((w) => w.name).join(", ")
      return {
        kind: "error",
        error:
          `Warehouse ${JSON.stringify(requested)} is not configured. ` +
          `Available warehouses: ${availableNames}. ` +
          `Pass one of those as the 'warehouse' parameter, or omit it to use the default.`,
      }
    }
    // Driver types are case-insensitive (DRIVER_MAP in registry.ts uses
    // toLowerCase()). Normalize here so a config with `type: "Snowflake"`
    // resolves the same as `type: "snowflake"`.
    const matchTypeLower = match.type.toLowerCase()
    if (!supportedTypes.includes(matchTypeLower)) {
      const compatible = all
        .filter((w) => supportedTypes.includes(w.type.toLowerCase()))
        .map((w) => w.name)
      const hint =
        compatible.length > 0
          ? `Try one of: ${compatible.join(", ")}.`
          : `Add a warehouse of one of these types: ${supportedList}.`
      return {
        kind: "error",
        error: `${operationName} is not available for ${match.type} warehouses. ${hint}`,
      }
    }
    return { kind: "ok", warehouse: match.name, type: matchTypeLower, autoPicked: false }
  }

  // No requested warehouse — auto-pick first compatible.
  //
  // Order is whatever Registry.list() returns, which follows config-load order
  // (global file → local file → env vars). Deterministic per machine but may
  // vary across machines for the same user. Matches the existing sql.explain
  // fallback pattern in connections/register.ts.
  const compatible = all.find((w) => supportedTypes.includes(w.type.toLowerCase()))
  if (!compatible) {
    const availableTypes = Array.from(new Set(all.map((w) => w.type))).join(", ") || "(none)"
    return {
      kind: "error",
      error:
        `${operationName} is not supported by any of your configured warehouses ` +
        `(${availableTypes}). Supported types: ${supportedList}. ` +
        `Add a compatible warehouse with the warehouse_add tool.`,
    }
  }
  return { kind: "ok", warehouse: compatible.name, type: compatible.type.toLowerCase(), autoPicked: true }
}
