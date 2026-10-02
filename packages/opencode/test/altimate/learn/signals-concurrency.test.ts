// altimate_change - new file
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Signals from "../../../src/altimate/learn/signals"

async function waitFile(file: string) {
  const until = Date.now() + 5000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${path.basename(file)}`)
    await Bun.sleep(5)
  }
}

test("signal consumption preserves another process's append after its snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-signals-processes-"))
  const first = await Signals.appendSignal(root, { kind: "review", sessionID: "old", text: "Use snake case.", reason: "review" })
  const mod = JSON.stringify(path.resolve(import.meta.dir, "../../../src/altimate/learn/signals.ts"))
  const shared = `
    import fs from "node:fs/promises";
    import { Flock } from "@opencode-ai/core/util/flock";
    import * as Signals from ${mod};
    const root = ${JSON.stringify(root)};
    const mark = (name) => fs.writeFile(root + "/" + name, "ready");
    async function wait(name) {
      while (!(await Bun.file(root + "/" + name).exists())) await Bun.sleep(5);
    }
  `
  const consumer = Bun.spawn([process.execPath, "--eval", shared + `
    const read = fs.readFile.bind(fs);
    let paused = false;
    fs.readFile = async (...args) => {
      const result = await read(...args);
      if (String(args[0]) === Signals.signalsFile(root) && !paused) {
        paused = true;
        await mark("snapshot");
        await wait("release");
      }
      return result;
    };
    await Signals.consumeSignals(root, [${JSON.stringify(first!.id)}], "reflect@old");
  `], { stdout: "pipe", stderr: "pipe" })
  let appender: ReturnType<typeof Bun.spawn> | undefined
  try {
    await waitFile(path.join(root, "snapshot"))
    appender = Bun.spawn([process.execPath, "--eval", shared + `
      const withLock = Flock.withLock;
      Flock.withLock = (key, task, options) => withLock(key, task, { ...options, onWait: () => mark("append-observed") });
      await Signals.appendSignal(root, { kind: "review", sessionID: "new", text: "Document model ownership.", reason: "review" });
      await mark("append-observed");
    `], { stdout: "pipe", stderr: "pipe" })
    // Before the fix this is an appended signal; with locking it is the observed lock contention.
    await waitFile(path.join(root, "append-observed"))
    await fs.writeFile(path.join(root, "release"), "go")
    expect(await consumer.exited).toBe(0)
    expect(await appender.exited).toBe(0)
    const all = await Signals.readSignals(root)
    expect(all.map((s) => [s.sessionID, s.status])).toEqual([["old", "consumed"], ["new", "open"]])
  } finally {
    consumer.kill()
    appender?.kill()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 15000)
