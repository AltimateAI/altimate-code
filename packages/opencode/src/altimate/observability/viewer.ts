/**
 * Trace viewer HTML renderer.
 *
 * Generates a self-contained HTML page with 4 visualization modes:
 *   1. Waterfall — Gantt-style timeline bars (Datadog/Jaeger-style)
 *   2. Tree — nested indentation with expandable detail (Langfuse-style)
 *   3. Chat — conversation flow with user/agent messages (LangSmith-style)
 *   4. Log — flat scrollable list, Ctrl+F searchable (Langfuse Log View)
 *
 * All modes share a common summary header with metrics cards.
 * Branded with Altimate colors.
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
<title>Altimate Trace</title>
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
.logo-mark { width: 28px; height: 28px; background: var(--primary); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 16px; color: var(--bg); }
.logo-text { font-size: 18px; font-weight: 700; }
.logo-text span { color: var(--primary); }
.tags { display: flex; gap: 8px; flex-wrap: wrap; }
.tag { background: var(--s1); border: 1px solid var(--border); padding: 2px 10px; border-radius: 12px; font-size: 12px; color: var(--dim); }
.tag strong { color: var(--text); }

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
.content { padding: 16px 24px; max-height: calc(100vh - 260px); overflow-y: auto; }
.content::-webkit-scrollbar { width: 8px; }
.content::-webkit-scrollbar-track { background: var(--bg); }
.content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.content::-webkit-scrollbar-thumb:hover { background: var(--border-a); }
.view { display: none; }
.view.active { display: block; }

/* ---- Waterfall View ---- */
.wf-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--border); cursor: pointer; position: relative; z-index: 1; }
.wf-row > * { pointer-events: none; }
.wf-row:hover { background: var(--s1); }
.wf-row.sel { background: var(--s2); }
.wf-icon { width: 22px; height: 22px; text-align: center; font-size: 11px; flex-shrink: 0; border-radius: 4px; line-height: 22px; }
.wf-icon.generation { background: rgba(77,142,255,0.15); color: var(--secondary); }
.wf-icon.tool { background: rgba(34,211,238,0.12); color: var(--cyan); }
.wf-icon.error { background: rgba(248,113,113,0.15); color: var(--red); }
.wf-name { font-size: 13px; font-weight: 500; width: 200px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.log-entry { padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; font-family: 'JetBrains Mono', 'Fira Code', monospace; }
.log-entry:hover { background: var(--s1); }
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
.footer { padding: 16px 24px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); text-align: center; margin-top: 24px; }

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
  <div class="logo"><div class="logo-mark">A</div><div class="logo-text"><span>Altimate</span> Trace</div></div>
  <div class="tags" id="tags"></div>
</div>
<div id="prompt-area"></div>
<div class="cards" id="cards"></div>
<div class="tabs" id="tabs">
  <div class="tab active" data-view="waterfall">Waterfall</div>
  <div class="tab" data-view="tree">Tree</div>
  <div class="tab" data-view="chat">Chat</div>
  <div class="tab" data-view="log">Log</div>
</div>
<div class="content">
  <div class="view active" id="v-waterfall"></div>
  <div class="view" id="v-tree"></div>
  <div class="view" id="v-chat"></div>
  <div class="view" id="v-log"></div>
</div>
<div id="detail"></div>
<div class="footer">Powered by <span style="color:var(--primary);font-weight:600">Altimate</span> &mdash; altimate.ai</div>

<script>
var t = ${traceJSON};
var e = function(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;'); };
var fd = function(ms) { if (!ms && ms !== 0) return '-'; ms = Math.abs(ms); if (ms < 1000) return ms + 'ms'; if (ms < 60000) return (ms/1000).toFixed(1) + 's'; return Math.floor(ms/60000) + 'm' + Math.floor((ms%60000)/1000) + 's'; };
var fc = function(c) { if (c == null || isNaN(c)) return '$0'; return c < 0.01 ? '$' + c.toFixed(4) : '$' + c.toFixed(2); };
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
  document.getElementById('prompt-area').innerHTML = '<div class="prompt-box"><div class="lbl">Prompt</div><div>' + e(t.metadata.prompt) + '</div></div>';
}

// --- Summary cards ---
var s = t.summary || {}, tk = s.tokens || {};
var cardsData = [
  ['Duration', fd(s.duration), 'primary', true], ['Input', Number(tk.input||0).toLocaleString(), 'accent', Number(tk.input||0) > 0],
  ['Output', Number(tk.output||0).toLocaleString(), 'accent', Number(tk.output||0) > 0], ['Cache', Number(tk.cacheRead||0).toLocaleString(), 'cyan', Number(tk.cacheRead||0) > 0],
  ['Reasoning', Number(tk.reasoning||0).toLocaleString(), 'accent', Number(tk.reasoning||0) > 0], ['Total', Number(s.totalTokens||0).toLocaleString(), 'accent', true],
  ['Cost', fc(s.totalCost), 'orange', true], ['Gens', Number(s.totalGenerations||0), 'secondary', true],
  ['Tools', Number(s.totalToolCalls||0), 'green', true]
];
document.getElementById('cards').innerHTML = cardsData.filter(function(c) { return c[3]; }).map(function(c) {
  return '<div class="card"><div class="lbl">' + c[0] + '</div><div class="val" style="color:var(--' + c[2] + ')">' + c[1] + '</div></div>';
}).join('');

// --- Tab switching ---
document.getElementById('tabs').addEventListener('click', function(ev) {
  var view = ev.target.dataset.view; if (!view) return;
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
  ev.target.classList.add('active');
  document.getElementById('v-' + view).classList.add('active');
  document.getElementById('detail').innerHTML = '';
});

// --- Timing helpers ---
var tStart = spans.length ? Math.min.apply(null, spans.map(function(s) { return s.startTime || 0; })) : 0;
var tEnd = spans.length ? Math.max.apply(null, spans.map(function(s) { return s.endTime || s.startTime || Date.now(); })) : 1;
var tTotal = tEnd - tStart || 1;
var icons = { session: '\\u25A0', generation: '\\u2B50', tool: '\\u2692', text: '\\u270E' };

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

// ===================== WATERFALL VIEW =====================
(function() {
  var el = document.getElementById('v-waterfall');
  nonSession.forEach(function(span) {
    var st = (span.startTime||0) - tStart;
    var dur = (span.endTime || Date.now()) - (span.startTime||0);
    var left = (st / tTotal * 100).toFixed(2);
    var width = Math.max(0.5, dur / tTotal * 100).toFixed(2);
    var cls = span.status === 'error' ? 'error' : e(span.kind);
    var row = document.createElement('div');
    row.className = 'wf-row';
    var iconCls = span.status === 'error' ? 'error' : e(span.kind);
    row.innerHTML = '<div class="wf-icon ' + iconCls + '">' + (icons[span.kind]||'\\u2022') + '</div>' +
      '<div class="wf-name">' + e(span.name) + '</div>' +
      '<div class="wf-bar-c"><div class="wf-bar ' + cls + '" style="left:'+left+'%;width:'+width+'%"><span class="wf-bar-label">' + fd(dur) + '</span></div></div>' +
      '<div class="wf-dur">' + fd(dur) + '</div>';
    row.onclick = function() {
      document.querySelectorAll('.wf-row').forEach(function(r){r.classList.remove('sel');});
      row.classList.add('sel');
      showDetail(span);
    };
    el.appendChild(row);
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
      var dur = (span.endTime||Date.now()) - (span.startTime||0);
      var meta = [];
      meta.push(fd(dur));
      if (span.tokens) meta.push(Number(span.tokens.total||0) + ' tok');
      if (span.cost) meta.push(fc(span.cost));
      if (span.status === 'error') meta.push('<span style="color:var(--red)">error</span>');
      html += '<div class="tree-node"><div class="tree-item" data-sid="' + e(span.spanId) + '">';
      html += '<div class="tree-head">';
      html += '<span class="tree-type ' + e(span.kind) + '">' + e(span.kind) + '</span>';
      html += '<span class="tree-title">' + e(span.name) + '</span>';
      html += '</div>';
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
    var item = ev.target.closest('.tree-item');
    if (!item) return;
    var sid = item.dataset.sid;
    var span = spans.find(function(s){return s.spanId===sid;});
    if (!span) return;
    document.querySelectorAll('.tree-item').forEach(function(i){i.classList.remove('sel');});
    item.classList.add('sel');
    showDetail(span);
  });
})();

// ===================== CHAT VIEW =====================
(function() {
  var el = document.getElementById('v-chat');
  var html = '';
  // Show user prompt
  if (t.metadata.prompt) {
    html += '<div class="chat-msg user"><div class="chat-role">\\u25B6 You</div>';
    html += '<div class="chat-bubble">' + e(t.metadata.prompt) + '</div></div>';
  }
  // Group spans by generation
  var gens = spans.filter(function(s){return s.kind==='generation';});
  gens.forEach(function(gen) {
    // Tool calls under this generation
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
    // Agent response
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
  // Sort all spans by startTime
  var sorted = spans.slice().sort(function(a,b){return (a.startTime||0)-(b.startTime||0);});
  sorted.forEach(function(span) {
    if (span.kind === 'session') return;
    var ts = span.startTime ? new Date(span.startTime).toISOString().slice(11,23) : '';
    var kindCls = span.status === 'error' ? 'error' : e(span.kind);
    html += '<div class="log-entry">';
    html += '<span class="log-ts">' + ts + '</span>';
    var logIcon = span.kind === 'generation' ? '\\u2B50' : span.kind === 'tool' ? '\\u2692' : '\\u25A0';
    html += '<span class="log-kind ' + kindCls + '">' + logIcon + ' ' + e(span.kind||'') + '</span>';
    html += '<span class="log-name">' + e(span.name) + '</span>';
    if (span.tokens) html += ' <span style="color:var(--dim);font-size:11px">' + Number(span.tokens.total||0) + ' tok</span>';
    if (span.cost) html += ' <span style="color:var(--orange);font-size:11px">' + fc(span.cost) + '</span>';
    if (span.tool && span.tool.durationMs != null) html += ' <span style="color:var(--dim);font-size:11px">' + fd(span.tool.durationMs) + '</span>';
    if (span.status === 'error') html += ' <span style="color:var(--red);font-size:11px">\\u2718 ' + e((span.statusMessage||'').slice(0,100)) + '</span>';
    // Show input/output preview
    if (span.output) {
      var out = typeof span.output === 'string' ? span.output : JSON.stringify(span.output);
      if (out.length > 300) out = out.slice(0,300) + '...';
      html += '<div class="log-data">' + e(out) + '</div>';
    }
    html += '</div>';
  });
  if (!html) html = '<div style="color:var(--dim);padding:20px">No log entries yet.</div>';
  el.innerHTML = html;
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
