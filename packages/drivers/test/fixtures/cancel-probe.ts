// Measures whether Worker.terminate() / subprocess kill stops a blocking native query.
// usage: bun cancel-probe.ts <worker|process> <sqlite|duckdb>
import { spawnSync } from "node:child_process"
const [mode, engine] = process.argv.slice(2)
const here = import.meta.dir
const cpuOf = (pid: number) => Number(spawnSync("ps", ["-o", "cputime=", "-p", String(pid)]).stdout.toString().trim().split(":").reduce((a, p) => a * 60 + Number(p), 0))
const pcpu = (pid: number) => Number(spawnSync("ps", ["-o", "%cpu=", "-p", String(pid)]).stdout.toString().trim() || "0")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const out: any = { mode, engine }
if (mode === "worker") {
  const w = new Worker(`${here}/cancel-probe-worker.ts`)
  w.postMessage({ engine })
  await sleep(1500)
  let ticks = 0, last = performance.now(), maxLag = 0
  const t = setInterval(() => { const n = performance.now(); maxLag = Math.max(maxLag, n - last - 20); last = n; ticks++ }, 20)
  await sleep(500)
  const cpuBefore = cpuOf(process.pid)
  const terminateAt = performance.now()
  w.terminate()
  await sleep(2000)
  const cpuAfter = cpuOf(process.pid)
  await sleep(2000)
  const cpuLater = cpuOf(process.pid)
  clearInterval(t)
  out.mainThreadMaxLagMs = Math.round(maxLag)
  out.cpuSecsDuring2sAfterTerminate = cpuAfter - cpuBefore
  out.cpuSecsDuringNext2s = cpuLater - cpuAfter
  out.pcpuNow = pcpu(process.pid)
  out.stoppedConsumingCpu = out.cpuSecsDuringNext2s < 0.5
  console.log(JSON.stringify(out))
  process.exit(0)
}
if (mode === "process") {
  const dbfile = `${process.env.TMPDIR || "/tmp"}/cancel-probe-${process.pid}.duckdb`
  const child = Bun.spawn(["bun", `${here}/cancel-probe-child.ts`, engine!, dbfile], { stdout: "ignore", stderr: "ignore" })
  await sleep(1500)
  out.childCpuPctBeforeKill = pcpu(child.pid)
  const t0 = performance.now()
  child.kill("SIGKILL")
  await child.exited
  out.reapedAfterMs = Math.round(performance.now() - t0)
  await sleep(300)
  out.childStillAlive = spawnSync("ps", ["-p", String(child.pid)]).status === 0
  if (engine === "duckdb") {
    // lock released: parent can open the same file read-write
    const duckdb: any = (await import("duckdb")).default
    out.lockReleased = await new Promise((res) => { const d = new duckdb.Database(dbfile, (e: any) => res(!e)) })
  }
  console.log(JSON.stringify(out))
  process.exit(0)
}
