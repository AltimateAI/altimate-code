// altimate_change - review rules for dbt files outside the SELECT: packages.yml,
// dbt_project.yml, Jinja structure in macros/models, and model config combinations.
import path from "path"
import YAML from "yaml"
import { type Finding, type ReviewCategory, type Severity, makeFinding } from "./finding"
import { type ChangedFile, walkDiffLines, walkDiffRows } from "./diff-filter"
import { incrementalFilter, inlineConfig } from "./incremental-semantics"
import { parenBody, topLevel } from "./rule-catalog"
import { capabilityFor } from "./adapter-capabilities"

const nameOf = (p: string) => path.basename(p).replace(/\.(sql|py|ya?ml|csv)$/i, "")

function finding(
  file: ChangedFile,
  rule: string,
  severity: Severity,
  category: ReviewCategory,
  title: string,
  body: string,
  /** The raw added line the rule matched, when it matches one. */
  line?: string,
  /** What the finding is about (a ref target, a column, a macro), so two findings of one rule in one file keep distinct ids. */
  subject?: string,
): Finding {
  const model = nameOf(file.path)
  return makeFinding({
    severity,
    category,
    title: `${model}: ${title}`,
    body,
    file: file.path,
    model,
    confidence: "high",
    evidence: { tool: "dbt-project-rules", result: line === undefined ? { rule } : { rule, line } },
    ruleKey: subject ? `${category}:${rule}:${subject}` : `${category}:${rule}`,
  })
}

const addedLines = (diff: string | undefined) =>
  (diff ?? "").split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1))

/** The first added line matching `re`, for anchoring a finding to the diff. */
const addedLine = (file: ChangedFile, re: RegExp) => addedLines(file.diff).find((l) => re.test(l))
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function parseYaml(text: string | undefined): any {
  if (!text) return undefined
  try {
    return YAML.parse(text)
  } catch {
    return undefined
  }
}

// ── packages.yml ────────────────────────────────────────────────────────────

/** A release tag (`v1.2.3`, `1.2.3`, `0.9.0-b1`) or a full commit sha: both reproducible. */
const PINNED_REVISION = /^(v?\d+(\.\d+){1,2}([-.+][\w.]+)?|[0-9a-f]{40})$/i

/** packages.yml / dependencies.yml entries that track a git branch instead of a release. */
export function packagesFindings(file: ChangedFile, newContent: string | undefined): Finding[] {
  if (!/(^|\/)(packages|dependencies)\.ya?ml$/i.test(file.path) || file.status === "deleted") return []
  const doc = parseYaml(newContent)
  const pkgs: any[] = Array.isArray(doc?.packages) ? doc.packages : []
  const added = addedLines(file.diff).join("\n")
  const branchPinned = pkgs.filter(
    (p) => p && typeof p.git === "string" && (p.revision === undefined || !PINNED_REVISION.test(String(p.revision))),
  )
  // Only entries this PR touched: a long-standing branch pin is not this change's decision.
  const touched = branchPinned.filter((p) => added.includes(p.git) || (p.revision !== undefined && added.includes(String(p.revision))))
  if (!touched.length) return []
  const list = touched.map((p) => `\`${p.git}\` @ \`${p.revision ?? "default branch"}\``).join(", ")
  return [
    finding(
      file,
      "package-git-branch",
      "warning",
      "materialization",
      "package installed from a git branch",
      `${list} tracks a branch, so \`dbt deps\` installs whatever the branch holds on the day it runs. Pin a release (\`package:\` + \`version:\` range) or a tag/commit sha before merging.`,
      addedLines(file.diff).find((l) => l.includes(touched[0].git)),
    ),
  ]
}

// ── dbt_project.yml ─────────────────────────────────────────────────────────

function semverParts(v: unknown): number[] | undefined {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? ""))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined
}

function lowerVersion(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

/** Every `grants:` mapping anywhere under the given node, with its path. */
function grantsBlocks(node: any, at: string[] = [], out: { at: string; grants: Record<string, unknown> }[] = []) {
  if (!node || typeof node !== "object") return out
  for (const [k, v] of Object.entries(node)) {
    if ((k === "grants" || k === "+grants") && v && typeof v === "object" && !Array.isArray(v)) out.push({ at: [...at, k].join("."), grants: v as Record<string, unknown> })
    else grantsBlocks(v, [...at, k], out)
  }
  return out
}

export function dbtProjectFindings(file: ChangedFile, oldContent: string | undefined, newContent: string | undefined): Finding[] {
  if (!/(^|\/)dbt_project\.ya?ml$/i.test(file.path) || file.status === "deleted") return []
  const now = parseYaml(newContent)
  if (!now) return []
  const before = parseYaml(oldContent)
  const out: Finding[] = []

  const vNew = semverParts(now.version)
  const vOld = semverParts(before?.version)
  if (vNew && vOld && lowerVersion(vNew, vOld))
    out.push(
      finding(
        file,
        "project-version-lowered",
        "warning",
        "materialization",
        "project version goes down",
        `\`version\` changes from \`${before.version}\` to \`${now.version}\`. A release must move the version up, or consumers resolving a version range get the older release.`,
      ),
    )

  const oldDup = new Set(grantsBlocks(before).map((g) => g.at))
  for (const { at, grants } of grantsBlocks(now)) {
    for (const [priv, who] of Object.entries(grants)) {
      if (!Array.isArray(who)) continue
      const seen = new Set<string>()
      const dups = who.map(String).filter((r) => (seen.has(r.toLowerCase()) ? true : (seen.add(r.toLowerCase()), false)))
      if (dups.length && !(oldDup.has(at) && sameDup(before, at, priv, dups)))
        out.push(
          finding(
            file,
            "grants-duplicate",
            "suggestion",
            "sql_quality",
            `duplicate grantee under \`${at}.${priv}\``,
            `${[...new Set(dups)].map((d) => `\`${d}\``).join(", ")} is listed more than once. Usually a copy-paste where another role was meant; check the list is complete.`,
            undefined,
            `${at}.${priv}`,
          ),
        )
    }
  }

  const disabledNow = (newContent?.match(/^\s*\+?enabled\s*:\s*false\b/gim) ?? []).length
  const disabledBefore = (oldContent?.match(/^\s*\+?enabled\s*:\s*false\b/gim) ?? []).length
  if (disabledNow > disabledBefore && addedLines(file.diff).some((l) => /^\s*\+?enabled\s*:\s*false\b/i.test(l)))
    out.push(
      finding(
        file,
        "models-disabled",
        "suggestion",
        "lineage_breakage",
        "resources disabled in dbt_project.yml",
        "This change adds `enabled: false`. Disabled models drop out of the DAG: anything that refs them fails to compile and their tables stop refreshing. Say in the PR why, and whether downstream models are disabled too.",
        addedLine(file, /^\s*\+?enabled\s*:\s*false\b/i),
      ),
    )
  return out
}

function sameDup(before: any, at: string, priv: string, dups: string[]): boolean {
  const blk = grantsBlocks(before).find((g) => g.at === at)
  const who = blk?.grants[priv]
  if (!Array.isArray(who)) return false
  const lower = who.map((x) => String(x).toLowerCase())
  return dups.every((d) => lower.filter((x) => x === d.toLowerCase()).length > 1)
}

// ── Jinja structure (macros, models, tests, snapshots) ──────────────────────

const BLOCK_OPEN = ["if", "for", "macro", "call", "filter", "raw", "materialization", "test", "snapshot", "docs", "with", "block", "autoescape"]

/** Open/close balance of Jinja blocks; returns a message for the first problem, or undefined. */
export function jinjaBalance(sql: string): string | undefined {
  const text = sql.replace(/\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/g, " ").replace(/\{#[\s\S]*?#\}/g, " ")
  const stack: string[] = []
  for (const m of text.matchAll(/\{%-?\s*(\w+)([\s\S]*?)-?%\}/g)) {
    const tag = m[1].toLowerCase()
    const rest = m[2]
    if (tag === "set") {
      // `{% set x %}…{% endset %}` is a block; `{% set x = … %}` is not.
      if (!/=/.test(rest.replace(/'[^']*'|"[^"]*"/g, ""))) stack.push("set")
      continue
    }
    if (BLOCK_OPEN.includes(tag)) {
      if (tag === "macro" && !/^\s*[\w.]+\s*\(/.test(rest)) return `\`{% macro${rest.trimEnd()} %}\` has no parameter list; Jinja requires \`()\` even when empty`
      stack.push(tag)
      continue
    }
    if (tag.startsWith("end")) {
      const want = tag.slice(3)
      if (stack[stack.length - 1] === want) stack.pop()
      else if (!stack.includes(want)) return `\`{% ${tag} %}\` closes no open \`{% ${want} %}\``
      else return `\`{% ${tag} %}\` closes \`{% ${want} %}\` while \`{% ${stack[stack.length - 1]} %}\` is still open`
    }
  }
  if (stack.length) return `\`{% ${stack[stack.length - 1]} %}\` is never closed (missing \`{% end${stack[stack.length - 1]} %}\`)`
  return undefined
}

/** The first added head line inside macro `name`'s parameter list in `sql`
 *  (a multi-line signature changes on a parameter line, not the `{% macro`
 *  line), with its text; undefined when the PR added none of those lines. */
function signatureAnchor(file: ChangedFile, sql: string, name: string): { line: number; text: string } | undefined {
  const m = new RegExp(`\\{%-?\\s*macro\\s+${escapeRe(name)}\\s*\\([^)]*\\)`).exec(sql)
  if (!m) return undefined
  const first = sql.slice(0, m.index).split("\n").length
  const last = first + m[0].split("\n").length - 1
  const hit = [...walkDiffLines(file.diff)].find((r) => r.kind === "+" && r.line >= first && r.line <= last)
  return hit && { line: hit.line, text: hit.text }
}

const macroSignatures = (sql: string | undefined) => {
  const out = new Map<string, string[]>()
  for (const m of (sql ?? "").matchAll(/\{%-?\s*macro\s+([\w.]+)\s*\(([^)]*)\)/g))
    out.set(m[1], m[2].split(",").map((p) => p.split("=")[0].trim()).filter(Boolean))
  return out
}

/** Each `{% macro name(…) %}` / `{% test name(…) %}` with its parameters (name and whether it has a default)
 *  and the head line range of its signature. Defaults may hold calls and lists. */
function signatures(sql: string | undefined) {
  const out = new Map<string, { params: { name: string; hasDefault: boolean }[]; first: number; last: number; test: boolean }>()
  const text = sql ?? ""
  for (const m of text.matchAll(/\{%-?\s*(macro|test)\s+([\w.]+)\s*\(/g)) {
    const open = m.index! + m[0].length - 1
    const body = parenBody(text, open)
    const params: { name: string; hasDefault: boolean }[] = []
    let depth = 0
    let cur = ""
    for (const ch of body + ",") {
      if ("([{".includes(ch)) depth++
      else if (")]}".includes(ch)) depth--
      if (ch === "," && depth === 0) {
        const name = /^\s*(\w+)/.exec(cur)?.[1]
        if (name) params.push({ name, hasDefault: /=/.test(cur) })
        cur = ""
      } else cur += ch
    }
    const first = text.slice(0, m.index).split("\n").length
    out.set(m[2], { params, first, last: first + (m[0] + body).split("\n").length - 1, test: m[1] === "test" })
  }
  return out
}

/** The comment text on a line (`-- …`, `/* … *\/`, `{# … #}`), or "". */
const commentOf = (l: string) => /--(.*)$|\/\*(.*?)(\*\/|$)|\{#(.*?)(#\}|$)/.exec(l)?.slice(1).filter(Boolean).join(" ") ?? ""
const TEMP_MARKER =
  /\b(temp(orary)?\b.{0,40}\b(ci|test|validation|sample|debug|hack)|revert\b.{0,30}\b(to|before|after)\b|do\s+not\s+merge|remove\s+before\s+(merge|release)|ci\s+test\b|for\s+testing\s+only|take\s+(this|it)\s+out\s+(before|once|after|when)\b|\b(added|enabled|only)\s+while\s+debugging\b|(remove|delete|drop)\s+(this|it)\s+before\s+(merg|releas|deploy|prod))/i

const varNames = (sql: string | undefined) => new Set([...(sql ?? "").matchAll(/\bvar\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))

export function jinjaFindings(file: ChangedFile, oldContent: string | undefined, newContent: string | undefined): Finding[] {
  if (!newContent || file.status === "deleted" || !/\.sql$/i.test(file.path)) return []
  const out: Finding[] = []

  const problem = jinjaBalance(newContent)
  if (problem && !(oldContent && jinjaBalance(oldContent)))
    out.push(
      finding(
        file,
        "jinja-unbalanced",
        "warning",
        "sql_correctness",
        "Jinja block structure is broken",
        `${problem}. dbt fails to compile this file and every model that uses it.`,
      ),
    )

  // A parameter inserted before existing ones rebinds every positional call.
  if (oldContent) {
    const before = macroSignatures(oldContent)
    for (const [name, params] of macroSignatures(newContent)) {
      const old = before.get(name)
      if (!old || old.length === 0) continue
      const kept = old.filter((p) => params.includes(p))
      const shifted = kept.filter((p) => params.indexOf(p) !== old.indexOf(p))
      if (!shifted.length) continue
      const at = signatureAnchor(file, newContent, name)
      const f = finding(
        file,
        "macro-param-shifted",
        "warning",
        "sql_correctness",
        `\`${name}\` parameters moved position`,
        `${shifted.map((p) => `\`${p}\``).join(", ")} ${shifted.length === 1 ? "is" : "are"} no longer at the same position in \`${name}(${params.join(", ")})\`. Callers that pass arguments positionally now bind them to different parameters. Add new parameters at the end, or check every caller uses keywords.`,
        at?.text ?? addedLine(file, new RegExp(`\\bmacro\\s+${escapeRe(name)}\\s*\\(`)),
        name,
      )
      out.push(at ? { ...f, startLine: at.line, endLine: at.line } : f)
    }

    // A parameter added to an existing macro with no default: every existing caller omits it, and Jinja
    // binds an omitted parameter to Undefined, which is not `none` (an `is none` fallback never runs).
    const oldSigs = signatures(oldContent)
    for (const [name, sig] of signatures(newContent)) {
      const old = oldSigs.get(name)
      if (!old) continue
      const known = new Set(old.params.map((p) => p.name))
      for (const p of sig.params) {
        // dbt itself passes `model` / `column_name` to a generic test.
        if (p.hasDefault || known.has(p.name) || (sig.test && ["model", "column_name"].includes(p.name))) continue
        const at = [...walkDiffLines(file.diff)].find(
          (r) => r.kind === "+" && r.line >= sig.first && r.line <= sig.last && new RegExp(`\\b${p.name}\\b`).test(r.text),
        )
        if (!at) continue
        const f = finding(
          file,
          "macro-param-no-default",
          "warning",
          "sql_correctness",
          `new parameter \`${p.name}\` of \`${name}\` has no default`,
          `\`${p.name}\` was added to the existing ${sig.test ? "test" : "macro"} \`${name}\` without a default. Every call written before this change omits it, and Jinja passes an omitted parameter as Undefined, not \`none\`: an \`is none\` fallback is skipped and the value renders as an empty string. Give it a default (\`${p.name}=none\`) unless every caller is updated in this change.`,
          at.text,
        )
        out.push({ ...f, startLine: at.line, endLine: at.line })
      }
    }

    // A var() key renamed with no fallback: projects that set the old key lose their override silently.
    const oldVars = varNames(oldContent)
    const newVars = varNames(newContent)
    // A key still named as a string literal is usually still read (handed to a macro that reads it).
    const gone = [...oldVars].filter((v) => !newVars.has(v) && !new RegExp(`['"]${v}['"]`).test(newContent))
    const added = [...newVars].filter((v) => !oldVars.has(v))
    // A rename, not an unrelated removal plus addition: some new line reads the new key where an
    // old line, otherwise identical, read the old one.
    const oldLines = new Set(oldContent.split("\n").map((l) => l.trim()))
    const newLines = newContent.split("\n").map((l) => l.trim())
    const renamedFrom = (f: string) => gone.find((g) => newLines.some((l) => l.includes(f) && oldLines.has(l.split(f).join(g))))
    const fresh = added.filter((f) => renamedFrom(f))
    const from = [...new Set(fresh.map((f) => renamedFrom(f)!))]
    if (fresh.length)
      out.push(
        finding(
          file,
          "var-renamed-no-fallback",
          "warning",
          "semantic_change",
          "var() key renamed without a fallback",
          `This file no longer reads ${from.map((v) => `\`${v}\``).join(", ")} and now reads ${fresh.map((v) => `\`${v}\``).join(", ")}. Projects that set the old key in \`dbt_project.yml\` keep running with the default and no error. Read the new key with the old one as its default, e.g. \`var('${fresh[0]}', var('${renamedFrom(fresh[0])}', <default>))\`.`,
        ),
      )
  }

  // Code marked as temporary in its own comment: a CI sample, a test date, a "revert before merge".
  const marker = addedLines(file.diff).find((l) => TEMP_MARKER.test(commentOf(l)))
  if (marker)
    out.push(
      finding(
        file,
        "temporary-code-marker",
        "warning",
        "sql_correctness",
        "code marked temporary is part of the change",
        `\`${marker.trim().slice(0, 160)}\` says it is temporary. If this merges, the temporary filter, date or sample ships to production. Revert it, or drop the comment if it is meant to stay.`,
        marker,
      ),
    )

  const utcnow = addedLine(file, /modules\.datetime\.datetime\.utcnow\s*\(/)
  if (utcnow !== undefined)
    out.push(
      finding(
        file,
        "jinja-utcnow",
        "suggestion",
        "idempotency",
        "`datetime.utcnow()` returns a naive timestamp",
        "`utcnow()` is deprecated since Python 3.12 and returns a timestamp with no timezone, which compares wrongly against aware ones. Use `modules.datetime.datetime.now(modules.datetime.timezone.utc)`.",
        utcnow,
      ),
    )
  return out
}

// ── YAML structure ──────────────────────────────────────────────────────────

/** The first YAML error in `text` (all documents), with its 1-based line; undefined when it parses. */
export function yamlError(text: string): { message: string; line?: number; duplicate: boolean } | undefined {
  for (const doc of YAML.parseAllDocuments(text)) {
    const e = doc.errors?.[0]
    if (e) return { message: e.message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, ""), line: e.linePos?.[0]?.line, duplicate: e.code === "DUPLICATE_KEY" }
  }
  return undefined
}

/** A YAML file that parsed at base and no longer parses at head (a mis-indented key often
 *  becomes a duplicate key of the entry above it). */
export function yamlParseFindings(file: ChangedFile, oldContent: string | undefined, newContent: string | undefined): Finding[] {
  if (!/\.ya?ml$/i.test(file.path) || file.status === "deleted" || !newContent) return []
  const err = yamlError(newContent)
  if (!err || (oldContent !== undefined && yamlError(oldContent))) return []
  const text = err.line ? newContent.split("\n")[err.line - 1] : undefined
  const f = finding(
    file,
    "yaml-parse-error",
    "warning",
    "sql_correctness",
    err.duplicate ? "YAML key defined twice" : "file no longer parses as YAML",
    err.duplicate
      ? `${err.message}${err.line ? ` (line ${err.line})` : ""}. A key indented one level too deep becomes a second entry of the mapping above it; parsers either reject the file or keep only one value. Check the indentation of the keys added here.`
      : `${err.message}${err.line ? ` (line ${err.line})` : ""}. The file parsed before this change; tools that read it now fail.`,
    text,
  )
  return [err.line ? { ...f, startLine: err.line, endLine: err.line } : f]
}

/** New models named like the public models a `.quickstart/quickstart.yml` lists, but missing from
 *  its `public_models`: the quickstart setup won't expose them. */
export function quickstartModelFindings(
  /** Where the finding goes: the quickstart file when the PR changes it, else the new model. */
  target: ChangedFile,
  quickstartPath: string,
  content: string | undefined,
  newModels: string[],
): Finding[] {
  const doc = parseYaml(content)
  const listed: string[] = Array.isArray(doc?.public_models) ? doc.public_models.filter((x: unknown) => typeof x === "string") : []
  if (listed.length < 3) return []
  // The package prefix (`hubspot__…`) most public models share.
  const counts = new Map<string, number>()
  for (const m of listed) {
    const p = /^([a-z0-9_]+?)__/i.exec(m)?.[1]
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  const [prefix, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0]
  if (!prefix || n < listed.length * 0.8) return []
  const have = new Set(listed.map((m) => m.toLowerCase()))
  const missing = newModels.filter((m) => m.toLowerCase().startsWith(`${prefix.toLowerCase()}__`) && !have.has(m.toLowerCase()))
  if (!missing.length) return []
  return [
    finding(
      target,
      "quickstart-public-model-missing",
      "suggestion",
      "materialization",
      `new model${missing.length === 1 ? "" : "s"} missing from \`public_models\``,
      `${missing.map((m) => `\`${m}\``).join(", ")} ${missing.length === 1 ? "is" : "are"} new and named like the ${listed.length} models \`${quickstartPath}\` lists in \`public_models\`, but ${missing.length === 1 ? "isn't" : "aren't"} listed. Add ${missing.length === 1 ? "it" : "them"}, or confirm ${missing.length === 1 ? "it is" : "they are"} meant to stay internal.`,
    ),
  ]
}

// ── singular test windows ───────────────────────────────────────────────────

const UNIT_SECONDS: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, quarter: 7776000, year: 31536000 }
const UNIT = "(second|minute|hour|day|week|month|quarter|year)s?"
// `interval 1 day`, `interval '1' day`, `interval '30 minutes'`, `dateadd('day', -3, …)` / `dbt.dateadd(datepart='day', interval=-3, …)`.
const WINDOW_RES = [
  new RegExp(`\\binterval\\s+'?\\s*(\\d+)\\s*'?\\s*'?${UNIT}\\b'?`, "gi"),
  new RegExp(`\\bdate_?add\\s*\\(\\s*(?:datepart\\s*=\\s*)?['"]?${UNIT}['"]?\\s*,\\s*(?:interval\\s*=\\s*)?-\\s*(\\d+)`, "gi"),
]

/** Window lengths on a line in seconds, and the line with every window masked (for pairing edits). */
function windows(line: string): { secs: number[]; shape: string } {
  const secs: number[] = []
  let shape = line.replace(/--.*$/, "")
  WINDOW_RES.forEach((re, i) => {
    shape = shape.replace(re, (_m, a: string, b: string) => {
      const [n, unit] = i === 0 ? [a, b] : [b, a]
      secs.push(Number(n) * UNIT_SECONDS[unit.toLowerCase()])
      return "<window>"
    })
  })
  return { secs, shape: shape.replace(/\s+/g, " ").trim().toLowerCase() }
}

/** A singular test whose lookback window literal got shorter: it now checks less data. */
export function testWindowFindings(file: ChangedFile): Finding[] {
  if (file.status !== "modified" || !/\.sql$/i.test(file.path)) return []
  const rows = [...walkDiffRows(file.diff)]
  const removed = rows.filter((r) => r.kind === "-").map((r) => windows(r.text)).filter((w) => w.secs.length)
  if (!removed.length) return []
  for (const r of rows) {
    if (r.kind !== "+") continue
    const now = windows(r.text)
    if (!now.secs.length) continue
    const was = removed.find((w) => w.shape === now.shape && w.secs.length === now.secs.length)
    const shrunk = was && now.secs.some((s, i) => s < was.secs[i])
    if (!was || !shrunk) continue
    const fmt = (s: number) => {
      const [u, n] = Object.entries(UNIT_SECONDS).reverse().find(([, n]) => s % n === 0 && s >= n) ?? ["second", 1]
      return `${s / n} ${u}${s / n === 1 ? "" : "s"}`
    }
    const i = now.secs.findIndex((s, k) => s < was.secs[k])
    const f = finding(
      file,
      "test-window-shrunk",
      "suggestion",
      "test_coverage",
      "test lookback window got shorter",
      `The window this test checks shrank from ${fmt(was.secs[i])} to ${fmt(now.secs[i])}, so rows outside the new window are no longer tested. If the test now runs on that schedule, say so; otherwise keep the longer window.`,
      r.text,
    )
    return [{ ...f, startLine: r.line, endLine: r.line }]
  }
  return []
}

// ── adapter.dispatch variants ───────────────────────────────────────────────

/** `adapter.dispatch('name', …)(…)` calls whose argument list carries `kw=` keywords on added
 *  lines: the dispatched macro name, and each such keyword with the raw added line. */
export function addedDispatchKwargs(file: ChangedFile, sql: string): { name: string; kwargs: { kw: string; line: number; text: string }[] }[] {
  const added = [...walkDiffLines(file.diff)].filter((r) => r.kind === "+")
  const lineAt = (i: number) => sql.slice(0, i).split("\n").length
  const out: { name: string; kwargs: { kw: string; line: number; text: string }[] }[] = []
  for (const m of sql.matchAll(/\badapter\.dispatch\s*\(\s*['"]([\w.]+)['"]/g)) {
    const open = m.index! + m[0].indexOf("(")
    const head = parenBody(sql, open)
    const after = open + head.length + 2
    const call = /^\s*\(/.exec(sql.slice(after))
    if (!call) continue
    const argsOpen = after + call[0].length - 1
    const args = parenBody(sql, argsOpen)
    const first = lineAt(argsOpen)
    const last = first + args.split("\n").length - 1
    const kws = [...topLevel(args).matchAll(/(?:^|,)\s*(\w+)\s*=(?!=)/g)].map((k) => k[1])
    const kwargs = kws.flatMap((kw) => {
      const hit = added.find((r) => r.line >= first && r.line <= last && new RegExp(`\\b${kw}\\s*=(?!=)`).test(r.text))
      return hit ? [{ kw, line: hit.line, text: hit.text }] : []
    })
    if (kwargs.length) out.push({ name: m[1].split(".").pop()!, kwargs })
  }
  return out
}

/** Every `{% macro <prefix>__<name>(…) %}` in `text`: its parameters, and whether its body reads
 *  `kwargs` (Jinja then accepts any extra keyword). */
export function dispatchVariants(text: string, name: string): { macro: string; params: string[]; acceptsKwargs: boolean }[] {
  const out: { macro: string; params: string[]; acceptsKwargs: boolean }[] = []
  for (const [macro, sig] of signatures(text)) {
    if (!macro.endsWith(`__${name}`) || macro === name) continue
    const at = new RegExp(`\\{%-?\\s*macro\\s+${escapeRe(macro)}\\s*\\(`).exec(text)!.index
    const end = text.slice(at).search(/\{%-?\s*endmacro\b/)
    const body = text.slice(at, end < 0 ? undefined : at + end)
    out.push({ macro, params: sig.params.map((p) => p.name), acceptsKwargs: /\bkwargs\b/.test(body) || /\bvarargs\b/.test(body) })
  }
  return out
}

/** Keywords a changed `adapter.dispatch` call now passes that an in-repo variant does not take:
 *  on that adapter dbt fails with "takes no keyword argument". */
export function dispatchKwargFindings(
  file: ChangedFile,
  sql: string,
  variantsOf: (name: string) => { macro: string; params: string[]; acceptsKwargs: boolean }[],
): Finding[] {
  const out: Finding[] = []
  for (const call of addedDispatchKwargs(file, sql)) {
    const variants = variantsOf(call.name)
    for (const { kw, line, text } of call.kwargs) {
      const missing = variants.filter((v) => !v.acceptsKwargs && !v.params.includes(kw)).map((v) => v.macro)
      if (!missing.length) continue
      const f = finding(
        file,
        "dispatch-kwarg-not-in-variant",
        "warning",
        "sql_correctness",
        `\`${call.name}\` now passes \`${kw}\`, which ${missing.length === 1 ? "a variant doesn't" : "some variants don't"} accept`,
        `The \`adapter.dispatch('${call.name}')\` call passes \`${kw}=\`, but ${missing.map((v) => `\`${v}\``).join(", ")} ${missing.length === 1 ? "has" : "have"} no \`${kw}\` parameter. On ${missing.length === 1 ? "that adapter" : "those adapters"} dbt fails with "takes no keyword argument '${kw}'". Add the parameter (with a default) to every variant.`,
        text,
      )
      out.push({ ...f, startLine: line, endLine: line })
    }
  }
  return out
}

// ── model config combinations ───────────────────────────────────────────────

const unquote = (v: string | undefined) => (v ?? "").trim().replace(/^['"]|['"]$/g, "")
const literals = (v: string | undefined) => [...(v ?? "").matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1].toLowerCase())

/** Partition column names from a `partition_by` config value (BigQuery dict, list, or string). */
function partitionColumns(v: string | undefined): string[] {
  if (!v) return []
  const field = /['"]field['"]\s*:\s*['"]([^'"]+)['"]/i.exec(v)
  if (field) return [field[1].toLowerCase()]
  return literals(v)
}

/** Literals a config value can take: its own, or those of the `{% set name = … %}` it names. */
function valueLiterals(v: string | undefined, sql: string): string[] {
  const own = literals(v)
  if (own.length || !v || !/^\s*\w+\s*$/.test(v)) return own
  const set = new RegExp(`\\{%-?\\s*set\\s+${v.trim()}\\s*=([^%]*)%\\}`).exec(sql)
  return set ? literals(set[1]) : []
}

export function modelConfigFindings(
  file: ChangedFile,
  newSql: string | undefined,
  dialect: string,
  /** The manifest's config for the model: fills what the file leaves to project defaults. */
  manifestConfig?: Record<string, unknown>,
  /** False when `dialect` is a default guess, not read from config or the manifest. */
  dialectKnown = true,
): Finding[] {
  if (!newSql || file.status === "deleted") return []
  const cfg = inlineConfig(newSql)
  const touched = addedLines(file.diff).join("\n")
  // Only when the config or the incremental filter is part of this change.
  if (!/config\s*\(|unique_key|partition_by|batch_size|materialized|incremental|is_incremental/i.test(touched)) return []
  const out: Finding[] = []
  const materialized = (unquote(cfg.materialized) || String(manifestConfig?.materialized ?? "")).toLowerCase()
  const strategy = unquote(cfg.incremental_strategy).toLowerCase()

  if (cfg.unique_key && (materialized === "table" || materialized === "view"))
    out.push(
      finding(
        file,
        "unique-key-not-incremental",
        "suggestion",
        "materialization",
        `\`unique_key\` has no effect on a ${materialized}`,
        `\`unique_key\` only drives incremental merges; on a \`${materialized}\` it neither deduplicates nor checks anything. Add a \`unique\` / \`unique_combination_of_columns\` test to enforce it.`,
        addedLine(file, /\bunique_key\b/),
      ),
    )

  // dbt-bigquery requires microbatch `batch_size` to equal the partition granularity.
  // On a known adapter its capability decides; otherwise a `partition_by` dict with
  // `granularity` (BigQuery's syntax) identifies the adapter.
  const cap = dialectKnown ? capabilityFor(dialect) : undefined
  const batchMustMatchPartition = cap
    ? !!cap.microbatchBatchSizeMatchesPartition
    : /bigquery/i.test(dialect) || /['"]granularity['"]\s*:/.test(cfg.partition_by ?? "")
  if (strategy === "microbatch" && batchMustMatchPartition) {
    const sizes = valueLiterals(cfg.batch_size, newSql).filter((s) => ["hour", "day", "month", "year"].includes(s))
    const gran = /['"]granularity['"]\s*:\s*['"](\w+)['"]/i.exec(cfg.partition_by ?? "")?.[1]?.toLowerCase() ?? (cfg.partition_by ? "day" : undefined)
    const off = gran ? sizes.filter((s) => s !== gran) : []
    if (off.length)
      out.push(
        finding(
          file,
          "microbatch-granularity-mismatch",
          "warning",
          "materialization",
          "microbatch `batch_size` differs from the partition granularity",
          `\`batch_size\` can be ${off.map((s) => `\`${s}\``).join(", ")} but \`partition_by\` granularity is \`${gran}\`. dbt-bigquery rejects a microbatch model whose batch size and partition granularity differ, so those runs fail before executing.`,
          addedLine(file, /\bbatch_size\b/) ?? addedLine(file, /\bgranularity\b|\bpartition_by\b/),
        ),
      )
  }

  if (materialized === "incremental") {
    const parts = partitionColumns(cfg.partition_by)
    const uk = literals(cfg.unique_key).length ? literals(cfg.unique_key) : cfg.unique_key ? [unquote(cfg.unique_key).toLowerCase()] : []
    if (parts.length && uk.length && strategy === "merge" && !/bigquery/i.test(dialect)) {
      const missing = parts.filter((p) => !uk.includes(p))
      if (missing.length)
        out.push(
          finding(
            file,
            "partition-not-in-merge-key",
            "suggestion",
            "warehouse_cost",
            "partition column is not in the merge `unique_key`",
            `The table is partitioned by ${missing.map((p) => `\`${p}\``).join(", ")}, which \`unique_key\` [${uk.join(", ")}] doesn't include, so the merge can't prune target partitions and scans the whole table. Add the partition column to \`unique_key\` (or \`incremental_predicates\`).`,
            addedLine(file, /\bunique_key\b/) ?? addedLine(file, /\bpartition_by\b/),
          ),
        )
    }
    // The incremental filter should constrain the partition column, or each run scans every partition.
    const filter = incrementalFilter(newSql)
    if (parts.length && filter && !parts.some((p) => new RegExp(`\\b${p}\\b`, "i").test(filter)))
      out.push(
        finding(
          file,
          "incremental-filter-not-partition",
          "suggestion",
          "warehouse_cost",
          "incremental filter doesn't use the partition column",
          `The \`is_incremental()\` filter never constrains ${parts.map((p) => `\`${p}\``).join(", ")}, the partition column, so each run reads every partition of the source/target. Filter on the partition column (alone or alongside the timestamp).`,
        ),
      )
    // Filtering on a creation timestamp misses updates to rows created earlier.
    // Rows are expected to change when the model carries an update timestamp or merges on a key.
    const rowsChange = /\b\w*(updated|modified|changed)(_at|_on|_date|_ts|_time)\b/i.test(newSql) || (uk.length > 0 && strategy !== "append")
    const created = filter && /\b\w*(created|inserted)(_at|_on|_date|_ts|_time)\b/i.exec(filter)?.[0]
    if (filter && created && !/\b\w*(updated|modified|changed)\w*\b/i.test(filter) && rowsChange)
      out.push(
        finding(
          file,
          "incremental-filter-created-only",
          "suggestion",
          "materialization",
          "incremental filter reads new rows only, not updated ones",
          `The \`is_incremental()\` filter keys on a creation timestamp while ${/\b\w*(updated|modified|changed)(_at|_on|_date|_ts|_time)\b/i.test(newSql) ? "the model also carries an update timestamp" : "the model merges on \`unique_key\`, so existing rows are expected to change"}. Rows created before the last run and changed since are never picked up again. Filter on the update timestamp, or explain why rows never change.`,
          // The first added line that compares the creation timestamp. `filter` is
          // tokenised, so the raw line is matched on the column and a comparison.
          addedLines(file.diff).find((l) => new RegExp(`\\b${created}\\b`, "i").test(l) && /[<>]=?|\bbetween\b/i.test(l)),
        ),
      )
  }
  return out
}

// ── ref() targets ───────────────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[b.length]
}

/** Single-argument `ref('x')` on added lines whose target no resource carries. */
export function missingRefFindings(file: ChangedFile, names: Set<string>): Finding[] {
  const refs = new Map<string, string>()
  for (const l of addedLines(file.diff))
    for (const m of l.matchAll(/\bref\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*v(?:ersion)?\s*=\s*[^)]*)?\)/g))
      if (!refs.has(m[1])) refs.set(m[1], l)
  // Versioned models live in `<name>_v1.sql`, `<name>_v2.sql`; `ref('<name>')` resolves to one of them.
  const known = new Set(names)
  for (const n of names) known.add(n.replace(/_v\d+$/, ""))
  const missing = [...refs.keys()].filter((r) => !known.has(r.toLowerCase()) && !known.has(r.toLowerCase().replace(/_v\d+$/, "")))
  return missing.map((r) => {
    const near = [...names].filter((n) => Math.abs(n.length - r.length) <= 2 && editDistance(n, r.toLowerCase()) <= 2)
    return finding(
      file,
      "ref-target-missing",
      "warning",
      "sql_correctness",
      `\`ref('${r}')\` points at no model`,
      `No model, seed or snapshot named \`${r}\` exists in this project or its installed packages, so dbt fails to parse the project.${near.length ? ` Did you mean ${near.slice(0, 3).map((n) => `\`${n}\``).join(", ")}?` : " Add the model in this PR or fix the name."}`,
      refs.get(r),
      r.toLowerCase(),
    )
  })
}

// ── join keys vs declared uniqueness ────────────────────────────────────────

export interface JoinTarget {
  /** The model the joined relation reads (directly, or through a pass-through CTE). */
  model: string
  /** Columns of the joined side compared with `=` in the ON clause. */
  keys: string[]
  /** The JOIN text, for the finding. */
  join: string
  /** LEFT [OUTER] JOIN: a lookup that should keep each left row once. */
  left: boolean
}

const REF = /\{\{\s*ref\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/

/** CTEs that pass one ref through unchanged in grain (no GROUP BY / DISTINCT / JOIN / QUALIFY / UNION). */
function passThroughCtes(sql: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of sql.matchAll(/(?:\bwith\b|,)\s*(\w+)\s+as\s*\(/gi)) {
    const body = parenBody(sql, m.index! + m[0].length - 1)
    const top = topLevel(body)
    const ref = REF.exec(body)
    // `{{ ref(...) }}` sits in parens that topLevel blanks, so test grain-changing keywords on the top level.
    if (ref && /\bfrom\b/i.test(top) && !/\b(group\s+by|distinct|join|qualify|union|limit)\b/i.test(top)) out.set(m[1].toLowerCase(), ref[1])
  }
  return out
}

const ON_STOP = /^(?:join|left|right|inner|full|cross|where|group|order|qualify|having|union|limit|window|select|\{%)\b/i

/** The top-level `and`-separated conditions of an ON clause. */
function conjuncts(on: string): string[] {
  const top = topLevel(on)
  const out: string[] = []
  let from = 0
  for (const m of top.matchAll(/\band\b/gi)) {
    out.push(on.slice(from, m.index))
    from = m.index! + m[0].length
  }
  out.push(on.slice(from))
  return out
}

/** Joins whose ON clause or JOIN line is on an added line, with the joined model and its key columns. */
export function joinTargets(sql: string, added: string[]): JoinTarget[] {
  const ctes = passThroughCtes(sql)
  const changed = added.map((l) => l.replace(/--.*$/, "").trim()).filter((l) => /\w{2}/.test(l))
  const out: JoinTarget[] = []
  const re = /\b(left\s+(?:outer\s+)?)?join\s+(\{\{\s*ref\(\s*['"][^'"]+['"]\s*\)\s*\}\}|\w+)\s*(?:as\s+)?(\w+)?\s+on\b/gi
  for (const m of sql.matchAll(re)) {
    const rel = m[2]
    const alias = (m[3] && !/^on$/i.test(m[3]) ? m[3] : (REF.exec(rel)?.[1] ?? rel)).toLowerCase()
    const model = REF.exec(rel)?.[1] ?? ctes.get(rel.toLowerCase())
    if (!model) continue
    // ON clause: up to the next clause keyword at paren depth 0.
    let i = m.index! + m[0].length
    let depth = 0
    const start = i
    for (; i < sql.length; i++) {
      const c = sql[i]
      if (c === "(") depth++
      else if (c === ")") {
        if (depth === 0) break
        depth--
      } else if (depth === 0 && /\s/.test(sql[i - 1] ?? " ") && ON_STOP.test(sql.slice(i, i + 10))) break
    }
    const on = sql.slice(start, i)
    const text = sql.slice(sql.lastIndexOf("\n", m.index!) + 1, i)
    if (!changed.some((l) => text.includes(l))) continue
    // Range conditions (`between`, `<`) and Jinja-generated conditions constrain the join
    // in ways the equality keys don't show.
    if (/\{\{|\bbetween\b|<|>|!=|\bor\b/i.test(on)) continue
    const keys = new Set<string>()
    for (const conjunct of conjuncts(on)) {
      const eq = conjunct.split("=")
      if (eq.length !== 2) continue
      for (const side of eq) {
        // `alias.col`, also inside a wrapper: `cast(alias.col as varchar)`, `lower(alias.col)`.
        const cols = [...side.matchAll(/\b(\w+)\.(\w+)\b/g)].filter((c) => c[1].toLowerCase() === alias)
        if (cols.length === 1) keys.add(cols[0][2].toLowerCase())
      }
    }
    if (keys.size)
      out.push({ model, keys: [...keys], join: text.replace(/\s+/g, " ").trim().slice(0, 160), left: !!m[1] })
  }
  return out
}

// ── tests on columns the SQL sets to NULL ───────────────────────────────────

/** Columns the final SELECT projects as a bare NULL (`null as c`, `cast(null as t) as c`, `null::t as c`).
 *  Empty when the model has a UNION: another branch may fill the column. A NULL set in a CTE is
 *  not counted, since a later layer may still populate the column. */
export function literalNullColumns(sql: string): Set<string> {
  const s = sql.replace(/--[^\n]*/g, " ").replace(/\{#[\s\S]*?#\}/g, " ")
  const out = new Set<string>()
  if (/\bunion\b/i.test(s)) return out
  const top = topLevel(s)
  const selects = [...top.matchAll(/\bselect\b/gi)]
  if (!selects.length) return out
  const start = selects[selects.length - 1].index!
  const from = /\bfrom\b/i.exec(top.slice(start))
  const projection = s.slice(start, from ? start + from.index : undefined)
  for (const m of projection.matchAll(/(?:^|[,(\s])(?:null(?:\s*::\s*\w+(?:\([^)]*\))?)?|cast\s*\(\s*null\s+as\s+[^)]*\))\s+as\s+["`]?(\w+)/gi)) out.add(m[1].toLowerCase())
  return out
}

const testNames = (tests: unknown): string[] =>
  Array.isArray(tests) ? tests.map((t) => (typeof t === "string" ? t : t && typeof t === "object" ? Object.keys(t)[0] : "")).filter(Boolean) : []

/** Head-side line numbers of a diff's added lines; undefined when the diff has no hunk headers. */
function addedLineNumbers(diff: string | undefined): Set<number> | undefined {
  const out = new Set<number>()
  let right = 0
  let inHunk = false
  for (const line of (diff ?? "").split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      right = Number(h[1])
      inHunk = true
    } else if (!inHunk || line.startsWith("-") || line.startsWith("\\")) continue
    else if (line.startsWith("+")) out.add(right++)
    else right++
  }
  return inHunk ? out : undefined
}

/** Whether this diff added a line inside the YAML node spanning `range` (character offsets into `text`). */
function addedWithin(text: string, range: [number, number], diff: string | undefined): boolean {
  const lines = addedLineNumbers(diff)
  if (lines) {
    const lineOf = (offset: number) => text.slice(0, offset).split("\n").length
    const [from, to] = [lineOf(range[0]), lineOf(Math.max(range[0], range[1] - 1))]
    for (const n of lines) if (n >= from && n <= to) return true
    return false
  }
  // No hunk headers: match added lines against the node's own text.
  const block = new Set(text.slice(range[0], range[1]).split("\n").map((l) => l.trim()).filter(Boolean))
  return addedLines(diff).some((l) => block.has(l.trim()))
}

/** not_null tests, added in this diff, on a column the model always sets to NULL. `relationships`
 *  is not flagged: dbt's relationships test skips NULL keys, so it passes on an all-NULL column. */
export function testsOnNullColumns(file: ChangedFile, ymlContent: string | undefined, sqlByModel: Map<string, string>): Finding[] {
  const doc = parseYaml(ymlContent)
  if (!ymlContent || !Array.isArray(doc?.models)) return []
  const ydoc = YAML.parseDocument(ymlContent)
  const out: Finding[] = []
  doc.models.forEach((m: any, i: number) => {
    const sql = m?.name && sqlByModel.get(String(m.name).toLowerCase())
    if (!sql || !Array.isArray(m.columns)) return
    const nulls = literalNullColumns(sql)
    m.columns.forEach((c: any, j: number) => {
      const col = String(c?.name ?? "").toLowerCase()
      if (!nulls.has(col)) return
      const failing = [...testNames(c.data_tests), ...testNames(c.tests)].filter((t) => /(^|\.)not_null$/.test(t))
      const node = ydoc.getIn(["models", i, "columns", j], true) as { range?: [number, number, number] } | undefined
      if (!failing.length || !node?.range || !addedWithin(ymlContent, [node.range[0], node.range[1]], file.diff)) return
      out.push(
        finding(
          file,
          "test-on-null-column",
          "warning",
          "test_coverage",
          `\`${m.name}.${c.name}\` is tested but the model sets it to NULL`,
          `\`${m.name}\` selects \`${c.name}\` as a literal NULL, so its ${failing.map((t) => `\`${t}\``).join(" / ")} test fails on every row. Drop the test until the column is populated, or populate it.`,
          addedLine(file, new RegExp(`\\b${escapeRe(col)}\\b`, "i")) ?? addedLine(file, /not_null/),
          `${m.name}.${c.name}`,
        ),
      )
    })
  })
  return out
}
