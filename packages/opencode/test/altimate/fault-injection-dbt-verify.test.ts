/**
 * Real dbt check of every proposed test.
 *
 * The engine verifies a proposed test with SQL on the clean and the corrupted copy of the
 * database. This test goes one step further: it takes every proposal from a real run,
 * writes it into a scratch copy of the dbt project the way a user would (merged into the
 * schema file that already describes the node, or saved as a singular test file), and runs
 * real `dbt test` on the clean database and on the corrupted copy of the fault it was
 * proposed for. It reports, as numbers:
 *
 *   - proposals                  how many faults came back with a proposed test
 *   - accepted_by_dbt            dbt parsed it and ran it (no compile/parse error)
 *   - passed_on_clean            ... and it passed on the clean database
 *   - failed_on_corrupted        ... and it failed on the corrupted copy
 *
 * Skipped unless FI_VERIFY_PROJECT names a prepared dbt-duckdb project directory (one with
 * its built `.duckdb` file and a `profiles.yml`), and dbt, the duckdb driver and an engine
 * with `FaultInjectionSession` are available (see fault-injection-e2e.test.ts). Nothing in
 * the project directory is written: everything happens in copies under FI_VERIFY_WORK
 * (default: a temporary directory), which are removed afterwards.
 *
 *   source .work-fi/env.sh   # scratch HOME: never run this against the real one
 *   FI_VERIFY_PROJECT=/path/to/project FI_VERIFY_OUT=/tmp/verify.json \
 *     bun test test/altimate/fault-injection-dbt-verify.test.ts --timeout 14400000
 *
 *   FI_VERIFY_BUDGET   faults to inject (default 1000, i.e. all candidates of a small project)
 *   FI_VERIFY_OUT      write the per-proposal results as JSON here
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import YAML from "yaml"
import {
  loadFaultInjectionEngine,
  runFaultInjection,
  type LoadedEngine,
} from "../../src/altimate/native/connections/fault-injection"
import { proposedTestYaml } from "../../src/altimate/native/connections/fault-injection-report"

const PROJECT = process.env.FI_VERIFY_PROJECT
const DBT = process.env.ALTIMATE_DBT_PATH ?? "dbt"

async function engineAvailable(): Promise<boolean> {
  try {
    await loadFaultInjectionEngine()
    return true
  } catch {
    return false
  }
}

const READY = !!PROJECT && fs.existsSync(path.join(PROJECT ?? "", "dbt_project.yml")) && (await engineAvailable())

type Json = Record<string, any>

export interface ProposalCheck {
  fault_id: string
  form: string
  test: string
  accepted_by_dbt: boolean
  passed_on_clean: boolean
  failed_on_corrupted: boolean
  clean_status?: string
  corrupted_status?: string
  note?: string
}

export interface ProposalSummary {
  proposals: number
  accepted_by_dbt: number
  passed_on_clean: number
  failed_on_corrupted: number
}

/** Merge a pasted `models:`/`sources:` block into an existing schema document, as a user would. */
export function mergeBlock(existing: Json, block: Json): Json {
  const byName = (list: Json[], name: string) => list.find((entry) => entry?.name === name)
  const mergeEntry = (target: Json, item: Json) => {
    for (const [key, value] of Object.entries(item)) {
      if (key === "name") continue
      if (key === "columns" || key === "tables") {
        const list: Json[] = (target[key] ??= [])
        for (const child of value as Json[]) {
          const found = byName(list, child.name)
          if (found) mergeEntry(found, child)
          else list.push(child)
        }
      } else if (key === "data_tests" || key === "tests") {
        // Use the key the entry already has: dbt rejects an entry that has both.
        const existingKey = "data_tests" in target ? "data_tests" : "tests" in target ? "tests" : key
        target[existingKey] = [...(target[existingKey] ?? []), ...(value as unknown[])]
      } else if (!(key in target)) {
        target[key] = value
      }
    }
  }
  for (const section of ["models", "seeds", "sources"]) {
    for (const item of (block[section] ?? []) as Json[]) {
      const list: Json[] = (existing[section] ??= [])
      const found = byName(list, item.name)
      if (found) mergeEntry(found, item)
      else list.push(item)
    }
  }
  return existing
}

/** Give the proposal's test entry a tag, so `dbt test --select tag:...` runs only that test. */
export function tagTestEntries(block: Json, tag: string): void {
  const visit = (node: Json) => {
    for (const key of ["data_tests", "tests"]) {
      if (!Array.isArray(node[key])) continue
      node[key] = node[key].map((entry: unknown) => {
        const [name, args] =
          typeof entry === "string" ? [entry, {}] : [Object.keys(entry as Json)[0], Object.values(entry as Json)[0] ?? {}]
        const config = { ...((args as Json).config ?? {}), tags: [tag, "fi_proposed"] }
        return { [name]: { ...(args as Json), config } }
      })
    }
    for (const child of [...(node.columns ?? []), ...(node.tables ?? [])]) visit(child)
  }
  for (const section of ["models", "seeds", "sources"]) for (const item of block[section] ?? []) visit(item)
}

function copyProject(from: string, to: string) {
  fs.cpSync(from, to, {
    recursive: true,
    // A symlink kept as a link would let a write into the copy reach the original.
    dereference: true,
    filter: (src) => !["target", "logs"].includes(path.basename(src)),
  })
}

describe.skipIf(!READY)("every proposed test, run by real dbt", () => {
  test(
    "proposals are accepted by dbt, pass on clean data and fail on the corrupted copy",
    async () => {
      process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
      process.env.ALTIMATE_DBT_PATH = DBT
      const root = fs.mkdtempSync(path.join(process.env.FI_VERIFY_WORK ?? os.tmpdir(), "fi-verify-"))
      const userProject = path.join(root, "user-project")
      const work = path.join(root, "work")
      const mutants = path.join(root, "mutants")
      fs.mkdirSync(work)
      fs.mkdirSync(mutants)
      copyProject(PROJECT!, userProject)
      // The clean database is the one the project's own profile names.
      const profiles = YAML.parse(fs.readFileSync(path.join(userProject, "profiles.yml"), "utf-8"))
      const ownProject = YAML.parse(fs.readFileSync(path.join(userProject, "dbt_project.yml"), "utf-8"))
      const ownProfile = profiles[ownProject.profile]
      const ownPath = String(ownProfile.outputs[ownProfile.target].path)
      const cleanDb = path.resolve(userProject, ownPath)
      expect(fs.existsSync(cleanDb)).toBe(true)
      expect(cleanDb.startsWith(userProject)).toBe(true)

      // 1. A real run. The sandbox copy of each fault is saved just before its snapshot
      //    queries: dbt has released the file by then, and it holds the corrupted producer
      //    and the rebuilt downstream models.
      const real = await loadFaultInjectionEngine()
      const savedFor = new Map<string, string>()
      const snapshotDir = (): string | undefined => {
        const dir = fs.readdirSync(work).find((d) => d.startsWith("altimate-fault-injection-"))
        return dir ? path.join(work, dir, "sandbox") : undefined
      }
      const engine: LoadedEngine = {
        ...real,
        Session: class {
          inner: InstanceType<typeof real.Session>
          constructor(spec: string) {
            this.inner = new real.Session(spec)
          }
          start() {
            return this.inner.start()
          }
          report() {
            return this.inner.report()
          }
          step(result: string) {
            const next = this.inner.step(result)
            const action = JSON.parse(next)
            if (action.type === "ExecuteSql" && action.phase === "snapshot" && action.fault_id && !savedFor.has(action.fault_id)) {
              const dir = snapshotDir()
              const file = dir ? fs.readdirSync(dir).find((f) => f.endsWith(".duckdb")) : undefined
              if (dir && file) {
                // Same file name as the original: views store the database name.
                const folder = path.join(mutants, `m${savedFor.size}`)
                fs.mkdirSync(folder)
                const copy = path.join(folder, file)
                fs.copyFileSync(path.join(dir, file), copy)
                savedFor.set(action.fault_id, copy)
              }
            }
            return next
          }
        } as never,
      }
      const run = await runFaultInjection(
        { project_dir: userProject, budget: Number(process.env.FI_VERIFY_BUDGET ?? 1000), work_dir: work },
        { loadEngine: async () => engine },
      )
      expect(run.success).toBe(true)
      const report = run.report as Json
      const nodes = (run.nodes ?? {}) as Record<string, any>
      const dbtVersion = run.dbt?.version
      const slipped = (report.slipped_through ?? []) as Json[]
      const withProposal = slipped.filter((r) => r.proposed_test)

      // 2. Write proposals into a scratch copy of the project, the way a user would.
      const projectYml = YAML.parse(fs.readFileSync(path.join(userProject, "dbt_project.yml"), "utf-8"))
      const profilesSource = YAML.parse(fs.readFileSync(path.join(userProject, "profiles.yml"), "utf-8"))
      const profile = profilesSource[projectYml.profile]
      const output = { ...profile.outputs[profile.target] }
      output.path = "{{ env_var('FI_DB') }}"
      output.threads = 1
      const profilesDir = path.join(root, "profiles")
      fs.mkdirSync(profilesDir)
      fs.writeFileSync(
        path.join(profilesDir, "profiles.yml"),
        YAML.stringify({ [projectYml.profile]: { target: profile.target, outputs: { [profile.target]: output } } }),
      )

      // Identical proposals (same node, column and test) are written once.
      const dedupe = new Map<string, number>()
      const entries: Array<{ index: number; tag: string; result: Json }> = []
      withProposal.forEach((result, i) => {
        const proposal = result.proposed_test as Json
        const key = JSON.stringify([proposal.node_id, proposal.column, proposal.form, proposal.yaml, proposal.sql])
        const shared = dedupe.get(key)
        if (shared === undefined) dedupe.set(key, i)
        entries.push({ index: i, tag: `fi_prop_${shared ?? i}`, result })
      })
      const distinct = entries.filter((e) => dedupe.get(JSON.stringify([e.result.proposed_test.node_id, e.result.proposed_test.column, e.result.proposed_test.form, e.result.proposed_test.yaml, e.result.proposed_test.sql])) === e.index)

      const writeProposals = (dir: string, items: typeof entries) => {
        const documents = new Map<string, Json>()
        for (const { index, tag, result } of items) {
          const proposal = result.proposed_test as Json
          if (proposal.form === "singular_sql") {
            const file = path.join(dir, proposal.file)
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, `{{ config(tags=['${tag}', 'fi_proposed']) }}\n${proposal.sql}`)
            continue
          }
          const block = YAML.parse(proposedTestYaml(proposal, nodes, dbtVersion)) as Json
          tagTestEntries(block, tag)
          const node = nodes[proposal.node_id] ?? {}
          const relative = (proposal.resource_section === "sources" ? node.original_file_path : node.patch_path) as string | undefined
          // A user pastes into this project's own YAML: a package's file is not theirs to edit,
          // and dbt rejects a second entry for the package's resource.
          const fromPackage = node.package_name && node.package_name !== report.project
          if (!relative || fromPackage) {
            fs.writeFileSync(path.join(dir, "models", `fi_proposed_${index}.yml`), YAML.stringify({ version: 2, ...block }))
            continue
          }
          const file = path.join(dir, relative)
          const doc = documents.get(file) ?? (fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, "utf-8")) : { version: 2 })
          documents.set(file, mergeBlock(doc ?? { version: 2 }, block))
        }
        for (const [file, doc] of documents) fs.writeFileSync(file, YAML.stringify(doc))
      }

      // 3. Real dbt.
      const dbt = (dir: string, args: string[], db: string, targetDir: string) => {
        const results = path.join(targetDir, "run_results.json")
        fs.rmSync(results, { force: true })
        const proc = spawnSync(
          DBT,
          ["--no-use-colors", ...args, "--project-dir", dir, "--profiles-dir", profilesDir, "--target-path", targetDir, "--log-path", path.join(root, "dbt-logs")],
          { encoding: "utf-8", env: { ...process.env, FI_DB: db, DBT_SEND_ANONYMOUS_USAGE_STATS: "false" }, maxBuffer: 1 << 28 },
        )
        const statuses = new Map<string, string>()
        if (fs.existsSync(results)) {
          const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, "manifest.json"), "utf-8"))
          for (const r of JSON.parse(fs.readFileSync(results, "utf-8")).results) {
            for (const tag of manifest.nodes?.[r.unique_id]?.tags ?? []) statuses.set(tag, r.status)
          }
        }
        return { code: proc.status, statuses, parsed: fs.existsSync(results), output: `${proc.stdout}\n${proc.stderr}`.slice(-600) }
      }

      // All proposals in one project first. If dbt cannot parse that (one bad proposal fails
      // the whole parse), each is tried alone so one bad proposal does not hide the others.
      const verify = path.join(root, "verify-project")
      copyProject(userProject, verify)
      writeProposals(verify, distinct)
      const cleanStatuses = new Map<string, string>()
      const projectFor = new Map<string, string>()
      const parseNotes = new Map<string, string>()
      const combined = dbt(verify, ["test", "--select", "tag:fi_proposed"], cleanDb, path.join(root, "target-clean"))
      if (combined.parsed) {
        for (const [tag, status] of combined.statuses) cleanStatuses.set(tag, status)
        for (const e of distinct) projectFor.set(e.tag, verify)
      } else {
        for (const e of distinct) {
          const alone = path.join(root, `alone-${e.index}`)
          copyProject(userProject, alone)
          writeProposals(alone, [e])
          const one = dbt(alone, ["test", "--select", "tag:fi_proposed"], cleanDb, path.join(root, `target-alone-${e.index}`))
          if (one.parsed) {
            const status = one.statuses.get(e.tag)
            if (status) cleanStatuses.set(e.tag, status)
            projectFor.set(e.tag, alone)
          } else {
            parseNotes.set(e.tag, one.output.slice(-300))
          }
        }
      }

      const checks: ProposalCheck[] = []
      for (const entry of entries) {
        const proposal = entry.result.proposed_test as Json
        const cleanStatus = cleanStatuses.get(entry.tag)
        const mutant = savedFor.get(entry.result.fault_id)
        const dir = projectFor.get(entry.tag)
        let corruptedStatus: string | undefined
        if (cleanStatus && mutant && dir) {
          corruptedStatus = dbt(dir, ["test", "--select", `tag:${entry.tag}`], mutant, path.join(root, "target-mutant")).statuses.get(entry.tag)
        }
        checks.push({
          fault_id: entry.result.fault_id as string,
          form: proposal.form ?? "schema_yaml",
          test: proposal.test as string,
          accepted_by_dbt: !!cleanStatus && !["error", "skipped"].includes(cleanStatus),
          passed_on_clean: cleanStatus === "pass",
          failed_on_corrupted: corruptedStatus === "fail",
          clean_status: cleanStatus,
          corrupted_status: corruptedStatus,
          ...(parseNotes.has(entry.tag) ? { note: `dbt rejected it: ${parseNotes.get(entry.tag)}` } : {}),
        })
      }

      const summary: ProposalSummary = {
        proposals: checks.length,
        accepted_by_dbt: checks.filter((c) => c.accepted_by_dbt).length,
        passed_on_clean: checks.filter((c) => c.passed_on_clean).length,
        failed_on_corrupted: checks.filter((c) => c.failed_on_corrupted).length,
      }
      const withheld = slipped.filter((r) => !r.proposed_test).length
      const payload = { project: report.project, slipped_through: slipped.length, withheld_with_reason: withheld, unique_proposals: dedupe.size, combined_project_parsed: combined.parsed, ...summary, checks }
      if (process.env.FI_VERIFY_OUT) fs.writeFileSync(process.env.FI_VERIFY_OUT, JSON.stringify(payload, null, 2))
      console.log(
        `[dbt-verify] ${report.project}: ${summary.proposals} proposals (${dedupe.size} distinct); dbt accepted ${summary.accepted_by_dbt}, ` +
          `passed on clean ${summary.passed_on_clean}, failed on corrupted ${summary.failed_on_corrupted}; ${withheld} slipped faults have no proposal (reason given)`,
      )
      fs.rmSync(root, { recursive: true, force: true })

      // The point of the check: nothing the report presents may be unusable, and there is something to check.
      expect(summary.proposals).toBeGreaterThan(0)
      expect(summary.accepted_by_dbt).toBe(summary.proposals)
      expect(summary.passed_on_clean).toBe(summary.proposals)
      expect(summary.failed_on_corrupted).toBe(summary.proposals)
    },
    14_400_000,
  )
})

describe("proposal YAML helpers", () => {
  test("a pasted block is merged into the entry that already describes the node", () => {
    const existing = {
      version: 2,
      models: [{ name: "orders", columns: [{ name: "id", data_tests: ["unique"] }] }],
    }
    const block = {
      models: [{ name: "orders", columns: [{ name: "id", data_tests: ["not_null"] }, { name: "amount", data_tests: ["not_null"] }] }],
    }
    expect(mergeBlock(existing, block)).toEqual({
      version: 2,
      models: [
        {
          name: "orders",
          columns: [
            { name: "id", data_tests: ["unique", "not_null"] },
            { name: "amount", data_tests: ["not_null"] },
          ],
        },
      ],
    })
  })

  test("a merged test uses the key the entry already has", () => {
    const existing = { models: [{ name: "orders", tests: ["a"] }] }
    const block = { models: [{ name: "orders", data_tests: ["b"] }] }
    expect(mergeBlock(existing, block)).toEqual({ models: [{ name: "orders", tests: ["a", "b"] }] })
  })

  test("tags select exactly one proposal", () => {
    const block: Json = {
      sources: [{ name: "app", tables: [{ name: "t", columns: [{ name: "c", data_tests: ["not_null", { "dbt_utils.accepted_range": { min_value: 0 } }] }] }] }],
    }
    tagTestEntries(block, "fi_prop_3")
    expect(block.sources[0].tables[0].columns[0].data_tests).toEqual([
      { not_null: { config: { tags: ["fi_prop_3", "fi_proposed"] } } },
      { "dbt_utils.accepted_range": { min_value: 0, config: { tags: ["fi_prop_3", "fi_proposed"] } } },
    ])
  })
})
