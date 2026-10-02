// altimate_change - new file
import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"

async function waitFile(file: string) {
  const until = Date.now() + 5000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${path.basename(file)}`)
    await Bun.sleep(5)
  }
}

test("learn transaction keeps every state mutation exclusive across processes while heartbeating", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-lock-processes-"))
  const name = "team-playbook"
  const signal = await Signals.appendSignal(root, { kind: "review", sessionID: "first", text: "Check model ownership.", reason: "review" })
  const withLock = Flock.withLock
  const lock = spyOn(Flock, "withLock").mockImplementation((key, task, opts) => withLock(key, task, { ...opts, staleMs: 300 }))
  const dir = path.resolve(import.meta.dir, "../../../src/altimate/learn")
  const child = Bun.spawn([process.execPath, "--eval", `
    import fs from "node:fs/promises";
    import { Flock } from "@opencode-ai/core/util/flock";
    import * as Store from ${JSON.stringify(path.join(dir, "store.ts"))};
    import * as Playbook from ${JSON.stringify(path.join(dir, "playbook.ts"))};
    import * as Signals from ${JSON.stringify(path.join(dir, "signals.ts"))};
    const root = ${JSON.stringify(root)};
    while (!(await Bun.file(root + "/start").exists())) await Bun.sleep(5);
    const original = Flock.withLock;
    Flock.withLock = (key, task, opts) => original(key, task, {
      ...opts, staleMs: 300, baseDelayMs: 10, maxDelayMs: 20,
      onWait: async ({ waited }) => {
        if (waited >= 600) await fs.writeFile(root + "/observed", "still waiting");
      },
    });
    const name = ${JSON.stringify(name)};
    await Store.transaction(root, async () => {
      await Store.saveCandidate(root, name, Playbook.withBullets(Playbook.create({ name }), [
        { id: "L-0001", text: "Document model ownership.", helpful: 0, harmful: 0 },
      ]));
      await Store.writeHarmfulFrom(root, name, { "L-0001": ["feedback"] });
      await Store.writePendingReplacements(root, name, [{ id: "L-0002", text: "Check model naming.", reasons: [], feedback: "Use snake case.", kind: "review", attempts: 0 }]);
      await Store.appendHistory(root, name, { action: "reflect" });
      await Signals.consumeSignals(root, [${JSON.stringify(signal!.id)}], "reflect@child");
    });
    await fs.writeFile(root + "/observed", "finished");
  `], { stdout: "pipe", stderr: "pipe" })
  try {
    await Store.transaction(root, async () => {
      await fs.writeFile(path.join(root, "start"), "go")
      await waitFile(path.join(root, "observed"))
      expect(await fs.readFile(path.join(root, "observed"), "utf8")).toBe("still waiting")
      expect(await Store.readCandidate(root, name)).toBeUndefined()
      expect(await Store.readHarmfulFrom(root, name)).toEqual({})
      expect(await Store.readPendingReplacements(root, name)).toEqual([])
      expect(await Bun.file(Store.paths(root, name).history).exists()).toBe(false)
      expect((await Signals.readSignals(root))[0].status).toBe("open")
      // Nested operations reuse this lock rather than queueing behind the child that is waiting.
      await Store.saveCandidate(root, name, Playbook.create({ name }))
    })
    expect(await child.exited).toBe(0)
    expect(await Store.readCandidate(root, name)).toContain("Document model ownership.")
    expect(await Store.readHarmfulFrom(root, name)).toEqual({ "L-0001": ["feedback"] })
    expect(await Store.readPendingReplacements(root, name)).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(Store.paths(root, name).history, "utf8")).action).toBe("reflect")
    expect((await Signals.readSignals(root))[0].status).toBe("consumed")
  } finally {
    lock.mockRestore()
    child.kill()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 15000)

test("learn transaction recovers an abandoned stale cross-process lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-lock-stale-"))
  const dir = path.join(root, ".altimate-code", "learn", Hash.fast("learn-state") + ".lock")
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "heartbeat"), "")
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ token: "abandoned", pid: 2147483647 }))
    const old = new Date(Date.now() - 120_000)
    await fs.utimes(path.join(dir, "heartbeat"), old, old)
    await Store.transaction(root, async () => Store.saveCandidate(root, "team-playbook", Playbook.create({ name: "team-playbook" })))
    expect(await Store.readCandidate(root, "team-playbook")).toContain("name: team-playbook")
    expect(await fs.stat(dir).catch(() => undefined)).toBeUndefined()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
