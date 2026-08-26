import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import { getServerStatus, pickPort, readServerState, startServer, stopServer, writeServerState } from "../../src/local/server"
import type { ServerState } from "../../src/local/server"
import { LOCAL_CONTAINER_NAME } from "../../src/local/docker"
import type { DockerExec } from "../../src/local/docker"
import type { LocalPaths } from "../../src/local/paths"
import type { RuntimeInfo } from "../../src/local/runtime"
import { BUNDLED_RECIPES } from "../../src/local/recipes"

const llamaTier = BUNDLED_RECIPES.models[0]!.tiers.find((tier) => tier.name === "gpu-24gb-discrete")!
if (llamaTier.engine !== "llama.cpp") throw new Error("expected a llama.cpp tier fixture")

function testPaths(root: string): LocalPaths {
  return {
    root,
    bin: path.join(root, "bin"),
    models: path.join(root, "models"),
    downloads: path.join(root, "downloads"),
    certificates: path.join(root, "certificates"),
    state: path.join(root, "state.json"),
    pid: path.join(root, "server.pid"),
    log: path.join(root, "server.log"),
    environment: path.join(root, "environment.json"),
    recipes: path.join(root, "recipes.json"),
    recipesMeta: path.join(root, "recipes.meta.json"),
  }
}

function dockerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    schema: 1,
    engine: "docker-sglang",
    pid: 4242,
    host: "127.0.0.1",
    port: 8095,
    baseURL: "http://127.0.0.1:8095/v1",
    modelID: "test-model",
    modelPath: "org/model@rev",
    modelSha256: "sha256:deadbeef",
    runtimePath: "image@sha256:deadbeef",
    runtimeVersion: "sglang test",
    tier: "dgx-spark-128gb",
    flags: [],
    reasoningEffort: "medium",
    temperature: 0,
    startedAt: new Date().toISOString(),
    logPath: `docker logs ${LOCAL_CONTAINER_NAME}`,
    ...overrides,
  }
}

function fakeDockerExec(table: Record<string, { stdout: string; stderr: string } | Error>): DockerExec {
  return async (file, args) => {
    const key = [file, ...args].join(" ")
    for (const [prefix, result] of Object.entries(table)) {
      if (key.startsWith(prefix)) {
        if (result instanceof Error) throw result
        return result
      }
    }
    throw new Error(`unexpected docker exec: ${key}`)
  }
}

// A shebang script that sleeps briefly. Its own path stands in for the real
// llama-server binary so `managedProcess()`'s `ps`/`/proc` substring check
// (which requires "llama-server" and the tracked modelPath in the live
// process's command line) passes without spawning a real model server.
async function fakeLlamaServerScript(dir: string) {
  const scriptPath = path.join(dir, "llama-server")
  await fs.writeFile(scriptPath, "#!/bin/sh\nsleep 5\n")
  await fs.chmod(scriptPath, 0o755)
  return scriptPath
}

describe("local server port selection", () => {
  test("asks the OS for a free loopback port", async () => {
    const requested: number[] = []
    const port = await pickPort(0, async (candidate) => {
      requested.push(candidate)
      return 43123
    })
    expect(requested).toEqual([0])
    expect(port).toBe(43123)
  })

  test("auto-picks the next candidate when the preferred port is occupied", async () => {
    const requested: number[] = []
    const selected = await pickPort(8080, async (candidate) => {
      requested.push(candidate)
      if (candidate === 8080) throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" })
      return candidate === 0 ? 43124 : candidate
    })
    expect(requested[0]).toBe(8080)
    expect(selected).toBe(8081)
  })

  test("skips a port that binds but already answers HTTP (SO_REUSEPORT shadow)", async () => {
    const probed: number[] = []
    const selected = await pickPort(
      9000,
      async (candidate) => (candidate === 0 ? 43125 : candidate),
      async (port) => {
        probed.push(port)
        return port === 9000
      },
    )
    expect(probed[0]).toBe(9000)
    expect(selected).toBe(9001)
  })
})

describe("getServerStatus / stopServer — docker-sglang engine", () => {
  test("reports healthy when the container is running and /health responds", async () => {
    await using tmp = await tmpdir()
    const paths = testPaths(tmp.path)
    await writeServerState(dockerState(), paths)

    const status = await getServerStatus({
      paths,
      fetchImpl: async () => new Response(null, { status: 200 }),
      dockerExec: fakeDockerExec({
        [`docker inspect -f {{.State.Running}} ${LOCAL_CONTAINER_NAME}`]: { stdout: "true\n", stderr: "" },
      }),
    })

    expect(status.processAlive).toBe(true)
    expect(status.healthy).toBe(true)
    expect(status.stale).toBe(false)
  })

  test("reports stale when the tracked container is gone", async () => {
    await using tmp = await tmpdir()
    const paths = testPaths(tmp.path)
    await writeServerState(dockerState(), paths)

    const status = await getServerStatus({
      paths,
      dockerExec: fakeDockerExec({
        [`docker inspect -f {{.State.Running}} ${LOCAL_CONTAINER_NAME}`]: { stdout: "false\n", stderr: "" },
      }),
    })

    expect(status.processAlive).toBe(false)
    expect(status.healthy).toBe(false)
    expect(status.stale).toBe(true)
  })

  test("stopServer removes a running container and clears state", async () => {
    await using tmp = await tmpdir()
    const paths = testPaths(tmp.path)
    await writeServerState(dockerState(), paths)

    const dockerExec = fakeDockerExec({
      [`docker inspect -f {{.State.Running}} ${LOCAL_CONTAINER_NAME}`]: { stdout: "true\n", stderr: "" },
      [`docker inspect -f {{.Id}} ${LOCAL_CONTAINER_NAME}`]: { stdout: "abc123\n", stderr: "" },
      [`docker rm -f ${LOCAL_CONTAINER_NAME}`]: { stdout: `${LOCAL_CONTAINER_NAME}\n`, stderr: "" },
    })

    const result = await stopServer({ paths, dockerExec })
    expect(result).toEqual({ stopped: true, reason: "stopped", pid: 4242 })
    expect(await readServerState(paths)).toBeUndefined()
  })

  test("a docker rm failure must not look like success: state is preserved so the container is not orphaned", async () => {
    await using tmp = await tmpdir()
    const paths = testPaths(tmp.path)
    await writeServerState(dockerState(), paths)

    const dockerExec = fakeDockerExec({
      [`docker inspect -f {{.State.Running}} ${LOCAL_CONTAINER_NAME}`]: { stdout: "true\n", stderr: "" },
      [`docker inspect -f {{.Id}} ${LOCAL_CONTAINER_NAME}`]: { stdout: "abc123\n", stderr: "" },
      [`docker rm -f ${LOCAL_CONTAINER_NAME}`]: new Error("docker daemon busy"),
    })

    await expect(stopServer({ paths, dockerExec })).rejects.toThrow("docker daemon busy")
    const state = await readServerState(paths)
    expect(state?.pid).toBe(4242)
  })
})

describe("startServer / getServerStatus / stopServer — llama.cpp engine", () => {
  test("waitForHealth + state write/read/clear round trip", async () => {
    await using tmp = await tmpdir()
    const paths = testPaths(tmp.path)
    const scriptPath = await fakeLlamaServerScript(tmp.path)
    const modelPath = path.join(tmp.path, "model.gguf")
    const runtime: RuntimeInfo = { path: scriptPath, version: "test-runtime", source: "path" }

    const state = await startServer({
      runtime,
      modelID: "test-model",
      modelPath,
      modelSha256: "sha256:deadbeef",
      tier: llamaTier,
      paths,
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    })

    // writeServerState happened before waitForHealth returned; confirm the
    // round trip reads back exactly what was written.
    const persisted = await readServerState(paths)
    expect(persisted).toEqual(state)
    expect(state.modelPath).toBe(modelPath)

    const status = await getServerStatus({ paths, fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }) })
    expect(status.processAlive).toBe(true)
    expect(status.healthy).toBe(true)

    const result = await stopServer({ paths, graceMs: 2_000 })
    expect(result.stopped).toBe(true)
    expect(await readServerState(paths)).toBeUndefined()
  })

  test("stopServer refuses to signal a live pid that is not the tracked llama-server process", async () => {
    await using tmp = await tmpdir()
    const paths = testPaths(tmp.path)
    // A real, currently-alive process whose command line does NOT contain
    // "llama-server" or the tracked modelPath — state.json pointed at it is
    // either stale or corrupted, and stopServer must never signal it blind.
    await writeServerState(
      {
        schema: 1,
        pid: process.pid,
        host: "127.0.0.1",
        port: 42625,
        baseURL: "http://127.0.0.1:42625/v1",
        modelID: "test-model",
        modelPath: "/models/does-not-match.gguf",
        modelSha256: "sha256:deadbeef",
        runtimePath: "/usr/local/bin/llama-server",
        runtimeVersion: "test-runtime",
        tier: llamaTier.name,
        flags: [],
        reasoningEffort: "medium",
        temperature: 0,
        startedAt: new Date().toISOString(),
        logPath: path.join(tmp.path, "server.log"),
      },
      paths,
    )

    await expect(stopServer({ paths })).rejects.toThrow(/Refusing to signal pid/)
    // Untouched: state stays exactly as written, and the real process is unharmed.
    expect((await readServerState(paths))?.pid).toBe(process.pid)
  })
})
