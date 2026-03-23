/**
 * Trace viewer HTML renderer.
 *
 * Generates a self-contained HTML page with 5 visualization modes:
 *   1. Summary — shareable recap with narrative, metrics, and charts (default)
 *   2. Waterfall — Gantt-style timeline bars (Datadog/Jaeger-style)
 *   3. Tree — nested indentation with expandable detail (Langfuse-style)
 *   4. Chat — conversation flow with user/agent messages (LangSmith-style)
 *   5. Log — flat scrollable list, Ctrl+F searchable (Langfuse Log View)
 *
 * All modes share a common summary header with metrics cards.
 * Branded with Altimate Recap colors. Includes share/export features for virality.
 */

import type { TraceFile } from "./tracing"

export function renderTraceViewer(trace: TraceFile, options?: { live?: boolean; apiPath?: string }): string {
  const traceJSON = JSON.stringify(trace).replace(/<\//g, "<\\/")
  const apiPath = options?.apiPath ?? "/api/trace"
  const live = options?.live ?? false

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Altimate Recap</title>
<style>
:root {
  --bg: #0c1222; --s1: #131c30; --s2: #1a2540; --s3: #223050;
  --border: #2a3a5c; --border-a: #3a4f7a;
  --text: #e8edf5; --dim: #7a8ba8; --muted: #4a5f80;
  --primary: #4d8eff; --accent: #6c9fff; --secondary: #3b7dd8;
  --green: #4ade80; --red: #f87171; --orange: #fbbf24; --cyan: #22d3ee; --yellow: #facc15;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.5; }

/* Header */
.hdr { padding: 16px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.logo { display: flex; align-items: center; gap: 10px; }
.logo-mark { width: 28px; height: 28px; background: linear-gradient(135deg, var(--primary), var(--accent)); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 16px; color: var(--bg); }
.logo-text { font-size: 18px; font-weight: 700; }
.logo-text span { color: var(--primary); }
.tags { display: flex; gap: 8px; flex-wrap: wrap; }
.tag { background: var(--s1); border: 1px solid var(--border); padding: 2px 10px; border-radius: 12px; font-size: 12px; color: var(--dim); }
.tag strong { color: var(--text); }

/* Toolbar */
.toolbar { display: flex; gap: 8px; padding: 12px 24px; border-bottom: 1px solid var(--border); background: var(--s1); align-items: center; }
.toolbar-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--s2); color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
.toolbar-btn:hover { border-color: var(--primary); background: var(--s3); }
.toolbar-btn.primary { background: var(--primary); border-color: var(--primary); color: var(--bg); font-weight: 600; }
.toolbar-btn.primary:hover { background: var(--accent); }
.toolbar-spacer { flex: 1; }
.toolbar-toast { font-size: 12px; color: var(--green); opacity: 0; transition: opacity 0.3s; }
.toolbar-toast.show { opacity: 1; }

/* Prompt */
.prompt-box { background: var(--s1); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin: 16px 24px; }
.prompt-box .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); margin-bottom: 4px; }

/* Summary cards */
.cards { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 24px 16px; }
.card { background: var(--s1); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; min-width: 110px; }
.card .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); }
.card .val { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }

/* Mode tabs */
.tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 24px; }
.tab { padding: 8px 16px; font-size: 13px; font-weight: 500; color: var(--dim); cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--primary); border-bottom-color: var(--primary); }

/* Content area */
.content { padding: 16px 24px; max-height: calc(100vh - 300px); overflow-y: auto; }
.content::-webkit-scrollbar { width: 8px; }
.content::-webkit-scrollbar-track { background: var(--bg); }
.content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.content::-webkit-scrollbar-thumb:hover { background: var(--border-a); }
.view { display: none; }
.view.active { display: block; }

/* ---- Summary View ---- */
.sum-section { margin-bottom: 24px; }
.sum-section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.sum-prompt { background: linear-gradient(135deg, var(--s2), var(--s3)); border: 1px solid var(--border-a); border-left: 3px solid var(--primary); border-radius: 8px; padding: 14px 18px; font-size: 15px; line-height: 1.6; margin-bottom: 20px; }
.sum-prompt .sum-prompt-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); margin-bottom: 6px; }
.sum-narrative { background: var(--s1); border: 1px solid var(--border); border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.7; color: var(--text); margin-bottom: 16px; }
.sum-outcomes { display: flex; flex-direction: column; gap: 8px; }
.sum-outcome-item { background: var(--s1); border: 1px solid var(--border); border-left: 3px solid var(--green); border-radius: 6px; padding: 10px 14px; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.sum-diff-preview { margin: 4px 0 8px 36px; }
.sum-diff-preview pre { background: var(--bg); border: 1px solid var(--border); border-left: 3px solid var(--cyan); border-radius: 6px; padding: 10px 14px; font-size: 11px; font-family: 'JetBrains Mono', 'Fira Code', monospace; overflow-x: auto; max-height: 150px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; color: var(--dim); line-height: 1.5; }
.sum-timeline-item { display: flex; align-items: flex-start; gap: 12px; padding: 8px 0; border-bottom: 1px solid rgba(42,58,92,0.5); }
.sum-timeline-item:last-child { border-bottom: none; }
.sum-timeline-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
.sum-timeline-dot.gen { background: var(--secondary); }
.sum-timeline-dot.tool { background: var(--cyan); }
.sum-timeline-dot.err { background: var(--red); }
.sum-timeline-dot.fix { background: var(--green); }
.sum-timeline-dot.cmd { background: var(--orange); }
.sum-timeline-dot.sql { background: var(--yellow); }
.sum-timeline-dot.dbt { background: var(--orange); }
.sum-timeline-text { font-size: 13px; color: var(--text); }
.sum-timeline-text .dim { color: var(--dim); font-size: 12px; }
.sum-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
.sum-metric { background: linear-gradient(135deg, var(--s1), var(--s2)); border: 1px solid var(--border); border-radius: 10px; padding: 16px; text-align: center; }
/* Error detail items */
.sum-error-detail { background: rgba(248,113,113,0.06); border: 1px solid rgba(248,113,113,0.25); border-left: 3px solid var(--red); border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
.sum-error-detail .err-tool { color: var(--red); font-weight: 600; font-size: 13px; }
.sum-error-detail .err-time { color: var(--dim); font-size: 11px; margin-left: 8px; }
.sum-error-detail .err-message { font-size: 13px; color: var(--text); margin-top: 6px; font-family: 'JetBrains Mono', 'Fira Code', monospace; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow-y: auto; }
.sum-error-detail .err-resolution { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(248,113,113,0.15); font-size: 12px; color: var(--green); }
/* File change lists */
.sum-file-list { display: flex; flex-direction: column; gap: 4px; }
.sum-file-item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: var(--s2); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; font-family: 'JetBrains Mono', 'Fira Code', monospace; }
.sum-file-item .file-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px; flex-shrink: 0; }
.sum-file-item .file-badge.edit { background: rgba(251,191,36,0.15); color: var(--orange); }
.sum-file-item .file-badge.write { background: rgba(74,222,128,0.15); color: var(--green); }
.sum-file-item .file-badge.read { background: rgba(77,142,255,0.15); color: var(--primary); }
.sum-file-item .file-path { color: var(--cyan); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Command list */
.sum-cmd-item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; background: var(--s2); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; font-family: 'JetBrains Mono', 'Fira Code', monospace; margin-bottom: 4px; }
.sum-cmd-item .cmd-prefix { color: var(--green); flex-shrink: 0; }
.sum-cmd-item .cmd-text { color: var(--text); word-break: break-word; }
.sum-cmd-item .cmd-status { flex-shrink: 0; font-size: 10px; }
/* In-progress banner */
.sum-running-banner { background: linear-gradient(135deg, rgba(251,191,36,0.08), rgba(251,191,36,0.04)); border: 1px solid var(--orange); border-radius: 10px; padding: 16px 20px; margin-bottom: 20px; display: flex; align-items: center; gap: 12px; }
.sum-running-pulse { width: 12px; height: 12px; background: var(--orange); border-radius: 50%; animation: pulse 1.5s infinite; flex-shrink: 0; }
.sum-running-text { font-size: 14px; font-weight: 600; color: var(--orange); }
.sum-running-elapsed { font-size: 12px; color: var(--dim); margin-left: auto; }
/* Collapsible cost section */
.sum-collapsible { cursor: pointer; user-select: none; }
.sum-collapsible .sum-section-title { display: flex; align-items: center; gap: 6px; }
.sum-collapsible .sum-section-title::after { content: '\\25B6'; font-size: 10px; transition: transform 0.2s; }
.sum-collapsible.open .sum-section-title::after { transform: rotate(90deg); }
.sum-collapsible .sum-collapse-body { display: none; }
.sum-collapsible.open .sum-collapse-body { display: block; }
.sum-metric .val { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sum-metric .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); margin-top: 4px; }
.sum-loop-warning { background: rgba(251,191,36,0.1); border: 1px solid var(--orange); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
.sum-loop-warning .warn-title { color: var(--orange); font-weight: 600; font-size: 14px; margin-bottom: 6px; }
.sum-loop-warning .warn-item { font-size: 13px; color: var(--text); padding: 2px 0; }
.sum-cost-bar { display: flex; height: 24px; border-radius: 6px; overflow: hidden; margin-bottom: 8px; }
.sum-cost-bar div { transition: width 0.3s; }
.sum-cost-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--dim); }
.sum-cost-legend span { display: inline-flex; align-items: center; gap: 4px; }
.sum-cost-legend .dot { width: 10px; height: 10px; border-radius: 3px; }
.sum-tool-bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sum-tool-bar-name { width: 120px; font-size: 12px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); flex-shrink: 0; }
.sum-tool-bar-track { flex: 1; height: 20px; background: var(--s2); border-radius: 4px; overflow: hidden; }
.sum-tool-bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--cyan), var(--primary)); display: flex; align-items: center; padding-left: 6px; min-width: 24px; transition: width 0.3s; }
.sum-tool-bar-count { font-size: 10px; font-weight: 600; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
.sum-files { display: flex; flex-wrap: wrap; gap: 6px; }
.sum-file { background: var(--s2); border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; font-size: 12px; font-family: 'JetBrains Mono', 'Fira Code', monospace; color: var(--cyan); }
.sum-empty { color: var(--dim); font-style: italic; padding: 20px; text-align: center; }
.sum-error-banner { background: rgba(248,113,113,0.1); border: 1px solid var(--red); border-radius: 8px; padding: 14px 18px; margin-bottom: 16px; }
.sum-error-banner .err-title { color: var(--red); font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.sum-error-banner .err-msg { font-size: 13px; color: var(--text); }
.sum-status-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 10px; border-radius: 10px; margin-left: 8px; }
.sum-status-badge.running { background: rgba(251,191,36,0.15); color: var(--orange); }
.sum-status-badge.error { background: rgba(248,113,113,0.15); color: var(--red); }
.sum-status-badge.crashed { background: rgba(248,113,113,0.2); color: var(--red); }
.sum-status-badge.completed { background: rgba(74,222,128,0.15); color: var(--green); }

/* Mini timeline heatmap */
.mini-timeline { display: flex; height: 6px; border-radius: 3px; overflow: hidden; margin: 16px 24px 0; gap: 1px; }
.mini-timeline-seg { flex: 1; min-width: 2px; border-radius: 1px; transition: opacity 0.2s; }
.mini-timeline-seg:hover { opacity: 0.7; }

/* Fade-in animation */
@keyframes fadeInUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.sum-section { animation: fadeInUp 0.3s ease-out both; }
.sum-section:nth-child(2) { animation-delay: 0.05s; }
.sum-section:nth-child(3) { animation-delay: 0.1s; }
.sum-section:nth-child(4) { animation-delay: 0.15s; }
.sum-section:nth-child(5) { animation-delay: 0.2s; }
.sum-section:nth-child(6) { animation-delay: 0.25s; }
.sum-section:nth-child(7) { animation-delay: 0.3s; }
.sum-section:nth-child(8) { animation-delay: 0.35s; }

/* ---- Waterfall View ---- */
.wf-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--border); cursor: pointer; position: relative; z-index: 1; }
.wf-row > * { pointer-events: none; }
.wf-row:hover { background: var(--s1); }
.wf-row.sel { background: var(--s2); }
.wf-icon { width: 22px; height: 22px; text-align: center; font-size: 11px; flex-shrink: 0; border-radius: 4px; line-height: 22px; }
.wf-icon.generation { background: rgba(77,142,255,0.15); color: var(--secondary); }
.wf-icon.tool { background: rgba(34,211,238,0.12); color: var(--cyan); }
.wf-icon.error { background: rgba(248,113,113,0.15); color: var(--red); }
.wf-info { width: 300px; flex-shrink: 0; overflow: hidden; min-width: 0; }
.wf-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-preview { font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.wf-preview .pv-tag { display: inline-block; font-size: 10px; font-weight: 600; padding: 0 4px; border-radius: 3px; margin-right: 4px; vertical-align: baseline; }
.wf-preview .pv-tag.model { background: rgba(77,142,255,0.12); color: var(--secondary); }
.wf-preview .pv-tag.tok { background: rgba(74,222,128,0.12); color: var(--green); }
.wf-preview .pv-tag.err { background: rgba(248,113,113,0.12); color: var(--red); }
.wf-bar-c { flex: 1; height: 18px; position: relative; overflow: hidden; }
.wf-bar { position: absolute; height: 100%; border-radius: 3px; min-width: 3px; opacity: 0.85; display: flex; align-items: center; padding-left: 4px; }
.wf-bar.generation { background: var(--secondary); }
.wf-bar.tool { background: var(--cyan); }
.wf-bar.error { background: var(--red); }
.wf-bar-label { font-size: 9px; font-weight: 600; color: #fff; white-space: nowrap; text-shadow: 0 1px 2px rgba(0,0,0,0.5); pointer-events: none; }
.wf-dur { font-size: 12px; color: var(--dim); width: 60px; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }

/* ---- Tree View ---- */
.tree-node { border-left: 2px solid var(--border); margin-left: 12px; padding-left: 12px; }
.tree-node:first-child { margin-left: 0; border-left: none; padding-left: 0; }
.tree-item { padding: 6px 8px; border-radius: 6px; margin-bottom: 4px; cursor: pointer; }
.tree-item:hover { background: var(--s1); }
.tree-item.sel { background: var(--s2); border: 1px solid var(--border-a); }
.tree-head { display: flex; align-items: center; gap: 8px; }
.tree-type { font-size: 10px; font-weight: 600; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; }
.tree-type.generation { background: rgba(77,142,255,0.15); color: var(--secondary); }
.tree-type.tool { background: rgba(34,211,238,0.12); color: var(--cyan); }
.tree-type.session { background: rgba(77,142,255,0.1); color: var(--primary); }
.tree-title { font-size: 13px; font-weight: 500; }
.tree-meta { font-size: 12px; color: var(--dim); display: flex; gap: 12px; margin-top: 2px; }
.tree-preview { font-size: 11px; color: var(--dim); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 600px; }
.tree-preview .pv-tag { display: inline-block; font-size: 10px; font-weight: 600; padding: 0 4px; border-radius: 3px; margin-right: 4px; vertical-align: baseline; }
.tree-preview .pv-tag.model { background: rgba(77,142,255,0.12); color: var(--secondary); }
.tree-preview .pv-tag.tok { background: rgba(74,222,128,0.12); color: var(--green); }
.tree-preview .pv-tag.err { background: rgba(248,113,113,0.12); color: var(--red); }
.tree-detail { margin-top: 8px; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; display: none; }
.tree-detail.open { display: block; }

/* ---- Chat View ---- */
.chat-msg { margin-bottom: 16px; max-width: 85%; }
.chat-msg.user { margin-left: auto; }
.chat-msg.agent { margin-right: auto; }
.chat-bubble { padding: 10px 14px; border-radius: 12px; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
.chat-msg.user .chat-bubble { background: var(--s3); border-bottom-right-radius: 4px; }
.chat-msg.agent .chat-bubble { background: var(--s1); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
.chat-role { font-size: 11px; color: var(--dim); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
.chat-msg.user .chat-role { text-align: right; }
.chat-tool { background: var(--s1); border: 1px solid var(--border); border-left: 3px solid var(--cyan); border-radius: 8px; padding: 8px 12px; margin: 8px 0; font-size: 12px; }
.chat-tool.err { border-left-color: var(--red); }
.chat-tool .tool-name { color: var(--cyan); font-weight: 600; }
.chat-tool .tool-dur { color: var(--dim); font-size: 11px; }
.chat-tool pre { background: var(--bg); padding: 6px; border-radius: 4px; margin-top: 4px; font-size: 11px; overflow-x: auto; max-height: 150px; overflow-y: auto; }

/* ---- Log View ---- */
.log-entry { padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; font-family: 'JetBrains Mono', 'Fira Code', monospace; cursor: pointer; }
.log-entry:hover { background: var(--s1); }
.log-entry.sel { background: var(--s2); }
.log-ts { color: var(--dim); font-size: 11px; margin-right: 8px; }
.log-kind { font-size: 10px; font-weight: 600; text-transform: uppercase; padding: 1px 4px; border-radius: 3px; margin-right: 8px; }
.log-kind.generation { background: rgba(77,142,255,0.15); color: var(--secondary); }
.log-kind.tool { background: rgba(34,211,238,0.12); color: var(--cyan); }
.log-kind.session { background: rgba(77,142,255,0.1); color: var(--primary); }
.log-kind.error { background: rgba(248,113,113,0.15); color: var(--red); }
.log-name { color: var(--text); font-weight: 500; }
.log-data { color: var(--dim); margin-top: 4px; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }

/* Detail panel */
.detail-panel { background: var(--s1); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-top: 12px; }
.detail-panel h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--primary); }
.dg { display: grid; grid-template-columns: 130px 1fr; gap: 3px 12px; font-size: 13px; }
.dg dt { color: var(--dim); }
.dg dd { word-break: break-word; }
pre.io { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-size: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; max-height: 300px; margin-top: 6px; }
.sec { margin-top: 10px; }
.sec-lbl { font-size: 11px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }

/* DE attribute sections */
.de-sec { margin-top: 8px; }
.de-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }

/* Footer */
.footer { padding: 20px 24px; border-top: 1px solid var(--border); font-size: 13px; color: var(--dim); text-align: center; margin-top: 24px; }
.footer a { color: var(--primary); text-decoration: none; font-weight: 500; }
.footer a:hover { text-decoration: underline; }

/* Live indicator */
.live-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--green); font-weight: 600; }
.live-dot { width: 6px; height: 6px; background: var(--green); border-radius: 50%; animation: pulse 2s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.live-flash { animation: flash 0.6s ease-out; }
@keyframes flash { 0% { box-shadow: inset 0 0 0 2px var(--green); } 100% { box-shadow: inset 0 0 0 0 transparent; } }
.live-updated { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--green); opacity: 0; transition: opacity 0.3s; }
.live-updated.show { opacity: 1; }
</style>
</head>
<body>
<div class="hdr">
  <div class="logo"><div class="logo-mark">A</div><div class="logo-text"><span>Altimate</span> Recap</div></div>
  <div class="tags" id="tags"></div>
</div>
<div class="toolbar">
  <button class="toolbar-btn primary" id="btn-share" title="Download self-contained HTML recap">Share Recap</button>
  <button class="toolbar-btn" id="btn-copy-summary" title="Copy markdown summary to clipboard">Copy Summary</button>
  <button class="toolbar-btn" id="btn-copy-link" title="Copy current URL to clipboard">Copy Link</button>
  <div class="toolbar-spacer"></div>
  <span class="toolbar-toast" id="toolbar-toast"></span>
</div>
<div class="mini-timeline" id="mini-timeline"></div>
<div id="prompt-area"></div>
<div class="cards" id="cards"></div>
<div class="tabs" id="tabs" role="tablist">
  <div class="tab active" data-view="summary" role="tab" tabindex="0">Summary</div>
  <div class="tab" data-view="waterfall" role="tab" tabindex="0">Waterfall</div>
  <div class="tab" data-view="tree" role="tab" tabindex="0">Tree</div>
  <div class="tab" data-view="chat" role="tab" tabindex="0">Chat</div>
  <div class="tab" data-view="log" role="tab" tabindex="0">Log</div>
</div>
<div class="content">
  <div class="view active" id="v-summary"></div>
  <div class="view" id="v-waterfall"></div>
  <div class="view" id="v-tree"></div>
  <div class="view" id="v-chat"></div>
  <div class="view" id="v-log"></div>
</div>
<div id="detail"></div>
<div class="footer">Generated with <span style="color:var(--primary);font-weight:600">Altimate Code</span> &mdash; Try it free at <a href="https://altimate.ai/recap" target="_blank" rel="noopener">altimate.ai/recap</a></div>

<script>
var t = ${traceJSON};
var e = function(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;'); };
var fd = function(ms) { if (!ms && ms !== 0) return '-'; ms = Math.abs(ms); if (ms < 1000) return ms + 'ms'; if (ms < 60000) return (ms/1000).toFixed(1) + 's'; return Math.floor(ms/60000) + 'm' + Math.floor((ms%60000)/1000) + 's'; };
var fc = function(c) { if (c == null || isNaN(c)) return '\\u2014'; if (c === 0) return '$0.00'; return c < 0.01 ? '$' + c.toFixed(4) : '$' + c.toFixed(2); };
var fb = function(b) { if (!b) return '0 B'; if (b < 1024) return b + ' B'; if (b < 1048576) return (b/1024).toFixed(1) + ' KB'; if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB'; return (b/1073741824).toFixed(2) + ' GB'; };
var model = (function(m) { if (!m) return 'unknown'; var i = m.indexOf('/'); return i >= 0 ? m.slice(i+1) : m; })(t.metadata.model);
var spans = t.spans || [];
var nonSession = spans.filter(function(s) { return s.kind !== 'session'; });

// --- Header tags ---
var tagsHtml = '<span class="tag">Session: <strong>' + e(t.metadata.title || t.sessionId) + '</strong></span>';
tagsHtml += '<span class="tag">Provider: <strong>' + e(t.metadata.providerId || 'unknown') + '</strong></span>';
tagsHtml += '<span class="tag">Model: <strong>' + e(model) + '</strong></span>';
tagsHtml += '<span class="tag">Agent: <strong>' + e(t.metadata.agent || 'default') + '</strong></span>';
var stColor = t.summary.status === 'error' || t.summary.status === 'crashed' ? 'var(--red)' : t.summary.status === 'running' ? 'var(--orange)' : 'var(--green)';
tagsHtml += '<span class="tag" style="border-color:' + stColor + '">Status: <strong style="color:' + stColor + '">' + e(t.summary.status || 'unknown') + '</strong></span>';
${live ? "tagsHtml += '<span class=\"live-badge\"><span class=\"live-dot\"></span>LIVE</span>';" : ""}
document.getElementById('tags').innerHTML = tagsHtml;

// --- Prompt ---
if (t.metadata.prompt) {
  // Prompt shown in Summary tab — hide the header prompt box to avoid redundancy
  // document.getElementById('prompt-area').innerHTML = '';
}

// --- Summary cards ---
var s = t.summary || {}, tk = s.tokens || {};
var cardsData = [
  ['Duration', fd(s.duration), 'primary', true],
  ['Cost', fc(s.totalCost), 'orange', s.totalCost > 0],
  ['Tools', Number(s.totalToolCalls||0), 'green', Number(s.totalToolCalls||0) > 0],
  ['LLM Calls', Number(s.totalGenerations||0), 'secondary', Number(s.totalGenerations||0) > 0],
  ['Tokens', Number(s.totalTokens||0).toLocaleString(), 'accent', Number(s.totalTokens||0) > 0]
];

// Duration color coding
var durColor = 'var(--green)';
if (s.duration > 1800000) durColor = 'var(--red)';
else if (s.duration > 600000) durColor = 'var(--orange)';
else if (s.duration > 120000) durColor = 'var(--yellow)';
cardsData[0][2] = '';

document.getElementById('cards').innerHTML = cardsData.filter(function(c) { return c[3]; }).map(function(c, i) {
  var color = i === 0 ? durColor : 'var(--' + c[2] + ')';
  return '<div class="card"><div class="lbl">' + c[0] + '</div><div class="val" style="color:' + color + '">' + c[1] + '</div></div>';
}).join('');

// --- Mini timeline heatmap ---
(function() {
  var el = document.getElementById('mini-timeline');
  if (!nonSession.length) return;
  var tStart = Math.min.apply(null, spans.map(function(s) { return s.startTime || Infinity; }));
  var tEnd = Math.max.apply(null, spans.map(function(s) { return s.endTime || s.startTime || 0; }));
  var totalDur = tEnd - tStart || 1;
  var numBuckets = 60;
  var buckets = new Array(numBuckets);
  for (var i = 0; i < numBuckets; i++) buckets[i] = 0;
  nonSession.forEach(function(span) {
    var mid = ((span.startTime || 0) + (span.endTime || span.startTime || 0)) / 2;
    var idx = Math.min(numBuckets - 1, Math.floor((mid - tStart) / totalDur * numBuckets));
    buckets[idx]++;
  });
  var maxB = Math.max.apply(null, buckets) || 1;
  var html = '';
  for (var i = 0; i < numBuckets; i++) {
    var intensity = buckets[i] / maxB;
    var alpha = 0.1 + intensity * 0.9;
    var color = intensity > 0.7 ? 'var(--primary)' : intensity > 0.3 ? 'var(--cyan)' : 'var(--secondary)';
    html += '<div class="mini-timeline-seg" style="background:' + color + ';opacity:' + alpha.toFixed(2) + '"></div>';
  }
  el.innerHTML = html;
})();

// --- Tab switching ---
function activateTab(tab) {
  if (!tab || !tab.dataset || !tab.dataset.view) return;
  var view = tab.dataset.view;
  document.querySelectorAll('.tab').forEach(function(el) { el.classList.remove('active'); });
  document.querySelectorAll('.view').forEach(function(el) { el.classList.remove('active'); });
  tab.classList.add('active');
  document.getElementById('v-' + view).classList.add('active');
  document.getElementById('detail').innerHTML = '';
}
document.getElementById('tabs').addEventListener('click', function(ev) {
  var tab = ev.target.closest ? ev.target.closest('.tab') : ev.target;
  activateTab(tab);
});
document.getElementById('tabs').addEventListener('keydown', function(ev) {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    var tab = ev.target.closest ? ev.target.closest('.tab') : ev.target;
    activateTab(tab);
  }
});

// --- Jump to span (from Summary outcome links) ---
function gotoSpan(el) {
  var spanId = el ? el.getAttribute('data-goto-span') : null;
  if (!spanId) return;
  // Switch to Waterfall tab
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
  var wfTab = document.querySelector('.tab[data-view="waterfall"]');
  if (wfTab) wfTab.classList.add('active');
  var wfView = document.getElementById('v-waterfall');
  if (wfView) wfView.classList.add('active');
  // Find and highlight the row
  setTimeout(function() {
    var safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(spanId) : spanId.replace(/[\\\\"\\/]/g, '');
    var row = document.querySelector('.wf-row[data-span-id="' + safeId + '"]');
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('sel');
      row.click();
    }
  }, 100);
}

// --- Timing helpers ---
var tStart = spans.length ? Math.min.apply(null, spans.map(function(s) { return s.startTime || 0; })) : 0;
var tEnd = spans.length ? Math.max.apply(null, spans.map(function(s) { return s.endTime || s.startTime || Date.now(); })) : 1;
var tTotal = tEnd - tStart || 1;
var icons = { session: '\\u25A0', generation: '\\u2B50', tool: '\\u2692', text: '\\u270E' };

// --- Inline preview helper ---
function getPreview(span) {
  var parts = [];
  if (span.status === 'error' && span.statusMessage) {
    return '<span class="pv-tag err">\\u2718</span>' + e((span.statusMessage || '').slice(0, 120));
  }
  if (span.kind === 'tool') {
    var inp = span.input;
    if (inp) {
      if (typeof inp === 'string') {
        parts.push(e(inp.slice(0, 120)));
      } else if (typeof inp === 'object') {
        var o = inp;
        if (o.command) parts.push(e(String(o.command).slice(0, 120)));
        else if (o.file_path) parts.push(e(String(o.file_path)));
        else if (o.pattern && o.path) parts.push(e(o.pattern + ' in ' + o.path));
        else if (o.pattern) parts.push(e(String(o.pattern)));
        else if (o.query) parts.push(e(String(o.query).slice(0, 120)));
        else if (o.url) parts.push(e(String(o.url).slice(0, 120)));
        else if (o.prompt) parts.push(e(String(o.prompt).slice(0, 120)));
        else if (o.description) parts.push(e(String(o.description).slice(0, 120)));
        else {
          var s = JSON.stringify(o);
          if (s.length > 120) s = s.slice(0, 120) + '...';
          parts.push(e(s));
        }
      }
    }
    if (span.status === 'error') parts.unshift('<span class="pv-tag err">\\u2718</span>');
  } else if (span.kind === 'generation') {
    if (span.model && span.model.modelId) parts.push('<span class="pv-tag model">' + e(span.model.modelId) + '</span>');
    if (span.tokens && span.tokens.total) parts.push('<span class="pv-tag tok">' + Number(span.tokens.total).toLocaleString() + ' tok</span>');
    if (span.finishReason && span.finishReason !== 'stop') parts.push(e(span.finishReason));
    if (span.cost) parts.push(fc(span.cost));
  } else if (span.kind === 'text') {
    if (span.input) {
      var txt = typeof span.input === 'string' ? span.input : JSON.stringify(span.input);
      parts.push(e(txt.slice(0, 120)));
    }
  }
  return parts.join(' ');
}

// --- Detail panel ---
function showDetail(span) {
  var dur = (span.endTime || Date.now()) - (span.startTime || 0);
  var h = '<div class="detail-panel"><h3>' + e(span.name) + '</h3><dl class="dg">';
  h += '<dt>Kind</dt><dd>' + e(span.kind||'') + '</dd>';
  h += '<dt>Status</dt><dd' + (span.status==='error'?' style="color:var(--red)"':'') + '>' + e(span.status||'') + '</dd>';
  if (span.statusMessage) h += '<dt>Error</dt><dd style="color:var(--red)">' + e(span.statusMessage) + '</dd>';
  h += '<dt>Duration</dt><dd>' + fd(dur) + '</dd>';
  if (span.model) {
    if (span.model.modelId) h += '<dt>Model</dt><dd>' + e(span.model.modelId) + '</dd>';
    if (span.model.providerId) h += '<dt>Provider</dt><dd>' + e(span.model.providerId) + '</dd>';
    if (span.model.variant) h += '<dt>Variant</dt><dd>' + e(span.model.variant) + '</dd>';
  }
  if (span.finishReason) h += '<dt>Finish Reason</dt><dd>' + e(span.finishReason) + '</dd>';
  if (span.cost != null) h += '<dt>Cost</dt><dd>' + fc(span.cost) + '</dd>';
  if (span.tokens) {
    h += '<dt>Input Tokens</dt><dd>' + Number(span.tokens.input||0).toLocaleString() + '</dd>';
    h += '<dt>Output Tokens</dt><dd>' + Number(span.tokens.output||0).toLocaleString() + '</dd>';
    if (span.tokens.reasoning) h += '<dt>Reasoning</dt><dd>' + Number(span.tokens.reasoning).toLocaleString() + '</dd>';
    if (span.tokens.cacheRead) h += '<dt>Cache Read</dt><dd>' + Number(span.tokens.cacheRead).toLocaleString() + '</dd>';
    if (span.tokens.cacheWrite) h += '<dt>Cache Write</dt><dd>' + Number(span.tokens.cacheWrite).toLocaleString() + '</dd>';
    h += '<dt>Total</dt><dd>' + Number(span.tokens.total||0).toLocaleString() + '</dd>';
  }
  if (span.tool) {
    if (span.tool.callId) h += '<dt>Call ID</dt><dd>' + e(span.tool.callId) + '</dd>';
    if (span.tool.durationMs != null) h += '<dt>Tool Duration</dt><dd>' + fd(span.tool.durationMs) + '</dd>';
  }
  // DE attributes grouped
  var a = span.attributes || {};
  var groups = [['de.warehouse.','Warehouse','cyan'],['de.sql.','SQL','secondary'],['de.dbt.','dbt','orange'],['de.quality.','Quality','green'],['de.cost.','Cost','orange']];
  var used = {};
  groups.forEach(function(g) {
    var entries = Object.keys(a).filter(function(k){return k.indexOf(g[0])===0;});
    if (!entries.length) return;
    entries.forEach(function(k){used[k]=1;});
    h += '</dl><div class="de-sec"><div class="de-title" style="color:var(--'+g[2]+')">' + g[1] + '</div><dl class="dg">';
    entries.forEach(function(k) {
      var v = a[k], label = k.replace(g[0],'').replace(/_/g,' ');
      var val = typeof v === 'boolean' ? (v ? '<span style="color:var(--green)">\\u2714 yes</span>' : '<span style="color:var(--red)">\\u2718 no</span>') :
                typeof v === 'number' && k.indexOf('cost') >= 0 ? fc(v) :
                typeof v === 'number' && k.indexOf('bytes') >= 0 ? fb(v) :
                typeof v === 'object' ? e(JSON.stringify(v)) : e(String(v));
      h += '<dt>' + e(label) + '</dt><dd>' + val + '</dd>';
    });
  });
  // Remaining attributes
  var other = Object.keys(a).filter(function(k){return !used[k];});
  if (other.length) {
    if (Object.keys(used).length) h += '</dl><dl class="dg">';
    other.forEach(function(k) { h += '<dt>' + e(k) + '</dt><dd>' + e(String(a[k])) + '</dd>'; });
  }
  h += '</dl>';
  if (span.input != null) {
    var inp = typeof span.input === 'string' ? span.input : JSON.stringify(span.input, null, 2);
    h += '<div class="sec"><div class="sec-lbl">Input</div><pre class="io">' + e(inp) + '</pre></div>';
  }
  if (span.output != null) {
    var out = typeof span.output === 'string' ? span.output : JSON.stringify(span.output, null, 2);
    h += '<div class="sec"><div class="sec-lbl">Output</div><pre class="io">' + e(out) + '</pre></div>';
  }
  h += '</div>';
  var dp = document.getElementById('detail');
  dp.innerHTML = h;
  dp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ===================== SUMMARY VIEW =====================
(function() {
  var el = document.getElementById('v-summary');
  try {
  var s = t.summary || {};
  var tk = s.tokens || {};
  var html = '';

  // Handle empty trace
  if (!spans.length || !nonSession.length) {
    el.innerHTML = '<div class="sum-empty" style="padding:40px;text-align:center;color:var(--dim)"><div style="font-size:24px;margin-bottom:8px">\\u2014</div><div>No activity recorded in this session</div>' + (t.metadata.prompt ? '<div style="margin-top:16px;color:var(--text);font-size:14px">Prompt: ' + e(t.metadata.prompt.slice(0, 200)) + '</div>' : '') + '</div>';
    return;
  }

  // --- Classify all tool spans upfront ---
  var toolSpans = nonSession.filter(function(sp) { return sp.kind === 'tool'; });
  var genSpans = nonSession.filter(function(sp) { return sp.kind === 'generation'; });
  var errSpans = nonSession.filter(function(sp) { return sp.status === 'error'; });

  // Categorize files: changed (edit/write) vs read
  var changedFiles = {};
  var readFiles = {};
  var bashCmds = [];
  var sqlQueries = [];
  var dbtOps = [];
  var otherTools = {};

  toolSpans.forEach(function(sp) {
    var name = sp.name || 'unknown';
    var lname = name.toLowerCase();
    var inp = sp.input;
    var inpObj = (inp && typeof inp === 'object') ? inp : null;
    var fp = inpObj ? (inpObj.file_path || inpObj.path || inpObj.filePath) : null;
    if (fp && typeof fp !== 'string') fp = null;

    if (lname.indexOf('edit') >= 0 || lname.indexOf('write') >= 0) {
      if (fp) changedFiles[fp] = lname.indexOf('write') >= 0 ? 'write' : 'edit';
    } else if (lname.indexOf('read') >= 0 || lname === 'glob' || lname === 'grep') {
      if (fp && !changedFiles[fp]) readFiles[fp] = 1;
    } else if (lname === 'bash' || lname.indexOf('shell') >= 0) {
      var cmd = inpObj ? (inpObj.command || '') : (typeof inp === 'string' ? inp : '');
      if (cmd) {
        // Extract the meaningful command — strip cd prefixes, take last command in chain
        var rawCmd = String(cmd);
        var parts = rawCmd.split(/\\s*&&\\s*/);
        var lastCmd = parts[parts.length - 1].trim();
        // Detect dbt from the meaningful part, not the cd prefix
        var isDbt = /\\bdbt\\s+/.test(lastCmd);
        bashCmds.push({ command: rawCmd, displayCommand: lastCmd, status: sp.status, isDbt: isDbt, span: sp });
        if (isDbt) dbtOps.push({ command: lastCmd, status: sp.status, span: sp });
      }
    } else if (lname.indexOf('sql') >= 0 || lname.indexOf('query') >= 0 || lname.indexOf('execute') >= 0) {
      var query = inpObj ? (inpObj.query || inpObj.sql || '') : (typeof inp === 'string' ? inp : '');
      if (query) sqlQueries.push({ query: String(query).slice(0, 200), status: sp.status, span: sp });
    } else {
      if (!otherTools[name]) otherTools[name] = [];
      otherTools[name].push(sp);
    }
  });

  // Remove read files that were also changed
  Object.keys(changedFiles).forEach(function(fp) { delete readFiles[fp]; });

  // --- Extract outcomes & file previews (tool-agnostic) ---
  var changedFilePreviews = {};

  // Build a list of significant command executions with their results
  // Works for dbt, Airflow, Dagster, Airbyte, pytest, scripts, etc.
  var cmdOutcomes = []; // { command, result, status, spanId, tool }

  toolSpans.forEach(function(sp) {
    var lname = (sp.name || '').toLowerCase();
    var output = sp.output;
    var outStr = typeof output === 'string' ? output : (output && typeof output === 'object' ? JSON.stringify(output) : '');
    // Strip ANSI escape codes
    outStr = outStr.replace(/\\x1b\\[[0-9;]*m/g, '').replace(/\\[\\d+m/g, '').replace(/\\u001b\\[[0-9;]*m/g, '');
    // Strip timestamps like HH:MM:SS
    outStr = outStr.replace(/\\d{2}:\\d{2}:\\d{2}\\s*/g, '');
    var inp = sp.input && typeof sp.input === 'object' ? sp.input : {};
    var fp = inp.file_path || inp.filePath || inp.path || null;
    if (fp && typeof fp !== 'string') fp = null;

    // Capture file write content for diff preview
    if ((lname.indexOf('write') >= 0 || lname.indexOf('edit') >= 0) && fp) {
      var preview = '';
      if (inp.new_string) {
        preview = String(inp.new_string).slice(0, 300);
      } else if (inp.content) {
        var clines = String(inp.content).split('\\n');
        preview = clines.slice(0, 10).join('\\n');
        if (clines.length > 10) preview += '\\n... (' + clines.length + ' lines total)';
      }
      if (preview) changedFilePreviews[fp] = preview;
    }

    // For bash/shell commands — extract meaningful command and its outcome
    if ((lname === 'bash' || lname.indexOf('shell') >= 0) && outStr) {
      var rawCmd = String(inp.command || '');
      var cmdParts = rawCmd.split(/\\s*&&\\s*/);
      var displayCmd = cmdParts[cmdParts.length - 1].trim();
      var displayLower = displayCmd.toLowerCase();

      // Skip boring exploration commands
      if (/^(ls|cd|cat|head|tail|echo|pwd|which|wc|file|mkdir|test|find|stat|du|df|touch|chmod)\\b/.test(displayLower)) return;

      // Determine if this is a significant command worth showing as outcome
      var isSignificant = false;
      var resultText = '';

      // Pattern 1: Test runners (pytest, bun test, jest, mocha, unittest, etc.)
      var testMatch = outStr.match(/(\\d+)\\s*(?:tests?|specs?|scenarios?).*?(?:pass|fail|error)/i)
        || outStr.match(/(\\d+)\\s*pass.*?(\\d+)\\s*fail/i)
        || outStr.match(/(?:PASSED|FAILED|OK|ERROR).*?(?:\\d+\\s*tests?)/i)
        || outStr.match(/Tests?:\\s*\\d+\\s*(?:passed|failed)/i)
        || outStr.match(/Ran\\s+\\d+\\s+tests?/i);
      if (testMatch) { isSignificant = true; resultText = testMatch[0].replace(/\\s+/g, ' ').trim().slice(0, 100); }

      // Pattern 2: Build tools (dbt, make, gradle, cargo, npm/bun build, etc.)
      if (!isSignificant) {
        var buildMatch = outStr.match(/(?:Completed|Finished|Built)\\s+(?:successfully|with|in)[^\\n]*/i)
          || outStr.match(/BUILD\\s+(?:SUCCESS|FAILED|SUCCESSFUL)/i)
          || outStr.match(/(?:Compiling|Building).*(?:Finished|Done|Complete)/i)
          // dbt-specific: output is often truncated, so also match partial results
          || outStr.match(/\\d+\\s+of\\s+\\d+\\s+(?:PASS|ERROR|FAIL|START|OK)\\b[^\\n]*/i)
          || outStr.match(/\\[PASS[^\\]]*\\]/i)
          || outStr.match(/\\[ERROR[^\\]]*\\]/i)
          || outStr.match(/Compilation\\s+Error[^\\n]*/i)
          || outStr.match(/command\\s+not\\s+found[^\\n]*/i);
        if (buildMatch) { isSignificant = true; resultText = buildMatch[0].replace(/\\s+/g, ' ').replace(/:$/, '').trim().slice(0, 100); }
      }

      // Pattern 3: Pipeline/orchestration tools (Airflow, Dagster, Prefect, Airbyte)
      if (!isSignificant) {
        var pipeMatch = outStr.match(/(?:DAG|pipeline|flow|job|sync|task)\\s+.*?(?:success|complete|fail|error|running)/i)
          || outStr.match(/(?:materialization|run|execution).*?(?:succeeded|failed|completed)/i)
          || outStr.match(/Status:\\s*(?:success|failed|completed|error)/i);
        if (pipeMatch) { isSignificant = true; resultText = pipeMatch[0].replace(/\\s+/g, ' ').trim().slice(0, 100); }
      }

      // Pattern 4: Package install (pip, npm, bun, cargo, etc.)
      if (!isSignificant) {
        var installMatch = outStr.match(/(?:Successfully\\s+installed|added|resolved)\\s+[^\\n]*/i)
          || outStr.match(/(?:\\d+\\s+packages?)\\s+(?:installed|added|updated)/i);
        if (installMatch) { isSignificant = true; resultText = installMatch[0].replace(/\\s+/g, ' ').trim().slice(0, 100); }
      }

      // Pattern 5: SQL results
      if (!isSignificant) {
        var sqlMatch = outStr.match(/(\\d+)\\s*rows?\\s*(?:returned|affected|found|selected|inserted|updated|deleted)/i);
        if (sqlMatch) { isSignificant = true; resultText = sqlMatch[0].trim(); }
      }

      // Pattern 6: Python/script errors (tracebacks)
      if (!isSignificant && sp.status === 'error') {
        var tbMatch = outStr.match(/(?:Error|Exception|Traceback)[^\\n]*/i);
        if (tbMatch) { isSignificant = true; resultText = tbMatch[0].trim().slice(0, 100); }
      }

      if (isSignificant) {
        // Detect error from text, not just exit code
        var hasError = sp.status === 'error' || /\\b(?:fail|error|exception|traceback)\\b/i.test(resultText);
        if (/\\b(?:0 errors?|0 fail|no error|success)\\b/i.test(resultText)) hasError = false;
        cmdOutcomes.push({
          command: displayCmd.replace(/\\s*2>&1.*$/, '').replace(/\\s*\\|\\s*(?:tail|head).*$/i, '').trim().slice(0, 80),
          result: resultText,
          status: hasError ? 'error' : 'ok',
          spanId: sp.spanId || null,
          tool: lname
        });
      }
    }

    // SQL tool results (non-bash)
    if ((lname.indexOf('sql') >= 0 || lname.indexOf('query') >= 0 || lname.indexOf('execute') >= 0) && outStr) {
      var rowMatch = outStr.match(/(\\d+)\\s*rows?\\s*(?:returned|affected|found|selected)/i)
        || outStr.match(/row returned|query.*(?:success|complete)/i);
      if (rowMatch) {
        cmdOutcomes.push({ command: 'SQL query', result: rowMatch[0], status: sp.status === 'error' ? 'error' : 'ok', spanId: sp.spanId, tool: 'sql' });
      } else if (sp.status === 'error') {
        var sqlErr = outStr.match(/ERROR[^\\n]*/i);
        cmdOutcomes.push({ command: 'SQL query', result: sqlErr ? sqlErr[0].slice(0, 100) : 'Query failed', status: 'error', spanId: sp.spanId, tool: 'sql' });
      }
    }

    // Schema, validation, lineage tool results (non-bash, non-SQL)
    if ((lname.indexOf('schema') >= 0 || lname.indexOf('lineage') >= 0 || lname.indexOf('validate') >= 0 || lname.indexOf('altimate_core') >= 0 || lname.indexOf('inspect') >= 0) && outStr) {
      var toolResult = outStr.match(/(?:pass|fail|valid|invalid|\\d+\\s*issues?|\\d+\\s*errors?|succeeded|completed)[^\\n]*/i);
      if (toolResult) {
        var isErr = sp.status === 'error' || /fail|invalid|error/i.test(toolResult[0]);
        cmdOutcomes.push({ command: sp.name || lname, result: toolResult[0].replace(/\\s+/g, ' ').trim().slice(0, 100), status: isErr ? 'error' : 'ok', spanId: sp.spanId, tool: 'validation' });
      } else if (sp.status === 'error') {
        cmdOutcomes.push({ command: sp.name || lname, result: outStr.slice(0, 100), status: 'error', spanId: sp.spanId, tool: 'validation' });
      }
    }
  });

  // Helper: relative time from session start
  function relTime(ts) {
    if (!ts || !tStart) return '';
    var ms = ts - tStart;
    if (ms < 0) ms = 0;
    return fd(ms);
  }

  // Helper: clean prompt text for display
  function cleanPrompt(raw) {
    if (!raw) return '';
    // Strip surrounding quotes
    var s = raw.replace(/^["']+|["']+$/g, '').trim();
    // Strip markdown headings
    s = s.replace(/^#+\\s*/gm, '').trim();
    // Take first meaningful line (skip empty or very short lines)
    var lines = s.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 5; });
    return lines[0] || s.split('\\n')[0] || s;
  }

  // Helper: shorten file path for display
  function shortPath(fp) {
    if (!fp) return '';
    var parts = fp.split('/');
    if (parts.length > 3) return '.../' + parts.slice(-3).join('/');
    return fp;
  }

  // ---- 0. IN-PROGRESS BANNER ----
  if (s.status === 'running') {
    var elapsed = s.duration || (Date.now() - (new Date(t.startedAt || 0)).getTime());
    html += '<div class="sum-running-banner">';
    html += '<div class="sum-running-pulse"></div>';
    html += '<div class="sum-running-text">Agent is working...</div>';
    html += '<div class="sum-running-elapsed">Running for ' + fd(elapsed) + '</div>';
    html += '</div>';
  }

  // ---- 1. HEADER: status + duration + cost ----
  if (s.status === 'error' || s.status === 'crashed') {
    html += '<div class="sum-error-banner"><div class="err-title">' + (s.status === 'crashed' ? 'Session Crashed' : 'Session Error') + '</div>';
    html += '<div class="err-msg">' + e(s.error || 'An error occurred during this session') + '</div></div>';
  }

  // Compact header metrics
  html += '<div class="sum-section">';
  var durColorVal = 'var(--green)';
  if (s.duration > 1800000) durColorVal = 'var(--red)';
  else if (s.duration > 600000) durColorVal = 'var(--orange)';
  else if (s.duration > 120000) durColorVal = 'var(--yellow)';
  html += '<div class="sum-metrics">';
  if (s.status !== 'running') {
    html += '<div class="sum-metric"><div class="val" style="color:' + durColorVal + '">' + fd(s.duration) + '</div><div class="lbl">Completed in</div></div>';
  }
  html += '<div class="sum-metric"><div class="val" style="color:var(--orange)">' + fc(s.totalCost) + '</div><div class="lbl">Cost</div></div>';
  var changedCount = Object.keys(changedFiles).length;
  if (changedCount > 0) {
    html += '<div class="sum-metric"><div class="val" style="color:var(--green)">' + changedCount + '</div><div class="lbl">Files changed</div></div>';
  }
  if (errSpans.length > 0) {
    html += '<div class="sum-metric"><div class="val" style="color:var(--red)">' + errSpans.length + '</div><div class="lbl">Error' + (errSpans.length > 1 ? 's' : '') + '</div></div>';
  }
  html += '</div></div>';

  // Show error summary prominently right after header if there are errors
  if (errSpans.length > 0) {
    html += '<div class="sum-error-banner" style="margin:0 0 8px;padding:10px 16px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);border-radius:8px;display:flex;align-items:center;gap:10px">';
    html += '<span style="color:var(--red);font-size:18px">\\u26A0</span>';
    html += '<div style="font-size:13px"><strong style="color:var(--red)">' + errSpans.length + ' error' + (errSpans.length > 1 ? 's' : '') + ' during session</strong>';
    var firstErr = errSpans[0];
    var firstErrMsg = firstErr.statusMessage || '';
    if (!firstErrMsg && firstErr.output && typeof firstErr.output === 'string') firstErrMsg = firstErr.output.slice(0, 100);
    if (firstErrMsg) html += '<div style="color:var(--dim);font-size:12px;margin-top:2px">' + e((firstErr.name || '') + ': ' + firstErrMsg.slice(0, 100)) + '</div>';
    html += '</div></div>';
  }

  // What was asked
  html += '<div class="sum-section">';
  html += '<div class="sum-section-title">What was asked</div>';
  if (t.metadata.prompt) {
    var cleaned = cleanPrompt(t.metadata.prompt);
    var fullPrompt = t.metadata.prompt.replace(/^["']+|["']+$/g, '').trim();
    var needsExpand = fullPrompt.length > 200;
    html += '<div class="sum-prompt"><div class="sum-prompt-lbl">Prompt</div>';
    html += '<div class="sum-prompt-text">' + e(cleaned.slice(0, 200)) + '</div>';
    if (needsExpand) {
      html += '<div class="sum-prompt-full" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:12px;color:var(--dim);white-space:pre-wrap;max-height:300px;overflow-y:auto">' + e(fullPrompt) + '</div>';
      html += '<div class="sum-prompt-toggle" style="margin-top:6px;font-size:11px;color:var(--primary);cursor:pointer" onclick="var f=this.previousElementSibling;var show=f.style.display===\\x27none\\x27;f.style.display=show?\\x27block\\x27:\\x27none\\x27;this.textContent=show?\\x27Show less\\x27:\\x27Show full prompt\\x27">Show full prompt</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="sum-prompt" style="color:var(--dim);font-style:italic">No prompt recorded</div>';
  }
  html += '</div>';

  // ---- 2. WHAT CHANGED: Files modified with diff preview ----
  if (changedCount > 0) {
    html += '<div class="sum-section">';
    html += '<div class="sum-section-title">Files Changed (' + changedCount + ')</div>';
    html += '<div class="sum-file-list">';
    var changedKeys = Object.keys(changedFiles).sort();
    var MAX_FILES_VISIBLE = 5;
    changedKeys.forEach(function(fp, idx) {
      var hidden = idx >= MAX_FILES_VISIBLE && changedCount > MAX_FILES_VISIBLE ? ' style="display:none" data-extra-file="1"' : '';
      var badge = changedFiles[fp] === 'write' ? 'write' : 'edit';
      var label = badge === 'write' ? 'NEW' : 'EDIT';
      html += '<div class="sum-file-item"' + hidden + '><span class="file-badge ' + badge + '">' + label + '</span><span class="file-path" title="' + e(fp) + '">' + e(shortPath(fp)) + '</span></div>';
      // Show diff preview if available (only for first 5 files)
      var preview = changedFilePreviews[fp];
      if (preview && idx < MAX_FILES_VISIBLE) {
        html += '<div class="sum-diff-preview"' + hidden + '><pre>' + e(preview.length > 300 ? preview.slice(0, 300) + '...' : preview) + '</pre></div>';
      }
    });
    if (changedCount > MAX_FILES_VISIBLE) {
      html += '<div class="sum-prompt-toggle" style="margin-top:6px;font-size:12px;color:var(--primary);cursor:pointer" onclick="var extras=this.parentElement.querySelectorAll(\\x27[data-extra-file]\\x27);var show=extras[0]&&extras[0].style.display===\\x27none\\x27;extras.forEach(function(el){el.style.display=show?\\x27\\x27:\\x27none\\x27});this.textContent=show?\\x27Show fewer\\x27:\\x27Show all ' + changedCount + ' files\\x27">Show all ' + changedCount + ' files</div>';
    }
    html += '</div></div>';
  }

  // ---- 2.5. OUTCOMES: What was the result? ----
  html += '<div class="sum-section">';
  html += '<div class="sum-section-title">Outcome</div>';
  html += '<div class="sum-outcomes">';

  if (s.status === 'error' || s.status === 'crashed') {
    html += '<div class="sum-outcome-item" style="border-left-color:var(--red)"><span style="color:var(--red)">\\u2718</span> Session ' + e(s.status) + (s.error ? ': ' + e(s.error.slice(0, 200)) : '') + '</div>';
  } else if (cmdOutcomes.length > 0) {
    // Deduplicate by command — group identical commands
    var outcomeMap = {};
    cmdOutcomes.forEach(function(o) {
      var key = o.command;
      if (!outcomeMap[key]) {
        outcomeMap[key] = { command: o.command, result: o.result, status: o.status, spanId: o.spanId, count: 0 };
      }
      outcomeMap[key].count++;
      if (o.status === 'error') outcomeMap[key].status = 'error';
      if (o.spanId) outcomeMap[key].spanId = o.spanId;
      // Keep the most informative result text
      if (o.result.length > outcomeMap[key].result.length) outcomeMap[key].result = o.result;
    });
    Object.keys(outcomeMap).forEach(function(key) {
      var entry = outcomeMap[key];
      var icon = entry.status === 'error' ? '\\u2718' : '\\u2714';
      var color = entry.status === 'error' ? 'var(--red)' : 'var(--green)';
      var cmdLabel = entry.command.length > 60 ? entry.command.slice(0, 60) + '...' : entry.command;
      var countLabel = entry.count > 1 ? ' (' + entry.count + 'x)' : '';
      var spanLink = entry.spanId ? ' data-goto-span="' + e(entry.spanId) + '"' : '';
      html += '<div class="sum-outcome-item" style="border-left-color:' + color + ';cursor:pointer"' + spanLink + ' onclick="gotoSpan(this)">';
      html += '<span style="color:' + color + '">' + icon + '</span> ';
      html += '<code style="font-size:12px;color:var(--cyan)">' + e(cmdLabel) + e(countLabel) + '</code>';
      if (entry.result) html += '<span style="color:var(--dim);font-size:11px;margin-left:8px">' + e(entry.result) + '</span>';
      html += '</div>';
    });
  } else if (errSpans.length > 0) {
    html += '<div class="sum-outcome-item" style="border-left-color:var(--orange)"><span style="color:var(--orange)">\\u26A0</span> Completed with ' + errSpans.length + ' error(s)</div>';
  } else {
    html += '<div class="sum-outcome-item" style="border-left-color:var(--green)"><span style="color:var(--green)">\\u2714</span> Completed successfully</div>';
  }

  html += '</div></div>';

  // ---- 3. WHAT HAPPENED: Narrative timeline ----
  html += '<div class="sum-section">';
  html += '<div class="sum-section-title">What happened</div>';

  // Smart narrative that describes what was accomplished
  var smartNarrative = '';
  if (changedCount > 0) {
    var fileNames = Object.keys(changedFiles).map(function(fp) { return shortPath(fp); });
    if (changedCount <= 3) {
      smartNarrative += (changedCount === 1 ? 'Modified ' : 'Modified ') + fileNames.join(', ') + '. ';
    } else {
      smartNarrative += 'Modified ' + changedCount + ' files. ';
    }
  }
  var readCount = Object.keys(readFiles).length;
  if (readCount > 0) {
    smartNarrative += 'Read ' + readCount + ' file' + (readCount > 1 ? 's' : '') + ' for context. ';
  }
  if (dbtOps.length > 0) {
    smartNarrative += 'Ran ' + dbtOps.length + ' dbt command' + (dbtOps.length > 1 ? 's' : '') + '. ';
  }
  if (sqlQueries.length > 0) {
    smartNarrative += 'Executed ' + sqlQueries.length + ' SQL quer' + (sqlQueries.length > 1 ? 'ies' : 'y') + '. ';
  }
  var testOutcomes = cmdOutcomes.filter(function(o) { return o.result && /pass|fail|test/i.test(o.result); });
  if (testOutcomes.length > 0) {
    smartNarrative += testOutcomes.map(function(t) { return t.result; }).join('. ') + '. ';
  }
  if (errSpans.length > 0) {
    smartNarrative += errSpans.length + ' error' + (errSpans.length > 1 ? 's' : '') + ' encountered and ' + (s.status === 'completed' ? 'resolved' : 'unresolved') + '. ';
  }
  smartNarrative += 'Duration: ' + fd(s.duration) + ', Cost: ' + fc(s.totalCost) + '.';

  html += '<div class="sum-narrative">' + e(smartNarrative) + '</div>';

  // Build a meaningful chronological timeline
  var timelineEvents = [];

  // Collect file reads as grouped events
  var readFileList = Object.keys(readFiles);
  if (readFileList.length > 0) {
    var readLabel = readFileList.length <= 3
      ? 'Read ' + readFileList.map(function(f) { return shortPath(f); }).join(', ')
      : 'Read ' + readFileList.length + ' files to understand the codebase';
    timelineEvents.push({ type: 'tool', text: readLabel, time: 0 });
  }

  // File changes as individual timeline items
  Object.keys(changedFiles).forEach(function(fp) {
    var action = changedFiles[fp] === 'write' ? 'Created' : 'Modified';
    timelineEvents.push({ type: 'tool', text: action + ' ' + shortPath(fp), time: 0 });
  });

  // Shell commands (non-dbt) — group boring commands, show meaningful ones
  var boringCount = 0;
  var meaningfulCmds = [];
  bashCmds.forEach(function(cmd) {
    if (cmd.isDbt) return;
    // Use the meaningful part of the command (after cd &&)
    var c = (cmd.displayCommand || cmd.command).trim();
    var cLower = c.toLowerCase();
    // Boring: ls, cd, cat, head, tail, echo, pwd, which, wc, file
    var isBoring = /^(ls|cd|cat|head|tail|echo|pwd|which|wc|file|mkdir|test|\\[)\\b/.test(cLower)
      || /^(find|stat|du|df|touch|chmod)\\b/.test(cLower);
    if (isBoring) {
      boringCount++;
    } else {
      meaningfulCmds.push(cmd);
    }
  });

  // Deduplicate meaningful commands — group identical ones
  var dedupedCmds = [];
  var cmdSeen = {};
  meaningfulCmds.forEach(function(cmd) {
    // Normalize: take first 60 chars of displayCommand as key
    var key = (cmd.displayCommand || cmd.command).trim().slice(0, 60);
    if (cmdSeen[key]) {
      cmdSeen[key].count++;
      if (cmd.status === 'error') cmdSeen[key].hasError = true;
    } else {
      cmdSeen[key] = { cmd: cmd, count: 1, hasError: cmd.status === 'error' };
      dedupedCmds.push(cmdSeen[key]);
    }
  });
  if (boringCount > 0) {
    timelineEvents.push({ type: 'tool', text: 'Explored codebase (' + boringCount + ' commands: ls, cat, etc.)', time: 0 });
  }
  dedupedCmds.forEach(function(entry) {
    var display = entry.cmd.displayCommand || entry.cmd.command;
    var cmdText = display.length > 80 ? display.slice(0, 80) + '...' : display;
    var statusIcon = entry.hasError ? ' \\u2718 failed' : ' \\u2714';
    var countLabel = entry.count > 1 ? ' (' + entry.count + 'x)' : '';
    timelineEvents.push({ type: 'cmd', text: 'Ran: ' + cmdText + countLabel + statusIcon, time: entry.cmd.span.startTime || 0 });
  });

  // dbt operations — deduplicate similar commands
  if (dbtOps.length > 0) {
    var dbtCmdCounts = {};
    var dbtErrors = 0;
    dbtOps.forEach(function(op) {
      // Normalize: strip paths, keep just the dbt command
      var normalized = op.command.replace(/^.*?(dbt\\s)/i, '$1').trim();
      if (normalized.length > 60) normalized = normalized.slice(0, 60) + '...';
      dbtCmdCounts[normalized] = (dbtCmdCounts[normalized] || 0) + 1;
      if (op.status === 'error') dbtErrors++;
    });
    Object.keys(dbtCmdCounts).forEach(function(cmd) {
      var count = dbtCmdCounts[cmd];
      var text = count > 1 ? cmd + ' (' + count + 'x)' : cmd;
      var icon = dbtErrors > 0 ? ' \\u26A0' : ' \\u2714';
      timelineEvents.push({ type: 'dbt', text: text + icon, time: 0 });
    });
  }

  // SQL queries
  if (sqlQueries.length > 0) {
    if (sqlQueries.length <= 3) {
      sqlQueries.forEach(function(sq) {
        var qText = sq.query.length > 80 ? sq.query.slice(0, 80) + '...' : sq.query;
        timelineEvents.push({ type: 'sql', text: 'SQL: ' + qText, time: sq.span.startTime || 0 });
      });
    } else {
      timelineEvents.push({ type: 'sql', text: 'Ran ' + sqlQueries.length + ' SQL queries', time: 0 });
    }
  }

  // Other tool groups
  Object.keys(otherTools).forEach(function(name) {
    var count = otherTools[name].length;
    timelineEvents.push({ type: 'tool', text: 'Used ' + name + ' ' + count + ' time' + (count > 1 ? 's' : ''), time: 0 });
  });

  // Errors with resolution tracking — sort spans once for temporal resolution search
  var sortedForResolution = nonSession.slice().sort(function(a, b) { return (a.startTime || 0) - (b.startTime || 0); });
  errSpans.forEach(function(errSp) {
    var errName = errSp.name || 'unknown tool';
    var errMsg = errSp.statusMessage || '';
    if (!errMsg && errSp.output) {
      var outObj = errSp.output;
      if (typeof outObj === 'object' && outObj !== null) {
        errMsg = outObj.error || outObj.message || '';
      } else if (typeof outObj === 'string') {
        errMsg = outObj.slice(0, 200);
      }
    }
    var errText = 'Error in ' + errName;
    if (errMsg) errText += ': ' + (errMsg.length > 100 ? errMsg.slice(0, 100) + '...' : errMsg);

    // Look for resolution: find the next successful span after this error (sorted by time)
    var errTime = errSp.endTime || errSp.startTime || 0;
    var resolved = false;
    for (var ri = 0; ri < sortedForResolution.length; ri++) {
      var candidate = sortedForResolution[ri];
      if ((candidate.startTime || 0) > errTime && candidate.status === 'ok' && candidate.kind === 'tool') {
        errText += ' \\u2192 Resolved with ' + (candidate.name || 'next action');
        resolved = true;
        break;
      }
    }
    timelineEvents.push({ type: resolved ? 'fix' : 'err', text: errText, time: errSp.startTime || 0 });
  });

  // Generation summary (de-emphasized)
  if (genSpans.length) {
    timelineEvents.push({ type: 'gen', text: genSpans.length + ' LLM generation' + (genSpans.length > 1 ? 's' : '') + ' using ' + e(model), time: 0 });
  }

  timelineEvents.sort(function(a, b) { return (a.time || 0) - (b.time || 0); });
  timelineEvents.forEach(function(item) {
    html += '<div class="sum-timeline-item"><div class="sum-timeline-dot ' + item.type + '"></div><div class="sum-timeline-text">' + e(item.text) + '</div></div>';
  });

  if (s.status === 'running') {
    html += '<div class="sum-timeline-item" style="opacity:0.6"><div class="sum-timeline-dot" style="background:var(--orange);animation:pulse 1.5s infinite"></div><div class="sum-timeline-text" style="color:var(--dim);font-style:italic">Agent is still working...</div></div>';
  }
  html += '</div>';

  // ---- 4. ERRORS: Full details ----
  if (errSpans.length > 0) {
    html += '<div class="sum-section">';
    html += '<div class="sum-section-title" style="color:var(--red)">Errors (' + errSpans.length + ')</div>';
    errSpans.forEach(function(errSp) {
      var errName = errSp.name || 'unknown';
      var errMsg = errSp.statusMessage || '';
      if (!errMsg && errSp.output) {
        var outObj = errSp.output;
        if (typeof outObj === 'object' && outObj !== null) {
          errMsg = outObj.error || outObj.message || JSON.stringify(outObj).slice(0, 500);
        } else if (typeof outObj === 'string') {
          errMsg = outObj.slice(0, 500);
        }
      }
      if (!errMsg) errMsg = 'No error details available';

      html += '<div class="sum-error-detail">';
      html += '<span class="err-tool">\\u2718 ' + e(errName) + '</span>';
      html += '<span class="err-time">' + relTime(errSp.startTime) + ' into session</span>';
      html += '<div class="err-message">' + e(errMsg) + '</div>';

      // Check for resolution
      var errTime = errSp.endTime || errSp.startTime || 0;
      for (var ri = 0; ri < nonSession.length; ri++) {
        var candidate = nonSession[ri];
        if ((candidate.startTime || 0) > errTime && candidate.status === 'ok' && candidate.kind === 'tool') {
          html += '<div class="err-resolution">\\u2714 Resolved: agent used ' + e(candidate.name || 'next action') + ' (' + relTime(candidate.startTime) + ')</div>';
          break;
        }
      }
      html += '</div>';
    });
    html += '</div>';
  }

  // ---- 5. WARNINGS: Loop detection ----
  if (s.loops && s.loops.length) {
    html += '<div class="sum-section">';
    html += '<div class="sum-loop-warning"><div class="warn-title">\\u26A0 Loop Detection</div>';
    s.loops.forEach(function(loop) {
      html += '<div class="warn-item"><strong>' + e(loop.tool) + '</strong> called ' + loop.count + ' times' + (loop.description ? ' &mdash; ' + e(loop.description) : '') + '</div>';
    });
    html += '</div></div>';
  }

  // ---- 6. COMMANDS RUN (only meaningful ones) ----
  if (dedupedCmds.length > 0) {
    var totalMeaningful = meaningfulCmds.length;
    html += '<div class="sum-section">';
    html += '<div class="sum-section-title">Commands Run (' + totalMeaningful + (boringCount > 0 ? ', ' + boringCount + ' exploration commands hidden' : '') + ')</div>';
    dedupedCmds.slice(0, 15).forEach(function(entry) {
      var statusColor = entry.hasError ? 'var(--red)' : 'var(--green)';
      var statusIcon = entry.hasError ? '\\u2718' : '\\u2714';
      var display = entry.cmd.displayCommand || entry.cmd.command;
      var cmdText = display.length > 120 ? display.slice(0, 120) + '...' : display;
      var countLabel = entry.count > 1 ? ' <span style="color:var(--dim)">(' + entry.count + 'x)</span>' : '';
      html += '<div class="sum-cmd-item"><span class="cmd-prefix">$</span><span class="cmd-text">' + e(cmdText) + countLabel + '</span><span class="cmd-status" style="color:' + statusColor + '">' + statusIcon + '</span></div>';
    });
    if (dedupedCmds.length > 15) {
      html += '<div style="color:var(--dim);font-size:12px;padding:4px 10px">...and ' + (dedupedCmds.length - 15) + ' more</div>';
    }
    html += '</div>';
  } else if (boringCount > 0) {
    html += '<div class="sum-section">';
    html += '<div class="sum-section-title">Commands Run</div>';
    html += '<div style="color:var(--dim);font-size:13px;padding:4px 0">' + boringCount + ' exploration commands (ls, cd, cat, etc.)</div>';
    html += '</div>';
  }

  // ---- 7. FILES READ ----
  if (readFileList.length > 0) {
    html += '<div class="sum-section">';
    html += '<div class="sum-section-title">Files Read (' + readFileList.length + ')</div>';
    html += '<div class="sum-file-list">';
    readFileList.sort().slice(0, 30).forEach(function(fp) {
      html += '<div class="sum-file-item"><span class="file-badge read">READ</span><span class="file-path" title="' + e(fp) + '">' + e(shortPath(fp)) + '</span></div>';
    });
    if (readFileList.length > 30) {
      html += '<div style="color:var(--dim);font-size:12px;padding:4px 8px">...and ' + (readFileList.length - 30) + ' more</div>';
    }
    html += '</div></div>';
  }

  // ---- 8. COST DETAILS (collapsible) ----
  var totalTok = Number(tk.input||0) + Number(tk.output||0) + Number(tk.reasoning||0) + Number(tk.cacheRead||0) + Number(tk.cacheWrite||0);
  if (totalTok > 0) {
    html += "<div class=\\"sum-section sum-collapsible\\" onclick=\\"this.classList.toggle('open')\\">";
    html += '<div class="sum-section-title">Cost Details</div>';
    html += '<div class="sum-collapse-body">';

    // Metrics row
    html += '<div class="sum-metrics">';
    html += '<div class="sum-metric"><div class="val" style="color:var(--accent)">' + Number(s.totalTokens||0).toLocaleString() + '</div><div class="lbl">Total Tokens</div></div>';
    html += '<div class="sum-metric"><div class="val" style="color:var(--secondary)">' + Number(s.totalGenerations||0) + '</div><div class="lbl">Generations</div></div>';
    html += '<div class="sum-metric"><div class="val" style="color:var(--green)">' + Number(s.totalToolCalls||0) + '</div><div class="lbl">Tool Calls</div></div>';
    html += '</div>';

    // Token breakdown bar
    var pctIn = (Number(tk.input||0) / totalTok * 100).toFixed(1);
    var pctOut = (Number(tk.output||0) / totalTok * 100).toFixed(1);
    var pctReason = (Number(tk.reasoning||0) / totalTok * 100).toFixed(1);
    var pctCache = (Number(tk.cacheRead||0) / totalTok * 100).toFixed(1);
    html += '<div class="sum-cost-bar">';
    if (Number(pctIn) > 0) html += '<div style="width:' + pctIn + '%;background:var(--secondary)" title="Input: ' + pctIn + '%"></div>';
    if (Number(pctOut) > 0) html += '<div style="width:' + pctOut + '%;background:var(--green)" title="Output: ' + pctOut + '%"></div>';
    if (Number(pctReason) > 0) html += '<div style="width:' + pctReason + '%;background:var(--orange)" title="Reasoning: ' + pctReason + '%"></div>';
    if (Number(pctCache) > 0) html += '<div style="width:' + pctCache + '%;background:var(--cyan)" title="Cache: ' + pctCache + '%"></div>';
    html += '</div>';
    html += '<div class="sum-cost-legend">';
    html += '<span><span class="dot" style="background:var(--secondary)"></span>Input ' + Number(tk.input||0).toLocaleString() + ' (' + pctIn + '%)</span>';
    html += '<span><span class="dot" style="background:var(--green)"></span>Output ' + Number(tk.output||0).toLocaleString() + ' (' + pctOut + '%)</span>';
    if (Number(tk.reasoning||0) > 0) html += '<span><span class="dot" style="background:var(--orange)"></span>Reasoning ' + Number(tk.reasoning||0).toLocaleString() + ' (' + pctReason + '%)</span>';
    if (Number(tk.cacheRead||0) > 0) html += '<span><span class="dot" style="background:var(--cyan)"></span>Cache ' + Number(tk.cacheRead||0).toLocaleString() + ' (' + pctCache + '%)</span>';
    html += '</div>';

    // Top tools used
    var topTools = s.topTools;
    if (!topTools) {
      var toolCounts = {};
      toolSpans.forEach(function(sp) {
        var name = sp.name || 'unknown';
        toolCounts[name] = (toolCounts[name] || 0) + 1;
      });
      topTools = Object.keys(toolCounts).map(function(name) { return { name: name, count: toolCounts[name], totalDuration: 0 }; });
      topTools.sort(function(a, b) { return b.count - a.count; });
      topTools = topTools.slice(0, 10);
    }
    if (topTools && topTools.length) {
      html += '<div style="margin-top:16px"><div style="font-size:12px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Top Tools</div>';
      var maxCount = topTools[0].count || 1;
      topTools.forEach(function(tool) {
        var pct = (tool.count / maxCount * 100).toFixed(0);
        html += '<div class="sum-tool-bar-row">';
        html += '<div class="sum-tool-bar-name">' + e(tool.name) + '</div>';
        html += '<div class="sum-tool-bar-track"><div class="sum-tool-bar-fill" style="width:' + pct + '%"><span class="sum-tool-bar-count">' + tool.count + '</span></div></div>';
        html += '</div>';
      });
      html += '</div>';
    }

    html += '</div></div>';
  }

  el.innerHTML = html;
  } catch(err) { el.innerHTML = '<div style="color:var(--red);padding:20px">Summary rendering error: ' + (err.message || err) + '</div>'; console.error('[recap] Summary error:', err); }
})();

// ===================== WATERFALL VIEW =====================
(function() {
  var el = document.getElementById('v-waterfall');
  nonSession.forEach(function(span, idx) {
    var st = (span.startTime||0) - tStart;
    var dur = (span.endTime || Date.now()) - (span.startTime||0);
    var left = (st / tTotal * 100).toFixed(2);
    var width = Math.max(0.5, dur / tTotal * 100).toFixed(2);
    var cls = span.status === 'error' ? 'error' : e(span.kind);
    var row = document.createElement('div');
    row.className = 'wf-row';
    row.setAttribute('data-idx', String(idx));
    if (span.spanId) row.setAttribute('data-span-id', span.spanId);
    var iconCls = span.status === 'error' ? 'error' : e(span.kind);
    var pv = getPreview(span);
    row.innerHTML = '<div class="wf-icon ' + iconCls + '">' + (icons[span.kind]||'\\u2022') + '</div>' +
      '<div class="wf-info"><div class="wf-name">' + e(span.name) + '</div>' + (pv ? '<div class="wf-preview">' + pv + '</div>' : '') + '</div>' +
      '<div class="wf-bar-c"><div class="wf-bar ' + cls + '" style="left:'+left+'%;width:'+width+'%"><span class="wf-bar-label">' + fd(dur) + '</span></div></div>' +
      '<div class="wf-dur">' + fd(dur) + '</div>';
    el.appendChild(row);
  });
  el.addEventListener('click', function(ev) {
    var row = ev.target.closest ? ev.target.closest('.wf-row') : ev.target;
    if (!row || !row.dataset || row.dataset.idx == null) return;
    var span = nonSession[Number(row.dataset.idx)];
    if (!span) return;
    document.querySelectorAll('.wf-row').forEach(function(r){r.classList.remove('sel');});
    row.classList.add('sel');
    showDetail(span);
  });
})();

// ===================== TREE VIEW =====================
(function() {
  var el = document.getElementById('v-tree');
  var sessionSpan = spans.find(function(s){return s.kind==='session';});
  function buildTree(parentId) {
    var children = spans.filter(function(s){return s.parentSpanId===parentId && s.kind!=='session';});
    if (!children.length) return '';
    var html = '';
    children.forEach(function(span) {
      var idx = spans.indexOf(span);
      var dur = (span.endTime||Date.now()) - (span.startTime||0);
      var meta = [];
      meta.push(fd(dur));
      if (span.tokens) meta.push(Number(span.tokens.total||0) + ' tok');
      if (span.cost) meta.push(fc(span.cost));
      if (span.status === 'error') meta.push('<span style="color:var(--red)">error</span>');
      html += '<div class="tree-node"><div class="tree-item" data-idx="' + idx + '">';
      html += '<div class="tree-head">';
      html += '<span class="tree-type ' + e(span.kind) + '">' + e(span.kind) + '</span>';
      html += '<span class="tree-title">' + e(span.name) + '</span>';
      html += '</div>';
      var treePv = getPreview(span);
      if (treePv) html += '<div class="tree-preview">' + treePv + '</div>';
      html += '<div class="tree-meta">' + meta.join(' &middot; ') + '</div>';
      html += '</div>';
      html += buildTree(span.spanId);
      html += '</div>';
    });
    return html;
  }
  var rootId = sessionSpan ? sessionSpan.spanId : null;
  el.innerHTML = buildTree(rootId) || '<div style="color:var(--dim);padding:20px">No spans recorded yet.</div>';
  el.addEventListener('click', function(ev) {
    var item = ev.target.closest ? ev.target.closest('.tree-item') : null;
    if (!item || item.dataset.idx == null) return;
    var span = spans[Number(item.dataset.idx)];
    if (!span) return;
    document.querySelectorAll('.tree-item').forEach(function(el){el.classList.remove('sel');});
    item.classList.add('sel');
    showDetail(span);
  });
})();

// ===================== CHAT VIEW =====================
(function() {
  var el = document.getElementById('v-chat');
  var html = '';
  if (t.metadata.prompt) {
    html += '<div class="chat-msg user"><div class="chat-role">\\u25B6 You</div>';
    html += '<div class="chat-bubble">' + e(t.metadata.prompt) + '</div></div>';
  }
  var gens = spans.filter(function(s){return s.kind==='generation';});
  gens.forEach(function(gen) {
    var tools = spans.filter(function(s){return s.parentSpanId===gen.spanId && s.kind==='tool';});
    if (tools.length) {
      tools.forEach(function(tool) {
        html += '<div class="chat-tool' + (tool.status === 'error' ? ' err' : '') + '">';
        html += '<span class="tool-name">\\u2692 ' + e(tool.name) + '</span>';
        html += ' <span class="tool-dur">' + fd(tool.tool ? tool.tool.durationMs : 0) + '</span>';
        if (tool.status === 'error') html += ' <span style="color:var(--red)">\\u2718 error</span>';
        if (tool.input) {
          var inp = typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2);
          if (inp.length > 200) inp = inp.slice(0,200) + '...';
          html += '<pre>' + e(inp) + '</pre>';
        }
        html += '</div>';
      });
    }
    if (gen.output) {
      html += '<div class="chat-msg agent"><div class="chat-role">\\u2B50 ' + e(t.metadata.agent || 'Agent') + '</div>';
      html += '<div class="chat-bubble">' + e(String(gen.output)) + '</div>';
      var meta = [];
      if (gen.tokens) meta.push(Number(gen.tokens.total||0) + ' tokens');
      if (gen.cost) meta.push(fc(gen.cost));
      meta.push(fd((gen.endTime||0)-(gen.startTime||0)));
      html += '<div style="font-size:11px;color:var(--dim);margin-top:4px">' + meta.join(' &middot; ') + '</div>';
      html += '</div>';
    }
  });
  if (!html) html = '<div style="color:var(--dim);padding:20px">No conversation data yet.</div>';
  el.innerHTML = html;
})();

// ===================== LOG VIEW =====================
(function() {
  var el = document.getElementById('v-log');
  var html = '';
  var sorted = spans.slice().sort(function(a,b){return (a.startTime||0)-(b.startTime||0);});
  sorted.forEach(function(span) {
    if (span.kind === 'session') return;
    var idx = spans.indexOf(span);
    var ts = span.startTime ? new Date(span.startTime).toISOString().slice(11,23) : '';
    var kindCls = span.status === 'error' ? 'error' : e(span.kind);
    html += '<div class="log-entry" data-idx="' + idx + '">';
    html += '<span class="log-ts">' + ts + '</span>';
    var logIcon = span.kind === 'generation' ? '\\u2B50' : span.kind === 'tool' ? '\\u2692' : '\\u25A0';
    html += '<span class="log-kind ' + kindCls + '">' + logIcon + ' ' + e(span.kind||'') + '</span>';
    html += '<span class="log-name">' + e(span.name) + '</span>';
    if (span.kind === 'generation' && span.model && span.model.modelId) html += ' <span style="color:var(--secondary);font-size:11px;opacity:0.8">' + e(span.model.modelId) + '</span>';
    if (span.tokens) html += ' <span style="color:var(--dim);font-size:11px">' + Number(span.tokens.total||0) + ' tok</span>';
    if (span.cost) html += ' <span style="color:var(--orange);font-size:11px">' + fc(span.cost) + '</span>';
    if (span.tool && span.tool.durationMs != null) html += ' <span style="color:var(--dim);font-size:11px">' + fd(span.tool.durationMs) + '</span>';
    if (span.status === 'error') html += ' <span style="color:var(--red);font-size:11px">\\u2718 ' + e((span.statusMessage||'').slice(0,100)) + '</span>';
    if (span.kind === 'tool' && span.input) {
      var logPv = getPreview(span);
      if (logPv) html += '<div class="log-data" style="color:var(--cyan);opacity:0.7;max-height:none">' + logPv + '</div>';
    }
    if (span.output) {
      var out = typeof span.output === 'string' ? span.output : JSON.stringify(span.output);
      if (out.length > 300) out = out.slice(0,300) + '...';
      html += '<div class="log-data">' + e(out) + '</div>';
    }
    html += '</div>';
  });
  if (!html) html = '<div style="color:var(--dim);padding:20px">No log entries yet.</div>';
  el.innerHTML = html;
  el.addEventListener('click', function(ev) {
    var entry = ev.target.closest ? ev.target.closest('.log-entry') : null;
    if (!entry || entry.dataset.idx == null) return;
    var span = spans[Number(entry.dataset.idx)];
    if (!span) return;
    document.querySelectorAll('.log-entry').forEach(function(el){el.classList.remove('sel');});
    entry.classList.add('sel');
    showDetail(span);
  });
})();

// ===================== SHARE / EXPORT =====================
(function() {
  var toast = document.getElementById('toolbar-toast');
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(function() { toast.classList.remove('show'); }, 2500);
  }

  // Build markdown summary — self-contained, doesn't depend on Summary IIFE variables
  function buildMarkdownSummary() {
    var s = t.summary || {};
    var title = t.metadata.title || t.sessionId || 'Session';
    var lines = [];
    lines.push('## Recap: ' + title);
    lines.push('**Duration:** ' + fd(s.duration) + ' | **Cost:** ' + fc(s.totalCost) + ' | **Status:** ' + (s.status || 'unknown'));
    lines.push('');

    // Prompt
    if (t.metadata.prompt) {
      var promptLine = t.metadata.prompt.replace(/^["']+|["']+$/g, '').replace(/^#+\\s*/gm, '').trim().split('\\n').filter(function(l) { return l.trim().length > 5; })[0] || '';
      lines.push('### What was asked');
      lines.push('> ' + promptLine.slice(0, 200));
      lines.push('');
    }

    // Compute files from spans (independent of Summary IIFE)
    var mdChanged = {};
    var mdReadCount = 0;
    var mdDbtCount = 0;
    var mdSqlCount = 0;
    var mdErrCount = 0;
    var mdCmdCount = 0;
    nonSession.forEach(function(sp) {
      if (sp.kind !== 'tool') { if (sp.status === 'error') mdErrCount++; return; }
      var nm = (sp.name || '').toLowerCase();
      var inp = (sp.input && typeof sp.input === 'object') ? sp.input : {};
      var fp = inp.file_path || inp.filePath || inp.path || null;
      if (nm.indexOf('write') >= 0 || nm.indexOf('edit') >= 0) { if (fp) mdChanged[fp] = nm.indexOf('write') >= 0 ? 'new' : 'edited'; }
      else if (nm.indexOf('read') >= 0) { mdReadCount++; }
      else if (nm === 'bash') {
        var cmd = inp.command || '';
        var parts = cmd.split(/\\s*&&\\s*/);
        var last = parts[parts.length - 1].trim().toLowerCase();
        if (/\\bdbt\\s+/.test(last)) mdDbtCount++;
        else if (!/^(ls|cd|cat|head|tail|echo|pwd|which|wc|file|mkdir|test|find|stat)\\b/.test(last)) mdCmdCount++;
      }
      else if (nm.indexOf('sql') >= 0) mdSqlCount++;
      if (sp.status === 'error') mdErrCount++;
    });

    var mdChangedKeys = Object.keys(mdChanged);
    if (mdChangedKeys.length > 0) {
      lines.push('### Files changed');
      mdChangedKeys.forEach(function(fp) {
        var short = fp.split('/').slice(-3).join('/');
        lines.push('- ' + short + ' (' + mdChanged[fp] + ')');
      });
      lines.push('');
    }

    lines.push('### What happened');
    if (mdReadCount > 0) lines.push('- Read ' + mdReadCount + ' files for context');
    if (mdChangedKeys.length > 0) lines.push('- Modified ' + mdChangedKeys.length + ' file(s)');
    if (mdDbtCount > 0) lines.push('- Ran ' + mdDbtCount + ' dbt command(s)');
    if (mdSqlCount > 0) lines.push('- Executed ' + mdSqlCount + ' SQL query/queries');
    if (mdCmdCount > 0) lines.push('- Ran ' + mdCmdCount + ' shell command(s)');
    if (mdErrCount > 0) lines.push('- ' + mdErrCount + ' error(s) encountered');
    lines.push('');
    lines.push('---');
    lines.push('_Generated with [Altimate Code](https://altimate.ai/recap)_');
    return lines.join('\\n');
  }

  // Share Recap — download self-contained HTML
  document.getElementById('btn-share').addEventListener('click', function() {
    var html = document.documentElement.outerHTML;
    var blob = new Blob([html], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var title = (t.metadata.title || t.sessionId || 'recap').replace(/[^a-zA-Z0-9_-]/g, '_');
    a.href = url;
    a.download = 'altimate-recap-' + title + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('\\u2714 Recap downloaded!');
  });

  // Copy Summary — markdown to clipboard
  document.getElementById('btn-copy-summary').addEventListener('click', function() {
    var md = buildMarkdownSummary();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(function() {
        showToast('\\u2714 Summary copied to clipboard!');
      }).catch(function() {
        showToast('\\u2718 Failed to copy');
      });
    } else {
      // Fallback
      var ta = document.createElement('textarea');
      ta.value = md;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast('\\u2714 Summary copied!'); } catch(e) { showToast('\\u2718 Failed to copy'); }
      document.body.removeChild(ta);
    }
  });

  // Copy Link
  document.getElementById('btn-copy-link').addEventListener('click', function() {
    var url = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() {
        showToast('\\u2714 Link copied to clipboard!');
      }).catch(function() {
        showToast('\\u2718 Failed to copy');
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast('\\u2714 Link copied!'); } catch(e) { showToast('\\u2718 Failed to copy'); }
      document.body.removeChild(ta);
    }
  });
})();

// ===================== LIVE POLLING =====================
${live ? `
(function() {
  var lastUpdate = document.createElement('div');
  lastUpdate.className = 'live-updated';
  lastUpdate.textContent = '\\u2714 Updated';
  var liveBadge = document.querySelector('.live-badge');
  if (liveBadge) liveBadge.parentNode.insertBefore(lastUpdate, liveBadge.nextSibling);
  setInterval(function() {
    fetch('${apiPath}').then(function(r){return r.json();}).then(function(d) {
      if (!d || !d.spans) return;
      if (d.spans.length !== t.spans.length || (d.summary||{}).totalTokens !== (t.summary||{}).totalTokens || d.endedAt !== t.endedAt) {
        lastUpdate.classList.add('show');
        document.body.classList.add('live-flash');
        setTimeout(function() { document.body.classList.remove('live-flash'); lastUpdate.classList.remove('show'); }, 2000);
        setTimeout(function() { location.reload(); }, 600);
      }
    }).catch(function(){});
  }, 2000);
})();
` : ''}
</script>
</body>
</html>`
}
