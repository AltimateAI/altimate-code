/**
 * Adversarial tests for v0.9.3 release changes and Step 5 review-fix set:
 *
 * 1. Envelope-level policy audit — `engine.cliVersion` present + covered by
 *    signature; `staleManifest` present + covered by signature; unforced
 *    envelopes stay clean (undefined, not false).
 * 2. Tier-reason PR-comment leak — a `full`-tier verdict now surfaces the
 *    classifier reasons in the envelope (they render in the PR comment via
 *    format.ts) even without `--explain-tier`; `trivial` / `lite` stay quiet
 *    to avoid noise on approvals.
 * 3. Stale-manifest detection — the `opts.head` gate is gone, so the local
 *    working-tree case now detects staleness; the returned boolean drives the
 *    envelope field; non-manifest-affecting file changes must NOT trip the
 *    signal.
 * 4. Manifest auto-discovery — hostile filesystem shapes (no dbt_project.yml,
 *    dbt_project.yml with no target/, symlink-loops via realpath) return
 *    undefined rather than crashing.
 *
 * Every assertion is deterministic — no timing dependencies, no shared state,
 * no `mock.module()`. Runs against the real `buildEnvelope` / `signEnvelope`
 * pipeline and the real `runReview` orchestrator with a stub runner.
 */

import { describe, test, expect } from "bun:test"
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildEnvelope,
  signEnvelope,
  verifyEnvelope,
} from "../../src/altimate/review/verdict"
import { isManifestAffecting, reviewPullRequest } from "../../src/altimate/review/run"
import { runReview } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { renderSummary } from "../../src/altimate/review/format"
import type { ReviewRunner } from "../../src/altimate/review/orchestrate"
import type { ChangedFile } from "../../src/altimate/review/diff-filter"
import type { EquivalenceResult } from "../../src/altimate/review/orchestrate"

// A tiny runner that returns clean lanes — enough for the orchestrator to
// build an envelope but not enough to generate any findings that would move
// the verdict off APPROVE.
const inertRunner: ReviewRunner = {
  async check() {
    return { issues: [], ran: false }
  },
  async detectPii() {
    return { columns: [] }
  },
  async impact() {
    return { hasManifest: false, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
  },
  async equivalence() {
    return { decided: true, equivalent: true } as EquivalenceResult
  },
  async grade() {
    return { grade: "A", decided: true }
  },
}

// ─────────────────────────────────────────────────────────────
// 1. Envelope audit fields (cliVersion, staleManifest)
// ─────────────────────────────────────────────────────────────

describe("v0.9.3 release: envelope audit fields (Compliance P0/P1)", () => {
  test("cliVersion lands on engine and is covered by the signature", () => {
    const signed = signEnvelope(
      buildEnvelope({
        findings: [],
        tier: "trivial",
        mode: "comment",
        engine: { cliVersion: "0.9.3" },
        generatedAt: "2026-07-23T00:00:00Z",
      }),
      "k",
    )
    expect(signed.engine.cliVersion).toBe("0.9.3")
    expect(verifyEnvelope(signed, "k")).toBe(true)
    // A tampered version must break the signature.
    const tampered = { ...signed, engine: { ...signed.engine, cliVersion: "0.9.2" } }
    expect(verifyEnvelope(tampered, "k")).toBe(false)
  })

  test("reviewPullRequest defaults cliVersion so the dbt_pr_review tool path gets audit provenance too", async () => {
    // Regression pin for cubic-review PR #1041: only the CLI command explicitly
    // forwarded Installation.VERSION, and the dbt_pr_review tool wrapper
    // never did — so agent-invoked verdicts silently dropped engine.cliVersion
    // and defeated the audit-trail promise of the field. The fix defaults the
    // field to Installation.VERSION inside reviewPullRequest so BOTH entry
    // points get it. This test invokes reviewPullRequest WITHOUT passing
    // cliVersion and asserts the field is populated on the returned envelope.
    const tmp = await mkdtemp(path.join(os.tmpdir(), "v093-clivers-"))
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      const env = await reviewPullRequest({
        cwd: tmp,
        head: undefined,
        // opts.cliVersion INTENTIONALLY OMITTED — simulates the tool-path caller.
        changedFiles: [{ path: "models/x.sql", status: "modified", diff: "+select 1\n" }],
        getContent: async () => "select 1",
      })
      expect(env.engine.cliVersion).toBeDefined()
      expect(typeof env.engine.cliVersion).toBe("string")
      expect(env.engine.cliVersion!.length).toBeGreaterThan(0)
    } finally {
      process.stderr.write = origWrite
    }
  })

  test("staleManifest true is signed; verify fails if flipped after signing", () => {
    const signed = signEnvelope(
      buildEnvelope({
        findings: [],
        tier: "trivial",
        mode: "comment",
        staleManifest: true,
        generatedAt: "2026-07-23T00:00:00Z",
      }),
      "k",
    )
    expect(signed.staleManifest).toBe(true)
    expect(verifyEnvelope(signed, "k")).toBe(true)
    // Attempt to hide the stale signal in a stored verdict — must fail.
    const hidden = { ...signed, staleManifest: undefined }
    expect(verifyEnvelope(hidden, "k")).toBe(false)
  })

  test("staleManifest field is undefined (not false) when clean, keeping the canonical body tight", () => {
    // Same-shape invariant as tierForced — the flag is a positive marker
    // ("was the manifest stale?"). A `false` value would only add noise to
    // the signed canonical body without carrying information.
    const env = buildEnvelope({
      findings: [],
      tier: "trivial",
      mode: "comment",
      // staleManifest intentionally omitted
      generatedAt: "2026-07-23T00:00:00Z",
    })
    expect(env.staleManifest).toBeUndefined()
    // And when the caller supplies `false`, buildEnvelope maps it to undefined.
    const envFromFalse = buildEnvelope({
      findings: [],
      tier: "trivial",
      mode: "comment",
      staleManifest: false,
      generatedAt: "2026-07-23T00:00:00Z",
    })
    expect(envFromFalse.staleManifest).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────
// 2. Tier-reason PR-comment leak — DE P1, CTO P1
// ─────────────────────────────────────────────────────────────

describe("v0.9.3 release: tierReasons surfaces for full-tier runs even without --explain-tier (DE P1)", () => {
  test("full-tier natural (unforced) run emits tierReasons on the envelope", async () => {
    // A schema.yml touching `data_tests:` under models/marts/ promotes to
    // FULL tier via dbtRiskYmlChanges. Without the v0.9.3 fix, tierReasons
    // was undefined on this envelope (no --explain-tier, no --force-tier,
    // no config error) — so the customer's PR comment showed a naked
    // REQUEST_CHANGES with no reason line.
    const files: ChangedFile[] = [
      {
        path: "models/marts/schema.yml",
        status: "modified",
        diff:
          "@@\n" +
          "-  - name: customers\n" +
          "+  - name: customers\n" +
          "+    data_tests:\n" +
          "+      - not_null\n",
      },
    ]
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG } as any,
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: inertRunner,
      getContent: async (_f: string, side: "old" | "new") =>
        side === "new" ? "- name: customers\n  data_tests:\n    - not_null\n" : "- name: customers\n",
      generatedAt: "2026-07-23T00:00:00Z",
      // NOTE: explainTier is intentionally NOT set.
    })
    expect(env.tier).toBe("full")
    expect(env.tierReasons).toBeDefined()
    expect(env.tierReasons!.length).toBeGreaterThan(0)
    // The rendered PR summary now carries the "🧭 Tier: full" blockquote.
    const rendered = renderSummary(env)
    expect(rendered).toContain("Tier: full")
  })

  test("trivial / lite runs stay quiet — tierReasons undefined without --explain-tier", async () => {
    // The v0.9.3 change is scoped to `tier === "full"`. A non-full run must
    // NOT gain a reason blockquote — that would spam every approval with
    // classifier internals nobody asked for.
    const files: ChangedFile[] = [
      { path: "README.md", status: "modified", diff: "+bump docs\n" },
    ]
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG } as any,
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: inertRunner,
      getContent: async () => "bump docs",
      generatedAt: "2026-07-23T00:00:00Z",
    })
    expect(env.tier).not.toBe("full")
    expect(env.tierReasons).toBeUndefined()
    const rendered = renderSummary(env)
    expect(rendered).not.toContain("Tier: trivial")
    expect(rendered).not.toContain("Tier: lite")
  })
})

// ─────────────────────────────────────────────────────────────
// 3. Stale-manifest detection — DE P1, Compliance P1
// ─────────────────────────────────────────────────────────────

describe("v0.9.3 release: stale-manifest signal on envelope (DE/Compliance P1)", () => {
  test("working-tree review (no --head) detects staleness — the opts.head gate was removed", async () => {
    // Prior behavior: `if (opts.head) await warnIfStale(...)` — the local
    // "dbt compile once, edit for an hour, then altimate review" flow
    // silently under-warned. v0.9.3 removes the gate and mirrors the signal
    // onto the signed envelope.
    const tmp = await mkdtemp(path.join(os.tmpdir(), "v093-stale-"))
    // Fake a git repo minimally — the test uses a pre-supplied changedFiles
    // and getContent so no real git is needed.
    await mkdir(path.join(tmp, "models"), { recursive: true })
    await mkdir(path.join(tmp, "target"), { recursive: true })
    // Manifest written FIRST — the changed file gets a newer mtime below.
    const manifestPath = path.join(tmp, "target", "manifest.json")
    await writeFile(manifestPath, JSON.stringify({ metadata: { adapter_type: "duckdb" } }))
    // Backdate the manifest by 5 minutes so `stat().mtimeMs` on the source
    // file is unambiguously newer.
    const past = new Date(Date.now() - 5 * 60_000)
    await utimes(manifestPath, past, past)
    const changedFile = path.join(tmp, "models", "orders.sql")
    await writeFile(changedFile, "select 1\n")

    // Silence expected stderr warning during the test.
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      const env = await reviewPullRequest({
        cwd: tmp,
        // No head — working-tree review. Prior behavior: no staleness signal.
        head: undefined,
        manifestPath,
        changedFiles: [{ path: "models/orders.sql", status: "modified", diff: "+select 1\n" }],
        getContent: async (_f, side) => (side === "new" ? "select 1\n" : ""),
        cliVersion: "0.9.3",
      })
      expect(env.staleManifest).toBe(true)
      expect(env.engine.cliVersion).toBe("0.9.3")
      // The stale signal is now durably signed into the envelope — an
      // auditor pulling the JSON months later can distinguish a
      // stale-manifest verdict from a clean one.
      expect(verifyEnvelope(env, process.env["ALTIMATE_REVIEW_SIGNING_KEY"])).toBe(true)
    } finally {
      process.stderr.write = origWrite
    }
  })

  test("deleted manifest-affecting file trips staleness even though it can't be stat'd (cubic PR #1041)", async () => {
    // Bug caught by cubic on PR #1041: the pre-fix detectStaleManifest took
    // `changedPaths: string[]` and tried to `stat(deletedFile)` which throws
    // silently, so a deleted `models/orders.sql` reported CLEAN even though
    // the manifest still references it — a false-negative that would
    // signed-envelope-certify a verdict against ghost models. This test
    // pins the fixed semantic: a deletion of a manifest-affecting path
    // must fire the stale signal AND land on the envelope.
    const tmp = await mkdtemp(path.join(os.tmpdir(), "v093-stale-del-"))
    await mkdir(path.join(tmp, "target"), { recursive: true })
    const manifestPath = path.join(tmp, "target", "manifest.json")
    await writeFile(manifestPath, JSON.stringify({ metadata: { adapter_type: "duckdb" } }))
    // NOTE: no `models/orders.sql` on disk — it was DELETED by this diff.
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      const env = await reviewPullRequest({
        cwd: tmp,
        head: undefined,
        manifestPath,
        changedFiles: [{ path: "models/orders.sql", status: "deleted", diff: "-select 1\n" }],
        getContent: async () => "",
        cliVersion: "0.9.3",
      })
      expect(env.staleManifest).toBe(true)
    } finally {
      process.stderr.write = origWrite
    }
  })

  test("touching a non-manifest-affecting file (README.md) must NOT trip the stale signal", async () => {
    // Guard on `isManifestAffecting` — the mtime check MUST skip repo-wide
    // paths (README, package.json, .github/) or every unrelated commit
    // would spuriously flag the manifest as stale. Also serves as a
    // regression on the run-stale filter list.
    for (const rel of [
      "README.md",
      "package.json",
      ".github/workflows/ci.yml",
      "target/manifest.json",
      "target/compiled/orders.sql",
    ]) {
      expect(isManifestAffecting(rel)).toBe(false)
    }
    // And the shapes we DO care about still admit.
    for (const rel of [
      "models/marts/orders.sql",
      "models/schema.yml",
      "seeds/lookup.csv",
      "macros/gen_schema.sql",
      "dbt_project.yml",
    ]) {
      expect(isManifestAffecting(rel)).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────
// 4. Manifest auto-discovery — hostile filesystem shapes
// ─────────────────────────────────────────────────────────────

describe("v0.9.3 release: manifest auto-discovery hostile-shape resilience", () => {
  test("cwd with no dbt_project.yml anywhere upward → review runs lint-only, does not crash", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "v093-nodbt-"))
    // No dbt_project.yml, no target/manifest.json.
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      const env = await reviewPullRequest({
        cwd: tmp,
        head: undefined,
        // No manifestPath override — trigger auto-discovery.
        changedFiles: [{ path: "models/orders.sql", status: "modified", diff: "+select 1\n" }],
        getContent: async () => "select 1\n",
        cliVersion: "0.9.3",
      })
      // Runs cleanly; no findings; no crash.
      expect(env.verdict).toBeDefined()
      expect(env.engine.cliVersion).toBe("0.9.3")
      expect(env.staleManifest).toBeUndefined()
    } finally {
      process.stderr.write = origWrite
    }
  })

  test("dbt_project.yml present but no target/manifest.json → no walk-past to grandparent's compiled DAG", async () => {
    // The auto-discovery walk was hardened in PR #1027 to NOT climb into a
    // grandparent's `target/` when the current dbt project just hasn't been
    // compiled. Reviewing against the wrong project's DAG would be worse
    // than lint-only. Guard against a regression that re-introduces the
    // silent fallback.
    //
    // Fixture layout to actually exercise the walk-past guard (cubic-review
    // PR #1041 — the prior test only planted an unrelated sibling directory,
    // never a real grandparent manifest, so the walker never had one to
    // even consider skipping):
    //
    //   grand/
    //     dbt_project.yml         ← poisoned grandparent project
    //     target/manifest.json    ← poisoned grandparent manifest
    //     inner/
    //       dbt_project.yml       ← the project the reviewer should stop at
    //       (no target/manifest.json — the guarded case)
    //       subdir/               ← cwd
    const grand = await mkdtemp(path.join(os.tmpdir(), "v093-grand-"))
    await writeFile(path.join(grand, "dbt_project.yml"), "name: grand\nversion: 1.0.0\n")
    await mkdir(path.join(grand, "target"), { recursive: true })
    await writeFile(
      path.join(grand, "target", "manifest.json"),
      JSON.stringify({ metadata: { adapter_type: "duckdb" }, nodes: {} }),
    )
    const inner = path.join(grand, "inner")
    await mkdir(inner, { recursive: true })
    await writeFile(path.join(inner, "dbt_project.yml"), "name: inner\nversion: 1.0.0\n")
    const cwd = path.join(inner, "subdir")
    await mkdir(cwd, { recursive: true })

    const origWrite = process.stderr.write.bind(process.stderr)
    let stderrBuf = ""
    process.stderr.write = ((s: string) => {
      stderrBuf += String(s)
      return true
    }) as typeof process.stderr.write
    try {
      const env = await reviewPullRequest({
        cwd,
        head: undefined,
        // No --manifest → auto-discovery from cwd.
        changedFiles: [{ path: "models/x.sql", status: "modified", diff: "+select 1\n" }],
        getContent: async () => "select 1",
        cliVersion: "0.9.3",
      })
      expect(env.verdict).toBeDefined()
      // The auto-discovery must have stopped at `inner`'s dbt_project.yml
      // and refused to reach for `grand/target/manifest.json`. Silent
      // fallback to the grandparent's target/ would leave manifestHash
      // populated with someone else's DAG.
      expect(env.manifestHash).toBeUndefined()
      // And the stderr "auto-discovered dbt manifest at ..." breadcrumb
      // must NOT reference the grandparent path — a regressed walker
      // would announce a hit there.
      expect(stderrBuf).not.toContain(path.join(grand, "target", "manifest.json"))
    } finally {
      process.stderr.write = origWrite
    }
  })

  // NOTE: the "symlink loop" test that lived here previously created a
  // single-hop parent alias (`looped -> tmp`) which `fs.realpath` resolves
  // in one step — not a cycle. It therefore proved nothing about the
  // realpath try/catch fallback in run.ts and was removed rather than
  // rewritten (a real ELOOP fixture is filesystem-dependent, and the
  // realpath fallback pattern is a straight try/catch obvious from a code
  // read). Removed on cubic-review PR #1041 feedback.
})
