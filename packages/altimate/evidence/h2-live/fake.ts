// Fake OpenAI-compatible chat server. Scripts: no tool result yet -> warehouse_add; 1 tool result -> sql_execute; else text.
const log = process.argv[3]
const sse = (o: any) => `data: ${JSON.stringify(o)}\n\n`
Bun.serve({ port: Number(process.argv[2]), hostname: "127.0.0.1", async fetch(req) {
  const url = new URL(req.url)
  if (!url.pathname.endsWith("/chat/completions")) return new Response("{}", { headers: { "content-type": "application/json" } })
  const body: any = await req.json()
  const tools = (body.tools ?? []).map((t: any) => t.function?.name)
  const toolMsgs = (body.messages ?? []).filter((m: any) => m.role === "tool").length
  const lastUser = JSON.stringify((body.messages ?? []).filter((m:any)=>m.role==="user").slice(-1)[0]?.content ?? "")
  require("fs").appendFileSync(log, JSON.stringify({ n: tools.length, tools, toolMsgs, lastUser: lastUser.slice(0,80) }) + "\n")
  const chunk = (delta: any, finish: string | null = null) => sse({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake-1", choices: [{ index: 0, delta, finish_reason: finish }] })
  let out = chunk({ role: "assistant", content: "" })
  const wname = (lastUser.match(/NAME=(\w+)/) ?? [,"demo"])[1]
  if (lastUser.includes("SQLONLY") && tools.includes("sql_execute")) {
    let o = chunk({ role: "assistant", content: "" })
    if (toolMsgs === 0) { o += chunk({ tool_calls: [{ index: 0, id: "call_s", type: "function", function: { name: "sql_execute", arguments: JSON.stringify({ warehouse: wname, sql: "select 42 as answer" }) } }] }); o += chunk({}, "tool_calls") } else { o += chunk({ content: "sqlonly done" }); o += chunk({}, "stop") }
    o += "data: [DONE]\n\n"; return new Response(o, { headers: { "content-type": "text/event-stream" } })
  }
  const scripted = tools.includes("warehouse_add") && lastUser.includes("SCRIPT")
  if (scripted && toolMsgs === 0) {
    out += chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "warehouse_add", arguments: JSON.stringify({ name: wname, path: ":memory:" }) } }] })
    out += chunk({}, "tool_calls")
  } else if (scripted && toolMsgs === 1) {
    out += chunk({ tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "sql_execute", arguments: JSON.stringify({ warehouse: wname, sql: "select 42 as answer, 'duck' as animal, null as nothing" }) } }] })
    out += chunk({}, "tool_calls")
  } else {
    out += chunk({ content: scripted ? "Done." : "ok" })
    out += chunk({}, "stop")
  }
  out += sse({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake-1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  out += "data: [DONE]\n\n"
  return new Response(out, { headers: { "content-type": "text/event-stream" } })
}})
console.log("fake up")
