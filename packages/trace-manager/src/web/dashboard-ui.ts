export function renderDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trace Manager — Altimate Code</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
body{font-family:'Inter',system-ui,sans-serif}
.card{transition:transform .15s,box-shadow .15s}.card:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.08)}
.bar{transition:width .6s ease}
tr.clickable{cursor:pointer}tr.clickable:hover{background:#f9fafb}
.heatmap-cell{border-radius:2px}
.graph-node{cursor:pointer}.graph-link{stroke:#94a3b8;stroke-opacity:.6}
.tooltip{position:absolute;background:#1f2937;color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;pointer-events:none;z-index:50}
.sev-critical{background:#fef2f2;border-color:#fca5a5;color:#991b1b}
.sev-high{background:#fff7ed;border-color:#fdba74;color:#9a3412}
.sev-warning{background:#fffbeb;border-color:#fcd34d;color:#92400e}
.sev-medium{background:#fffbeb;border-color:#fcd34d;color:#92400e}
.sev-info{background:#eff6ff;border-color:#93c5fd;color:#1e40af}
.sev-low{background:#f0fdf4;border-color:#86efac;color:#166534}
.sev-positive{background:#f0fdf4;border-color:#86efac;color:#166534}
.sev-badge{padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;text-transform:uppercase}
.sev-badge-critical{background:#fee2e2;color:#991b1b}.sev-badge-high{background:#ffedd5;color:#9a3412}
.sev-badge-warning{background:#fef3c7;color:#92400e}.sev-badge-medium{background:#fef3c7;color:#92400e}
.sev-badge-info{background:#dbeafe;color:#1e40af}.sev-badge-low{background:#dcfce7;color:#166534}
.sev-badge-positive{background:#dcfce7;color:#166534}
.topic-tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;background:#e0e7ff;color:#3730a3;margin-right:4px}
.timeline-bar{height:20px;border-radius:4px;position:absolute;min-width:2px;opacity:0.85}
.timeline-bar:hover{opacity:1;box-shadow:0 0 0 2px rgba(99,102,241,.5)}
.back-btn{cursor:pointer;display:inline-flex;align-items:center;gap:4px;color:#6366f1;font-size:13px;font-weight:500}
.back-btn:hover{color:#4f46e5}
</style>
</head>
<body class="bg-gray-50 min-h-screen">
<div class="flex min-h-screen">

<nav class="w-56 bg-gray-900 text-gray-300 flex flex-col flex-shrink-0 fixed h-full z-10">
  <div class="px-5 py-5 border-b border-gray-700">
    <h1 class="text-white text-lg font-bold tracking-tight">Trace Manager</h1>
    <p class="text-xs text-gray-500 mt-0.5">altimate-code</p>
  </div>
  <div class="flex-1 py-4 space-y-0.5" id="sidebar-nav"></div>
  <div class="px-5 py-4 border-t border-gray-700">
    <div id="lake-status" class="text-xs text-gray-500"></div>
    <p class="text-xs text-gray-600 mt-1">v0.1.0</p>
  </div>
</nav>

<main class="flex-1 ml-56 overflow-auto">
  <div class="max-w-6xl mx-auto px-6 py-6" id="main-content"></div>
</main>
</div>

<script>
const API=location.pathname.indexOf('/trace-manager')===0?'/trace-manager':'';
const PAGES=[
  {id:'dashboard',label:'Dashboard',icon:'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z'},
  {id:'traces',label:'Traces',icon:'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2'},
  {id:'insights',label:'Insights',icon:'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z'},
  {id:'issues',label:'Issues',icon:'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'},
  {id:'conversations',label:'Conversations',icon:'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z'},
  {id:'users',label:'Users',icon:'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z'},
  {id:'graph',label:'Knowledge Graph',icon:'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1'},
];

let currentPage='dashboard';
document.getElementById('sidebar-nav').innerHTML=PAGES.map(p=>
  '<a href="#" onclick="switchPage(\\''+p.id+'\\');return false" id="nav-'+p.id+'" class="flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-gray-800 hover:text-white transition nav-link'+(p.id==='dashboard'?' bg-gray-800 text-white':'')+'"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="'+p.icon+'"/></svg>'+p.label+'</a>'
).join('');

function switchPage(id){
  document.querySelectorAll('.nav-link').forEach(el=>{el.classList.remove('bg-gray-800','text-white');el.classList.add('text-gray-400')});
  const nav=document.getElementById('nav-'+id);if(nav){nav.classList.add('bg-gray-800','text-white');nav.classList.remove('text-gray-400')}
  currentPage=id;
  const loaders={dashboard:loadDashboard,traces:loadTraces,insights:loadInsights,issues:loadIssues,conversations:loadConversations,users:loadUsers,graph:()=>loadGraphPicker()};
  (loaders[id]||loaders.dashboard)();
}

// ── Helpers ──
const $=id=>document.getElementById(id);
const fmtD=ms=>{if(!ms||ms<=0)return'0s';if(ms<1000)return ms+'ms';if(ms<60000)return(ms/1000).toFixed(1)+'s';const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000);return m+'m'+(s?s+'s':'')};
const fmtC=c=>(!c||c===0)?'$0.00':c<.01?'$'+c.toFixed(4):'$'+c.toFixed(2);
const fmtT=n=>{if(!n)return'0';if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n)};
const fmtTime=iso=>{const d=Date.now()-new Date(iso).getTime();if(d<6e4)return'just now';if(d<36e5)return Math.floor(d/6e4)+'m ago';if(d<864e5)return Math.floor(d/36e5)+'h ago';return Math.floor(d/864e5)+'d ago'};
const fmtDate=iso=>{const d=new Date(iso);return(d.getMonth()+1).toString().padStart(2,'0')+'/'+d.getDate().toString().padStart(2,'0')+' '+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')};
const badge=s=>{const c={completed:'bg-green-100 text-green-700',ok:'bg-green-100 text-green-700',error:'bg-red-100 text-red-700',crashed:'bg-red-100 text-red-700',running:'bg-yellow-100 text-yellow-700'};return'<span class="px-2 py-0.5 rounded-full text-xs font-medium '+(c[s]||'bg-gray-100 text-gray-600')+'">'+s+'</span>'};
const mCard=(l,v,sub)=>'<div class="bg-white rounded-lg border p-4 card"><p class="text-xs font-medium text-gray-500 uppercase tracking-wide">'+l+'</p><p class="text-2xl font-bold text-gray-900 mt-1">'+v+'</p>'+(sub?'<p class="text-xs text-gray-400 mt-1">'+sub+'</p>':'')+'</div>';
const hBar=(items,max)=>{if(!items.length)return'<p class="text-sm text-gray-400">No data</p>';const mx=max||Math.max(...items.map(i=>i.value));return items.map(i=>{const pct=mx?Math.round(i.value/mx*100):0;return'<div class="flex items-center gap-3 mb-2"><span class="text-xs text-gray-600 w-28 text-right shrink-0">'+i.label+'</span><div class="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden"><div class="h-full rounded-full bar '+(i.color||'bg-indigo-500')+'" style="width:'+pct+'%"></div></div><span class="text-xs text-gray-500 w-20 shrink-0">'+i.display+'</span></div>'}).join('')};
const sevBadge=s=>'<span class="sev-badge sev-badge-'+s+'">'+s+'</span>';
const render=h=>{document.getElementById('main-content').innerHTML=h};

// ══════════════════════════════════════════════════════
// DASHBOARD — insights-driven, not just stats
// ══════════════════════════════════════════════════════
async function loadDashboard(){
  const[ov,insights]=await Promise.all([fetch(API+'/api/analytics/overview').then(r=>r.json()),fetch(API+'/api/insights').then(r=>r.json())]);
  let h='<h2 class="text-xl font-semibold text-gray-800 mb-5">Dashboard</h2>';
  h+='<div class="grid grid-cols-4 gap-4 mb-6">'+mCard('Sessions',ov.totalSessions)+mCard('Total Tokens',fmtT(ov.totalTokens))+mCard('Total Cost',fmtC(ov.totalCost))+mCard('Tool Calls',ov.totalTools.toLocaleString())+'</div>';

  // Insights section — the star of the show
  if(insights.length){
    h+='<div class="mb-6"><h3 class="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Key Insights</h3>';
    for(const ins of insights.slice(0,6)){
      h+='<div class="border rounded-lg p-4 mb-3 sev-'+ins.severity+' card"><div class="flex items-start justify-between">'
        +'<div class="flex-1"><div class="flex items-center gap-2 mb-1">'+sevBadge(ins.severity)+'<span class="text-xs font-medium text-gray-500">'+ins.category+'</span></div>'
        +'<p class="font-semibold text-sm">'+ins.title+'</p>'
        +'<p class="text-xs mt-1 opacity-80">'+ins.description+'</p>'
        +'<p class="text-xs mt-2 font-medium">Recommendation: <span class="font-normal">'+ins.recommendation+'</span></p>'
        +'</div>';
      if(ins.metric)h+='<div class="text-right ml-4 shrink-0"><p class="text-xs text-gray-500">'+ins.metric.label+'</p><p class="text-lg font-bold">'+ins.metric.value+'</p></div>';
      h+='</div></div>';
    }
    h+='</div>';
  }

  h+='<div class="grid grid-cols-2 gap-6">';
  h+='<div class="bg-white rounded-lg border p-5 card"><h3 class="text-sm font-medium text-gray-500 mb-3">Recent Sessions</h3>'+
    ov.recentSessions.map(s=>'<div class="flex items-center justify-between py-2 border-b border-gray-50 last:border-0 clickable" onclick="openTraceDetail(\\''+s.sessionId+'\\')"><div class="flex-1 min-w-0"><p class="text-sm font-medium text-gray-800 truncate">'+s.title+'</p><p class="text-xs text-gray-400">'+fmtD(s.duration)+'</p></div><div class="flex items-center gap-2">'+badge(s.status)+'<span class="text-xs text-gray-400">'+fmtTime(s.startedAt)+'</span></div></div>').join('')+'</div>';
  h+='<div class="bg-white rounded-lg border p-5 card"><h3 class="text-sm font-medium text-gray-500 mb-3">Cost by Model</h3>'+hBar(Object.entries(ov.costByModel).map(([m,c])=>({label:m.split('/').pop(),value:c,display:fmtC(c),color:'bg-indigo-500'})))+'</div>';
  h+='</div>';
  render(h);
}

// ══════════════════════════════════════════════════════
// TRACES — double-click opens detail
// ══════════════════════════════════════════════════════
async function loadTraces(){
  const[data,topics]=await Promise.all([fetch(API+'/api/traces').then(r=>r.json()),fetch(API+'/api/topics').then(r=>r.json())]);
  let h='<h2 class="text-xl font-semibold text-gray-800 mb-2">Traces</h2><p class="text-sm text-gray-500 mb-5">Double-click any row to open detailed review</p>';
  h+='<div class="flex gap-2 mb-4 flex-wrap">';
  h+='<button class="px-3 py-1 text-xs rounded-full bg-indigo-100 text-indigo-700 font-medium" onclick="loadTraces()">All ('+data.total+')</button>';
  for(const t of topics.slice(0,6))h+='<span class="topic-tag">'+t.topic+' ('+t.count+')</span>';
  h+='</div>';
  h+='<div class="bg-white rounded-lg border overflow-hidden"><table class="w-full text-sm"><thead><tr class="text-left text-xs text-gray-500 uppercase tracking-wide border-b bg-gray-50">'
    +'<th class="py-2.5 px-4">Date</th><th class="py-2.5 px-2">Status</th><th class="py-2.5 px-2">Duration</th>'
    +'<th class="py-2.5 px-2">Tokens</th><th class="py-2.5 px-2">Cost</th><th class="py-2.5 px-2">Tools</th><th class="py-2.5 px-2">Title</th></tr></thead><tbody>';
  for(const t of data.traces){
    const tools=(t.topTools||[]).map(tt=>tt.name+'('+tt.count+')').join(' ');
    h+='<tr class="clickable border-b border-gray-50" ondblclick="openTraceDetail(\\''+t.sessionId+'\\')"><td class="py-3 px-4 text-gray-500">'+fmtDate(t.startedAt)+'</td><td class="py-3 px-2">'+badge(t.status)+'</td><td class="py-3 px-2 text-gray-700 font-medium">'+fmtD(t.duration)+'</td><td class="py-3 px-2 text-gray-600">'+fmtT(t.totalTokens)+'</td><td class="py-3 px-2 text-gray-600">'+fmtC(t.totalCost)+'</td><td class="py-3 px-2 text-gray-500 text-xs">'+(tools||'-')+'</td><td class="py-3 px-2 text-gray-800 font-medium truncate max-w-xs">'+(t.title||t.sessionId)+'</td></tr>';
  }
  h+='</tbody></table></div>';
  render(h);
}

// ══════════════════════════════════════════════════════
// TRACE DETAIL — full review page
// ══════════════════════════════════════════════════════
async function openTraceDetail(sid){
  render('<p class="text-gray-400">Loading trace detail...</p>');
  const d=await fetch(API+'/api/traces/'+sid+'/detail').then(r=>r.json());
  let h='<div class="back-btn mb-4" onclick="switchPage(\\'traces\\')"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg> Back to Traces</div>';
  h+='<div class="flex items-start justify-between mb-5"><div><h2 class="text-xl font-semibold text-gray-800">'+(d.metadata.title||d.sessionId)+'</h2>';
  h+='<div class="flex items-center gap-2 mt-1">'+badge(d.summary.status);
  for(const t of d.topics)h+='<span class="topic-tag">'+t+'</span>';
  h+='<span class="text-xs text-gray-400">'+fmtDate(d.metadata.startedAt||d.summary.startedAt||'')+'</span></div>';
  h+='</div><div class="text-right">';
  h+='<button onclick="viewGraph(\\''+sid+'\\');return false" class="px-3 py-1.5 text-xs rounded bg-indigo-600 text-white hover:bg-indigo-700 mr-2">Knowledge Graph</button>';
  h+='<button onclick="viewPII(\\''+sid+'\\');return false" class="px-3 py-1.5 text-xs rounded bg-amber-600 text-white hover:bg-amber-700">PII Review</button>';
  h+='</div></div>';

  // Summary cards
  h+='<div class="grid grid-cols-5 gap-3 mb-6">';
  h+=mCard('Duration',fmtD(d.summary.duration));
  h+=mCard('Tokens',fmtT(d.summary.totalTokens),'in='+fmtT(d.summary.tokens?.input)+' out='+fmtT(d.summary.tokens?.output));
  h+=mCard('Cost',fmtC(d.summary.totalCost));
  h+=mCard('Tools',d.summary.totalToolCalls);
  h+=mCard('Generations',d.summary.totalGenerations);
  h+='</div>';

  // Narrative
  if(d.summary.narrative){
    h+='<div class="bg-white rounded-lg border p-4 mb-6"><h3 class="text-sm font-medium text-gray-500 mb-2">Narrative</h3><p class="text-sm text-gray-700 leading-relaxed">'+d.summary.narrative+'</p></div>';
  }

  // Alerts (loops, PII, errors)
  const alerts=[];
  if(d.summary.loops&&d.summary.loops.length)alerts.push({sev:'critical',msg:'Doom loop detected: '+d.summary.loops.map(l=>l.tool+' ('+l.count+'x)').join(', ')});
  if(d.piiCount>0)alerts.push({sev:'warning',msg:d.piiCount+' PII item(s) detected in this trace'});
  const errorSpans=d.spans.filter(s=>s.status==='error');
  if(errorSpans.length)alerts.push({sev:'high',msg:errorSpans.length+' tool error(s): '+errorSpans.map(s=>s.name).join(', ')});
  if(alerts.length){
    h+='<div class="mb-6 space-y-2">';
    for(const a of alerts)h+='<div class="border rounded-lg px-4 py-2.5 sev-'+a.sev+' text-sm flex items-center gap-2">'+sevBadge(a.sev)+a.msg+'</div>';
    h+='</div>';
  }

  // Timeline waterfall
  h+='<div class="bg-white rounded-lg border p-4 mb-6"><h3 class="text-sm font-medium text-gray-500 mb-3">Span Timeline</h3>';
  const validSpans=d.spans.filter(s=>s.startTime&&s.endTime);
  if(validSpans.length){
    const minTime=Math.min(...validSpans.map(s=>s.startTime));
    const maxTime=Math.max(...validSpans.map(s=>s.endTime));
    const totalRange=maxTime-minTime||1;
    const kindColors={session:'#6366f1',generation:'#3b82f6',tool:'#10b981',text:'#6b7280',span:'#a855f7'};
    h+='<div class="relative" style="height:'+(validSpans.length*28+10)+'px">';
    validSpans.forEach((s,i)=>{
      const left=((s.startTime-minTime)/totalRange*100).toFixed(2);
      const width=Math.max(0.5,((s.endTime-s.startTime)/totalRange*100)).toFixed(2);
      const color=kindColors[s.kind]||'#94a3b8';
      const errorBorder=s.status==='error'?'border:2px solid #ef4444;':'';
      h+='<div class="timeline-bar" style="top:'+(i*28)+'px;left:'+left+'%;width:'+width+'%;background:'+color+';'+errorBorder+'" title="'+s.name+' ('+s.kind+') '+fmtD(s.duration||0)+'"></div>';
      h+='<span class="absolute text-[10px] text-gray-500 truncate" style="top:'+(i*28+3)+'px;left:calc('+left+'% + '+width+'% + 6px);max-width:200px">'+s.name.slice(0,30)+(s.duration?' '+fmtD(s.duration):'')+'</span>';
    });
    h+='</div>';
    h+='<div class="flex gap-4 mt-3 text-xs text-gray-500">';
    Object.entries(kindColors).forEach(([k,c])=>h+='<div class="flex items-center gap-1"><div class="w-3 h-3 rounded" style="background:'+c+'"></div>'+k+'</div>');
    h+='</div>';
  } else h+='<p class="text-sm text-gray-400">No timing data available</p>';
  h+='</div>';

  // Spans table
  h+='<div class="bg-white rounded-lg border overflow-hidden"><h3 class="text-sm font-medium text-gray-500 p-4 pb-0">Spans ('+d.spans.length+')</h3>';
  h+='<table class="w-full text-xs mt-2"><thead><tr class="text-left text-xs text-gray-500 uppercase tracking-wide border-b bg-gray-50">'
    +'<th class="py-2 px-3">Kind</th><th class="py-2 px-3">Name</th><th class="py-2 px-3">Status</th><th class="py-2 px-3">Duration</th><th class="py-2 px-3">Tokens</th><th class="py-2 px-3">Preview</th></tr></thead><tbody>';
  for(const s of d.spans){
    const kindBg={generation:'bg-blue-50 text-blue-700',tool:'bg-green-50 text-green-700',session:'bg-indigo-50 text-indigo-700',text:'bg-gray-50 text-gray-600',span:'bg-purple-50 text-purple-700'};
    h+='<tr class="border-b border-gray-50 hover:bg-gray-50"><td class="py-2 px-3"><span class="px-1.5 py-0.5 rounded text-[10px] font-medium '+(kindBg[s.kind]||'bg-gray-100')+'">'+s.kind+'</span></td>'
      +'<td class="py-2 px-3 font-medium text-gray-700 truncate max-w-[200px]">'+s.name+'</td>'
      +'<td class="py-2 px-3">'+(s.status==='error'?'<span class="text-red-600 font-medium">error</span>':'<span class="text-green-600">ok</span>')+'</td>'
      +'<td class="py-2 px-3 text-gray-600">'+(s.duration?fmtD(s.duration):'-')+'</td>'
      +'<td class="py-2 px-3 text-gray-600">'+(s.tokens?fmtT((s.tokens.input||0)+(s.tokens.output||0)):'-')+'</td>'
      +'<td class="py-2 px-3 text-gray-400 truncate max-w-[300px]">'+(s.inputPreview||s.outputPreview||'-')+'</td></tr>';
  }
  h+='</tbody></table></div>';
  render(h);
}

// ══════════════════════════════════════════════════════
// INSIGHTS — actionable intelligence
// ══════════════════════════════════════════════════════
async function loadInsights(){
  const insights=await fetch(API+'/api/insights').then(r=>r.json());
  let h='<h2 class="text-xl font-semibold text-gray-800 mb-2">Insights</h2><p class="text-sm text-gray-500 mb-5">Actionable intelligence from your trace data — not just numbers</p>';
  if(!insights.length){h+='<div class="bg-green-50 border border-green-200 rounded-lg p-6 text-center"><p class="text-green-700 font-medium">No insights yet</p><p class="text-sm text-green-600 mt-1">Run more sessions to generate insights.</p></div>';render(h);return}

  const bySev={critical:[],warning:[],info:[],positive:[]};
  for(const i of insights)(bySev[i.severity]||bySev.info).push(i);

  for(const[sev,items] of Object.entries(bySev)){
    if(!items.length)continue;
    const label={critical:'Critical',warning:'Warnings',info:'Informational',positive:'Positive Signals'}[sev]||sev;
    h+='<h3 class="text-sm font-semibold text-gray-600 uppercase tracking-wide mt-6 mb-3">'+label+' ('+items.length+')</h3>';
    for(const ins of items){
      h+='<div class="border rounded-lg p-5 mb-3 sev-'+sev+' card"><div class="flex items-start justify-between">';
      h+='<div class="flex-1"><div class="flex items-center gap-2 mb-2">'+sevBadge(sev)+'<span class="text-xs font-medium text-gray-500 bg-white/60 px-2 py-0.5 rounded">'+ins.category+'</span></div>';
      h+='<p class="font-semibold text-sm mb-1">'+ins.title+'</p>';
      h+='<p class="text-xs opacity-80 mb-3">'+ins.description+'</p>';
      if(ins.evidence.length){
        h+='<details class="mb-2"><summary class="text-xs font-medium cursor-pointer hover:underline">Evidence ('+ins.evidence.length+')</summary><ul class="mt-1 text-xs opacity-70 space-y-0.5 ml-4 list-disc">';
        for(const e of ins.evidence.slice(0,5))h+='<li>'+e+'</li>';
        h+='</ul></details>';
      }
      h+='<div class="bg-white/50 rounded p-2 mt-2"><p class="text-xs"><span class="font-semibold">Recommendation:</span> '+ins.recommendation+'</p></div>';
      if(ins.affectedSessions.length)h+='<p class="text-[10px] text-gray-400 mt-2">Affects '+ins.affectedSessions.length+' session(s)</p>';
      h+='</div>';
      if(ins.metric)h+='<div class="text-right ml-6 shrink-0 bg-white/40 rounded-lg p-3"><p class="text-[10px] text-gray-500 uppercase tracking-wide">'+ins.metric.label+'</p><p class="text-xl font-bold mt-0.5">'+ins.metric.value+'</p>'+(ins.metric.trend?'<p class="text-xs">'+(ins.metric.trend==='up'?'↑':'↓')+'</p>':'')+'</div>';
      h+='</div></div>';
    }
  }
  render(h);
}

// ══════════════════════════════════════════════════════
// ISSUES — admin view of recurring problems
// ══════════════════════════════════════════════════════
async function loadIssues(){
  const data=await fetch(API+'/api/issues').then(r=>r.json());
  let h='<h2 class="text-xl font-semibold text-gray-800 mb-2">Issues</h2><p class="text-sm text-gray-500 mb-5">Frequently occurring problems across all users — auto-classified by severity</p>';

  if(!data.issues.length){h+='<div class="bg-green-50 border border-green-200 rounded-lg p-6 text-center"><p class="text-green-700 font-medium">No issues detected</p></div>';render(h);return}

  // Summary strip
  const counts={critical:0,high:0,medium:0,low:0};
  for(const iss of data.issues)counts[iss.severity]=(counts[iss.severity]||0)+1;
  h+='<div class="grid grid-cols-4 gap-3 mb-6">';
  h+='<div class="bg-red-50 border border-red-200 rounded-lg p-3 text-center"><p class="text-2xl font-bold text-red-700">'+counts.critical+'</p><p class="text-xs text-red-600">Critical</p></div>';
  h+='<div class="bg-orange-50 border border-orange-200 rounded-lg p-3 text-center"><p class="text-2xl font-bold text-orange-700">'+counts.high+'</p><p class="text-xs text-orange-600">High</p></div>';
  h+='<div class="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-center"><p class="text-2xl font-bold text-yellow-700">'+counts.medium+'</p><p class="text-xs text-yellow-600">Medium</p></div>';
  h+='<div class="bg-green-50 border border-green-200 rounded-lg p-3 text-center"><p class="text-2xl font-bold text-green-700">'+counts.low+'</p><p class="text-xs text-green-600">Low</p></div>';
  h+='</div>';

  for(const iss of data.issues){
    h+='<div class="border rounded-lg mb-4 overflow-hidden sev-'+iss.severity+'">';
    h+='<div class="p-4"><div class="flex items-start justify-between">';
    h+='<div class="flex-1"><div class="flex items-center gap-2 mb-1">'+sevBadge(iss.severity)+'<span class="topic-tag">'+iss.topic.replace('_',' ')+'</span><span class="text-xs text-gray-400">'+iss.frequency+' occurrence(s)</span></div>';
    h+='<p class="font-semibold text-sm">'+iss.title+'</p>';
    h+='<p class="text-xs opacity-80 mt-1">'+iss.description+'</p>';
    h+='</div>';
    h+='<div class="text-right ml-4 shrink-0"><p class="text-xs text-gray-500">Affected users</p><p class="text-lg font-bold">'+iss.affectedUsers.length+'</p><p class="text-[10px] text-gray-400">'+iss.affectedUsers.join(', ')+'</p></div>';
    h+='</div>';

    h+='<div class="bg-white/50 rounded p-3 mt-3"><p class="text-xs"><span class="font-semibold">Suggested fix:</span> '+iss.suggestedFix+'</p></div>';

    // Occurrences table
    if(iss.occurrences.length>0){
      h+='<details class="mt-3"><summary class="text-xs font-medium cursor-pointer hover:underline">Occurrences ('+iss.occurrences.length+')</summary>';
      h+='<table class="w-full text-xs mt-2"><thead><tr class="border-b"><th class="text-left py-1 pr-2">Session</th><th class="text-left py-1 pr-2">User</th><th class="text-left py-1 pr-2">When</th><th class="text-left py-1">Detail</th></tr></thead><tbody>';
      for(const occ of iss.occurrences.slice(0,10)){
        h+='<tr class="border-b border-gray-100 clickable" ondblclick="openTraceDetail(\\''+occ.sessionId+'\\')"><td class="py-1.5 pr-2 text-indigo-600 truncate max-w-[200px]">'+occ.sessionTitle+'</td><td class="py-1.5 pr-2 text-gray-600">'+occ.userId+'</td><td class="py-1.5 pr-2 text-gray-400">'+fmtTime(occ.timestamp)+'</td><td class="py-1.5 text-gray-500 truncate max-w-[250px]">'+occ.detail+'</td></tr>';
      }
      h+='</tbody></table></details>';
    }
    h+='<p class="text-[10px] text-gray-400 mt-2">First seen: '+fmtDate(iss.firstSeen)+' · Last seen: '+fmtDate(iss.lastSeen)+'</p>';
    h+='</div></div>';
  }
  render(h);
}

// ══════════════════════════════════════════════════════
// CONVERSATIONS
// ══════════════════════════════════════════════════════
async function loadConversations(){
  const d=await fetch(API+'/api/analytics/conversations').then(r=>r.json());
  let h='<h2 class="text-xl font-semibold text-gray-800 mb-5">Conversation Analytics</h2>';
  h+='<div class="grid grid-cols-4 gap-4 mb-6">'+mCard('Avg Turns',d.avgGenerations.toFixed(1),'generations/session')+mCard('Avg Duration',fmtD(d.avgDuration))+mCard('Avg Tokens',fmtT(d.avgTokens),'per session')+mCard('Success Rate',(d.successRate*100).toFixed(0)+'%',d.completedSessions+' of '+d.totalSessions)+'</div>';
  h+='<div class="grid grid-cols-2 gap-6 mb-6">';
  const td=d.turnDistribution,total=Object.values(td).reduce((a,b)=>a+b,0)||1;
  h+='<div class="bg-white rounded-lg border p-5 card"><h3 class="text-sm font-medium text-gray-500 mb-3">Turn Distribution</h3>'+hBar(Object.entries(td).map(([b,c])=>({label:b+' turns',value:c,display:c+' ('+Math.round(c/total*100)+'%)',color:b==='16+'?'bg-amber-500':'bg-indigo-500'})))+'</div>';
  h+='<div class="bg-white rounded-lg border p-5 card"><h3 class="text-sm font-medium text-gray-500 mb-3">Tool Chain Patterns</h3>'+(d.topChains.length?hBar(d.topChains.map(c=>({label:c.pattern,value:c.count,display:c.count+'x',color:'bg-violet-500'}))):'<p class="text-sm text-gray-400">Not enough data</p>')+'</div>';
  h+='</div>';
  h+='<div class="bg-white rounded-lg border p-5 card"><h3 class="text-sm font-medium text-gray-500 mb-3">Top Tools</h3>'+hBar(d.topTools.map(t=>({label:t.name,value:t.count,display:t.count+' ('+fmtD(t.totalDuration)+')',color:'bg-emerald-500'})))+'</div>';
  render(h);
}

// ══════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════
async function loadUsers(){
  const d=await fetch(API+'/api/analytics/users').then(r=>r.json());
  let h='<h2 class="text-xl font-semibold text-gray-800 mb-5">User Analytics</h2>';
  h+='<div class="grid grid-cols-4 gap-4 mb-6">'+mCard('Users',d.users.length)+mCard('Avg Sessions/User',d.users.length?(d.users.reduce((s,u)=>s+u.sessions,0)/d.users.length).toFixed(1):'0')+mCard('Avg Cost/User',d.users.length?fmtC(d.users.reduce((s,u)=>s+u.cost,0)/d.users.length):'$0')+mCard('Avg Success',d.users.length?(d.users.reduce((s,u)=>s+u.successRate,0)/d.users.length*100).toFixed(0)+'%':'0%')+'</div>';
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],maxH=Math.max(1,...d.heatmap.flat());
  let hm='<div class="overflow-x-auto"><table class="text-xs"><tr><td></td>'+Array.from({length:24},(_,i)=>'<td class="text-center text-gray-400 px-0.5 pb-1">'+(i%3===0?i:'')+'</td>').join('')+'</tr>';
  for(let i=0;i<7;i++){hm+='<tr><td class="text-right text-gray-500 pr-2 py-0.5">'+days[i]+'</td>';for(let j=0;j<24;j++){const v=d.heatmap[i][j],int=v/maxH,bg=v===0?'#f3f4f6':int<.33?'#c7d2fe':int<.66?'#818cf8':'#4f46e5';hm+='<td class="px-0.5 py-0.5"><div class="heatmap-cell w-4 h-4" style="background:'+bg+'" title="'+days[i]+' '+j+':00 — '+v+'"></div></td>'}hm+='</tr>'}
  hm+='</table></div>';
  h+='<div class="bg-white rounded-lg border p-5 card mb-6"><h3 class="text-sm font-medium text-gray-500 mb-3">Activity Heatmap</h3>'+hm+'</div>';
  h+='<div class="bg-white rounded-lg border p-5 card"><h3 class="text-sm font-medium text-gray-500 mb-3">User Breakdown</h3><table class="w-full text-sm"><thead><tr class="text-left text-xs text-gray-500 uppercase tracking-wide border-b"><th class="pb-2 pr-3">User</th><th class="pb-2 pr-3">Sessions</th><th class="pb-2 pr-3">Tokens</th><th class="pb-2 pr-3">Cost</th><th class="pb-2 pr-3">Success</th><th class="pb-2">Fav Tool</th></tr></thead><tbody>';
  for(const u of d.users)h+='<tr class="border-b border-gray-50"><td class="py-2.5 pr-3 font-medium text-gray-800">'+u.userId+'</td><td class="py-2.5 pr-3 text-gray-600">'+u.sessions+'</td><td class="py-2.5 pr-3 text-gray-600">'+fmtT(u.tokens)+'</td><td class="py-2.5 pr-3 text-gray-600">'+fmtC(u.cost)+'</td><td class="py-2.5 pr-3">'+(u.successRate*100).toFixed(0)+'%</td><td class="py-2.5 text-gray-500">'+u.topTool+'</td></tr>';
  h+='</tbody></table></div>';
  render(h);
}

// ══════════════════════════════════════════════════════
// PII REVIEW
// ══════════════════════════════════════════════════════
async function viewPII(sid){
  const[pii,trace]=await Promise.all([fetch(API+'/api/pii/preview/'+sid).then(r=>r.json()),fetch(API+'/api/traces/'+sid).then(r=>r.json())]);
  let h='<div class="back-btn mb-4" onclick="switchPage(\\'traces\\')"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg> Back</div>';
  h+='<h2 class="text-xl font-semibold text-gray-800 mb-5">PII Review — '+(trace.metadata?.title||sid)+'</h2>';
  if(!pii.findings.length){h+='<div class="bg-green-50 border border-green-200 rounded-lg p-4"><p class="text-green-700 font-medium">No PII detected</p></div>';render(h);return}
  h+='<div class="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4"><p class="text-amber-800 font-medium">'+pii.total+' PII item(s) detected</p></div>';
  h+='<div class="bg-white rounded-lg border divide-y">';
  for(const f of pii.findings){const ac={redact:'bg-red-100 text-red-700',hash:'bg-yellow-100 text-yellow-700',allow:'bg-green-100 text-green-700'};h+='<div class="p-4 flex items-center justify-between"><div><span class="text-xs font-medium uppercase tracking-wide text-gray-500">'+f.category+'</span><p class="text-sm text-gray-800 mt-1 font-mono">'+f.preview+'</p><p class="text-xs text-gray-400 mt-0.5">'+f.field+'</p></div><span class="px-2 py-1 rounded text-xs font-medium '+(ac[f.action]||'bg-gray-100')+'">'+f.action+'</span></div>'}
  h+='</div>';render(h);
}

// ══════════════════════════════════════════════════════
// KNOWLEDGE GRAPH
// ══════════════════════════════════════════════════════
let graphSim=null;
async function loadGraphPicker(){
  const data=await fetch(API+'/api/traces').then(r=>r.json());
  let h='<h2 class="text-xl font-semibold text-gray-800 mb-2">Knowledge Graph</h2><p class="text-sm text-gray-500 mb-5">Select a trace to visualize</p>';
  h+='<div class="grid grid-cols-2 gap-3">';
  for(const t of data.traces.slice(0,12)){
    h+='<div class="bg-white rounded-lg border p-4 card clickable" ondblclick="viewGraph(\\''+t.sessionId+'\\')"><div class="flex items-center justify-between"><div><p class="text-sm font-medium text-gray-800">'+(t.title||t.sessionId)+'</p><p class="text-xs text-gray-400">'+fmtD(t.duration)+' · '+t.totalToolCalls+' tools</p></div>'+badge(t.status)+'</div></div>';
  }
  h+='</div>';render(h);
}

async function viewGraph(sid){
  let h='<div class="back-btn mb-4" onclick="switchPage(\\'graph\\')"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg> Back</div>';
  h+='<h2 class="text-xl font-semibold text-gray-800 mb-2">Knowledge Graph</h2><p class="text-sm text-gray-500 mb-4">Session: '+sid.slice(0,24)+'...</p>';
  h+='<div class="flex gap-2 mb-4"><button onclick="renderGraphType(\\'spans\\',\\''+sid+'\\',this)" class="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white graph-tab">Span Tree</button><button onclick="renderGraphType(\\'dataflow\\',\\''+sid+'\\',this)" class="px-3 py-1.5 text-sm rounded bg-gray-200 text-gray-700 graph-tab">Data Flow</button><button onclick="renderGraphType(\\'entities\\',\\''+sid+'\\',this)" class="px-3 py-1.5 text-sm rounded bg-gray-200 text-gray-700 graph-tab">Entities</button></div>';
  h+='<div id="graph-container" class="bg-white rounded-lg border" style="height:500px"></div>';
  render(h);renderGraphType('spans',sid);
}

async function renderGraphType(type,sid,btn){
  if(btn){document.querySelectorAll('.graph-tab').forEach(b=>{b.className='px-3 py-1.5 text-sm rounded bg-gray-200 text-gray-700 graph-tab'});btn.className='px-3 py-1.5 text-sm rounded bg-indigo-600 text-white graph-tab'}
  const data=await fetch(API+'/api/graph/'+type+'/'+sid).then(r=>r.json());
  drawGraph(data);
}

function drawGraph(data){
  if(graphSim)graphSim.stop();
  const container=document.getElementById('graph-container');container.innerHTML='';
  if(!data.nodes.length){container.innerHTML='<p class="text-gray-400 text-sm p-8">No graph data</p>';return}
  const w=container.clientWidth,h=container.clientHeight||500;
  const svg=d3.select(container).append('svg').attr('width',w).attr('height',h);
  const g=svg.append('g');
  svg.call(d3.zoom().scaleExtent([.2,5]).on('zoom',e=>g.attr('transform',e.transform)));
  const colors={session:'#6366f1',generation:'#3b82f6',tool:'#10b981',text:'#6b7280',span:'#a855f7',pii:'#ef4444',file:'#f59e0b',function:'#8b5cf6',command:'#06b6d4'};
  const nodeMap=new Map(data.nodes.map(n=>[n.id,n]));
  const validEdges=data.edges.filter(e=>nodeMap.has(e.source?.id||e.source)&&nodeMap.has(e.target?.id||e.target));
  graphSim=d3.forceSimulation(data.nodes).force('link',d3.forceLink(validEdges).id(d=>d.id).distance(80)).force('charge',d3.forceManyBody().strength(-200)).force('center',d3.forceCenter(w/2,h/2)).force('collision',d3.forceCollide().radius(25));
  const link=g.append('g').selectAll('line').data(validEdges).join('line').attr('class','graph-link').attr('stroke-width',d=>Math.max(1,d.weight||1));
  const node=g.append('g').selectAll('g').data(data.nodes).join('g').attr('class','graph-node').call(d3.drag().on('start',(e,d)=>{if(!e.active)graphSim.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y}).on('drag',(e,d)=>{d.fx=e.x;d.fy=e.y}).on('end',(e,d)=>{if(!e.active)graphSim.alphaTarget(0);d.fx=null;d.fy=null}));
  node.append('circle').attr('r',d=>Math.max(8,Math.min(20,(d.weight||d.duration||1)/100+8))).attr('fill',d=>colors[d.kind||d.type]||'#94a3b8').attr('stroke','#fff').attr('stroke-width',2);
  node.append('text').text(d=>(d.label||d.name||d.id).slice(0,16)).attr('dy','-12').attr('text-anchor','middle').attr('font-size','10').attr('fill','#374151');
  const tip=d3.select(container).append('div').attr('class','tooltip').style('display','none');
  node.on('mouseover',(e,d)=>{tip.style('display','block').html('<strong>'+(d.label||d.name||d.id)+'</strong><br/>Type: '+(d.kind||d.type||'-')+(d.duration?'<br/>'+fmtD(d.duration):'')+(d.tokens?'<br/>'+fmtT(d.tokens)+' tokens':''))}).on('mousemove',e=>{tip.style('left',(e.offsetX+15)+'px').style('top',(e.offsetY-10)+'px')}).on('mouseout',()=>tip.style('display','none'));
  graphSim.on('tick',()=>{link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);node.attr('transform',d=>'translate('+d.x+','+d.y+')')});
}

// Lake status
async function checkLake(){const s=await fetch(API+'/api/lake/status').then(r=>r.json()).catch(()=>({connected:false}));document.getElementById('lake-status').innerHTML=s.connected?'<span class="text-green-400">● Lake: '+s.sessions+' sessions</span>':'<span class="text-gray-500">○ Lake: offline</span>'}

// Init
checkLake();loadDashboard();
</script>
</body>
</html>`
}
