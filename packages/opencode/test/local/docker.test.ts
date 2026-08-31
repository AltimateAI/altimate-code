import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import {
  buildDockerRunArgs,
  dockerContainerRunning,
  installContainerReaper,
  LOCAL_CONTAINER_NAME,
  LOCAL_MANAGEMENT_LABEL_KEY,
  LOCAL_MANAGEMENT_LABEL_VALUE,
  removeDockerContainer,
  startDockerServer,
  type DockerExec,
} from "../../src/local/docker"
import { BUNDLED_RECIPES } from "../../src/local/recipes"

const model = BUNDLED_RECIPES.models[0]!
const tier = model.tiers.find((entry) => entry.name === "dgx-spark-128gb")!
if (tier.engine !== "docker-sglang") throw new Error("dgx tier must be docker-sglang")

describe("buildDockerRunArgs", () => {
  test("pins the image by digest and binds only to loopback", () => {
    if (tier.engine !== "docker-sglang") throw new Error("dgx tier must be docker-sglang")
    const args = buildDockerRunArgs({ tier, modelID: model.id, port: 8095, hfCache: "/home/user/.cache/huggingface" })
    expect(args).toContain(`${tier.image}@${tier.image_digest}`)
    expect(args).toContain(`127.0.0.1:8095:${tier.container_port}`)
    expect(args).toContain(LOCAL_CONTAINER_NAME)
    // Ownership label: lets removeDockerContainer refuse to force-remove a
    // container this tool did not create.
    expect(args.join(" ")).toContain(`--label ${LOCAL_MANAGEMENT_LABEL_KEY}=${LOCAL_MANAGEMENT_LABEL_VALUE}`)
    expect(args.join(" ")).toContain(`--model-path ${tier.model_hf}`)
    expect(args.join(" ")).toContain(`--served-model-name ${model.id}`)
    expect(args.join(" ")).toContain(`--context-length ${tier.ctx}`)
    // EAGLE speculative args come from the recipe, not hardcoded
    expect(args).toContain("--speculative-algorithm")
  })

  test("bundled dgx tier is a valid docker recipe", () => {
    expect(tier.engine).toBe("docker-sglang")
    if (tier.engine !== "docker-sglang") return
    expect(tier.image_digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(tier.ctx).toBe(131072)
    expect(tier.agent.reasoning_effort).toBe("medium")
  })
})

type ExecResult = { stdout: string; stderr: string }

// Default: a container that exists and passes the label-ownership check.
// Tests that need to simulate a foreign (unmanaged) container override
// inspectLabel to return something else.
const managedLabel = async (): Promise<ExecResult> => ({ stdout: `${LOCAL_MANAGEMENT_LABEL_VALUE}\n`, stderr: "" })

function execRouter(handlers: {
  inspectId?: () => Promise<ExecResult>
  run?: () => Promise<ExecResult>
  inspectPid?: () => Promise<ExecResult>
  inspectRunning?: () => Promise<ExecResult>
  inspectLabel?: () => Promise<ExecResult>
  logsTail1?: () => Promise<ExecResult>
  logsTail25?: () => Promise<ExecResult>
  rm?: () => Promise<ExecResult>
}): DockerExec {
  const inspectLabel = handlers.inspectLabel ?? managedLabel
  return async (file, args) => {
    if (args[0] === "inspect" && args[2] === "{{.Id}}" && handlers.inspectId) return handlers.inspectId()
    if (args[0] === "inspect" && args[2] === "{{.State.Pid}}" && handlers.inspectPid) return handlers.inspectPid()
    if (args[0] === "inspect" && args[2] === "{{.State.Running}}" && handlers.inspectRunning) return handlers.inspectRunning()
    if (args[0] === "inspect" && args[2] === `{{index .Config.Labels "${LOCAL_MANAGEMENT_LABEL_KEY}"}}`) return inspectLabel()
    if (args[0] === "run" && handlers.run) return handlers.run()
    if (args[0] === "logs" && args[2] === "1" && handlers.logsTail1) return handlers.logsTail1()
    if (args[0] === "logs" && args[2] === "25" && handlers.logsTail25) return handlers.logsTail25()
    if (args[0] === "rm" && handlers.rm) return handlers.rm()
    throw new Error(`unexpected exec call: ${file} ${args.join(" ")}`)
  }
}

const containerNotFound = async (): Promise<ExecResult> => {
  throw new Error("no such container")
}

const daemonError = async (): Promise<ExecResult> => {
  const error = new Error("Cannot connect to the Docker daemon") as Error & { stderr: string }
  error.stderr = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock: is the docker daemon running?"
  throw error
}

describe("dockerContainerRunning", () => {
  test("reports not running when docker inspect says the container is absent", async () => {
    const exec = execRouter({ inspectRunning: containerNotFound })
    expect(await dockerContainerRunning(exec)).toBe(false)
  })

  test("propagates a docker daemon error instead of reporting not running", async () => {
    const exec = execRouter({ inspectRunning: daemonError })
    await expect(dockerContainerRunning(exec)).rejects.toThrow(/Docker daemon/)
  })
})

describe("removeDockerContainer", () => {
  test("skips rm when docker inspect says the container is absent", async () => {
    let rmCalls = 0
    const exec = execRouter({
      inspectId: containerNotFound,
      rm: async () => {
        rmCalls++
        return { stdout: "", stderr: "" }
      },
    })
    expect(await removeDockerContainer(exec)).toEqual({ existed: false, removed: false })
    expect(rmCalls).toBe(0)
  })

  test("propagates a docker daemon error instead of treating it as container absence", async () => {
    let rmCalls = 0
    const exec = execRouter({
      inspectId: daemonError,
      rm: async () => {
        rmCalls++
        return { stdout: "", stderr: "" }
      },
    })
    await expect(removeDockerContainer(exec)).rejects.toThrow(/Docker daemon/)
    expect(rmCalls).toBe(0)
  })

  // The container name is fixed and globally visible; force-removing
  // whatever currently holds it is only safe if `altimate local` created it.
  test("refuses to force-remove a container that exists but was not created by altimate local", async () => {
    let rmCalls = 0
    const exec = execRouter({
      inspectId: async () => ({ stdout: "someOtherContainerId\n", stderr: "" }),
      inspectLabel: async () => ({ stdout: "\n", stderr: "" }), // label absent: not ours
      rm: async () => {
        rmCalls++
        return { stdout: "", stderr: "" }
      },
    })
    await expect(removeDockerContainer(exec)).rejects.toThrow(/not created by `altimate local`/)
    expect(rmCalls).toBe(0)
  })
})

describe("startDockerServer", () => {
  test("resolves with the pid once the health check reports healthy", async () => {
    const exec = execRouter({
      inspectId: containerNotFound,
      run: async () => ({ stdout: "container123\n", stderr: "" }),
      inspectPid: async () => ({ stdout: "4242\n", stderr: "" }),
    })
    const fetchImpl = async () => new Response(null, { status: 200 })

    const result = await startDockerServer({ tier, modelID: model.id, port: 8095, exec, fetchImpl })
    expect(result).toEqual({ pid: 4242, container: LOCAL_CONTAINER_NAME })
  })

  test("throws with recent logs when the container exits before becoming healthy", async () => {
    const exec = execRouter({
      inspectId: containerNotFound,
      run: async () => ({ stdout: "container123\n", stderr: "" }),
      inspectPid: async () => ({ stdout: "4242\n", stderr: "" }),
      inspectRunning: async () => ({ stdout: "false\n", stderr: "" }),
      logsTail25: async () => ({ stdout: "", stderr: "CUDA error: out of memory\n" }),
    })
    const fetchImpl = async () => new Response(null, { status: 503 })

    await expect(
      startDockerServer({ tier, modelID: model.id, port: 8095, exec, fetchImpl, pollIntervalMs: 1 }),
    ).rejects.toThrow(/CUDA error: out of memory/)
  })

  test("throws and removes the container after the health timeout elapses", async () => {
    let removeCalls = 0
    const exec = execRouter({
      inspectId: async () => ({ stdout: "container123\n", stderr: "" }),
      run: async () => ({ stdout: "container123\n", stderr: "" }),
      inspectPid: async () => ({ stdout: "4242\n", stderr: "" }),
      inspectRunning: async () => ({ stdout: "true\n", stderr: "" }),
      logsTail1: async () => ({ stdout: "loading weights...\n", stderr: "" }),
      rm: async () => {
        removeCalls++
        return { stdout: "", stderr: "" }
      },
    })
    const fetchImpl = async () => new Response(null, { status: 503 })

    await expect(
      startDockerServer({
        tier,
        modelID: model.id,
        port: 8095,
        exec,
        fetchImpl,
        pollIntervalMs: 2,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/did not become healthy in time/)
    expect(removeCalls).toBeGreaterThan(0)
  })

  test("removes the container when PID inspection fails after `docker run`, instead of leaving it untracked", async () => {
    let rmCalls = 0
    let inspectIdCalls = 0
    const exec = execRouter({
      // First call is startDockerServer's pre-run cleanup (nothing to remove
      // yet); second call is the cleanup triggered by the pid-inspect
      // failure below, after `docker run` has already created the container.
      inspectId: async () => {
        inspectIdCalls++
        if (inspectIdCalls === 1) throw new Error("no such container")
        return { stdout: "container123\n", stderr: "" }
      },
      run: async () => ({ stdout: "container123\n", stderr: "" }),
      inspectPid: async () => {
        throw new Error("Cannot connect to the Docker daemon")
      },
      rm: async () => {
        rmCalls++
        return { stdout: "", stderr: "" }
      },
    })
    const fetchImpl = async () => new Response(null, { status: 503 })

    await expect(
      startDockerServer({ tier, modelID: model.id, port: 8095, exec, fetchImpl }),
    ).rejects.toThrow(/Cannot connect to the Docker daemon/)
    expect(rmCalls).toBe(1)
  })

  test("removes the container when the docker daemon errors mid-poll, instead of leaving it untracked", async () => {
    // dockerContainerRunning throwing (not just returning false) inside the
    // health-polling loop used to propagate straight out of startDockerServer,
    // skipping cleanup entirely — setupDocker only records state once this
    // function succeeds, so the container would be invisible to status/stop.
    let rmCalls = 0
    let inspectIdCalls = 0
    const exec = execRouter({
      inspectId: async () => {
        inspectIdCalls++
        if (inspectIdCalls === 1) throw new Error("no such container") // pre-run cleanup: nothing yet
        return { stdout: "container123\n", stderr: "" }
      },
      run: async () => ({ stdout: "container123\n", stderr: "" }),
      inspectPid: async () => ({ stdout: "4242\n", stderr: "" }),
      inspectRunning: async () => {
        const error = new Error("Cannot connect to the Docker daemon") as Error & { stderr: string }
        error.stderr = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
        throw error
      },
      rm: async () => {
        rmCalls++
        return { stdout: "", stderr: "" }
      },
    })
    const fetchImpl = async () => new Response(null, { status: 503 }) // never healthy, forces the running-check

    await expect(
      startDockerServer({ tier, modelID: model.id, port: 8095, exec, fetchImpl, pollIntervalMs: 1 }),
    ).rejects.toThrow(/Cannot connect to the Docker daemon/)
    expect(rmCalls).toBe(1)
  })

  test("preserves the cleanup error instead of hiding it behind the original polling failure", async () => {
    // If `docker rm` itself fails during cleanup after a polling failure, the
    // caller previously only ever saw the original error — with no hint that
    // the container might still be running, untracked, because cleanup also
    // failed.
    let inspectIdCalls = 0
    const exec = execRouter({
      inspectId: async () => {
        inspectIdCalls++
        if (inspectIdCalls === 1) throw new Error("no such container") // pre-run cleanup: nothing yet
        const error = new Error("Cannot connect to the Docker daemon") as Error & { stderr: string }
        error.stderr = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
        throw error // the cleanup attempt inside the catch block also fails
      },
      run: async () => ({ stdout: "container123\n", stderr: "" }),
      inspectPid: async () => ({ stdout: "4242\n", stderr: "" }),
      inspectRunning: async () => ({ stdout: "true\n", stderr: "" }),
      logsTail1: async () => ({ stdout: "loading weights...\n", stderr: "" }),
    })
    const fetchImpl = async () => new Response(null, { status: 503 })

    const failure = await startDockerServer({
      tier,
      modelID: model.id,
      port: 8095,
      exec,
      fetchImpl,
      pollIntervalMs: 2,
      timeoutMs: 5,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toMatch(/did not become healthy in time/)
    expect(message).toMatch(/cleanup failed/i)
    expect(message).toMatch(/Cannot connect to the Docker daemon/)
  })

  test("does not return success when a shutdown signal arrives right as the health check passes", async () => {
    // The reaper aborts synchronously the instant a signal fires, before its
    // own removeDockerContainer call even starts. If the health check races
    // that abort, startDockerServer must not hand back a "success" that the
    // caller (setupDocker) would use to write state.json and wire the config
    // for a container the reaper is concurrently deleting.
    const signalSource = new EventEmitter() as unknown as Pick<NodeJS.EventEmitter, "on" | "off">
    let rmCalls = 0
    let inspectIdCalls = 0
    const exec = execRouter({
      inspectId: async () => {
        inspectIdCalls++
        if (inspectIdCalls === 1) throw new Error("no such container") // pre-run cleanup: nothing yet
        return { stdout: "container123\n", stderr: "" }
      },
      run: async () => ({ stdout: "container123\n", stderr: "" }),
      inspectPid: async () => ({ stdout: "4242\n", stderr: "" }),
      rm: async () => {
        rmCalls++
        return { stdout: "", stderr: "" }
      },
    })
    // "Healthy" only fires the signal first, simulating the interrupt landing
    // in the same tick the health probe resolves true.
    const fetchImpl = async () => {
      ;(signalSource as EventEmitter).emit("SIGINT", "SIGINT")
      return new Response(null, { status: 200 })
    }

    await expect(
      startDockerServer({ tier, modelID: model.id, port: 8095, exec, fetchImpl, signalSource, onSignalExit: () => {} }),
    ).rejects.toThrow(/interrupted by a shutdown signal/)
    expect(rmCalls).toBeGreaterThan(0)
  })
})

describe("installContainerReaper", () => {
  // Signals are injected through a fresh EventEmitter rather than emitted on
  // `process` itself: `process.emit("SIGINT", ...)` would invoke every other
  // SIGINT listener in this test process (parallel test setup, the real CLI's
  // own handlers), not just the one this test installed.
  function fakeSignalSource() {
    return new EventEmitter() as unknown as Pick<NodeJS.EventEmitter, "on" | "off"> & {
      emit(event: "SIGINT" | "SIGTERM", signal: "SIGINT" | "SIGTERM"): boolean
    }
  }

  // The container is created before setupDocker ever writes state.json; an
  // interrupt during the (up to 45-minute) health wait must not leave it
  // orphaned and invisible to `altimate local stop`/`status`.
  test("removes the labeled container and reports a SIGINT-shaped exit code", async () => {
    let rmCalls = 0
    const exec = execRouter({
      inspectId: async () => ({ stdout: "container123\n", stderr: "" }),
      rm: async () => {
        rmCalls++
        return { stdout: "", stderr: "" }
      },
    })
    const signalSource = fakeSignalSource()
    let exitCode: number | undefined
    const reaper = installContainerReaper(
      exec,
      (code) => {
        exitCode = code
      },
      signalSource,
    )
    try {
      signalSource.emit("SIGINT", "SIGINT")
      expect(reaper.signal.aborted).toBe(true)
      // removeDockerContainer's exec calls are async; let them settle.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(rmCalls).toBe(1)
      expect(exitCode).toBe(130)
    } finally {
      reaper.uninstall()
    }
  })

  test("uninstalling removes the signal listeners so a later signal does nothing", async () => {
    let rmCalls = 0
    const exec = execRouter({
      inspectId: async () => ({ stdout: "container123\n", stderr: "" }),
      rm: async () => {
        rmCalls++
        return { stdout: "", stderr: "" }
      },
    })
    const signalSource = fakeSignalSource()
    const reaper = installContainerReaper(exec, () => {}, signalSource)
    reaper.uninstall()
    signalSource.emit("SIGINT", "SIGINT")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rmCalls).toBe(0)
  })

  test("only removes the container once even if both SIGINT and SIGTERM arrive back-to-back", async () => {
    let rmCalls = 0
    const exec = execRouter({
      inspectId: async () => ({ stdout: "container123\n", stderr: "" }),
      rm: async () => {
        rmCalls++
        return { stdout: "", stderr: "" }
      },
    })
    const signalSource = fakeSignalSource()
    let exitCalls = 0
    const reaper = installContainerReaper(
      exec,
      () => {
        exitCalls++
      },
      signalSource,
    )
    try {
      signalSource.emit("SIGINT", "SIGINT")
      signalSource.emit("SIGTERM", "SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(rmCalls).toBe(1)
      // Exactly one exit call: the second signal exits immediately (see next
      // test) rather than waiting for the first's cleanup, but the first
      // cleanup's own exit call is suppressed once we've already exited.
      expect(exitCalls).toBe(1)
    } finally {
      reaper.uninstall()
    }
  })

  test("a second signal forces immediate exit without waiting for a slow docker rm", async () => {
    let rmCalls = 0
    let resolveRm: (() => void) | undefined
    const exec = execRouter({
      inspectId: async () => ({ stdout: "container123\n", stderr: "" }),
      rm: () =>
        new Promise((resolve) => {
          rmCalls++
          resolveRm = () => resolve({ stdout: "", stderr: "" })
        }),
    })
    const signalSource = fakeSignalSource()
    const exitCalls: number[] = []
    const reaper = installContainerReaper(exec, (code) => exitCalls.push(code), signalSource)
    try {
      signalSource.emit("SIGINT", "SIGINT")
      // Let the pending inspect calls ahead of `docker rm` in
      // removeDockerContainer settle so `rm` (which we hold open) is reached.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(rmCalls).toBe(1)
      expect(exitCalls).toEqual([])

      // A second Ctrl-C while cleanup is still pending must exit right away —
      // not wait out a potentially wedged `docker rm`.
      signalSource.emit("SIGINT", "SIGINT")
      expect(exitCalls).toEqual([130])

      // Once the slow rm eventually resolves, its own exit call is a no-op —
      // we already exited once.
      resolveRm?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(exitCalls).toEqual([130])
      expect(rmCalls).toBe(1)
    } finally {
      reaper.uninstall()
    }
  })
})
