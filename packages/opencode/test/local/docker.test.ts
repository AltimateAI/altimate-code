import { describe, expect, test } from "bun:test"

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
})

describe("installContainerReaper", () => {
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
    let exitCode: number | undefined
    const uninstall = installContainerReaper(exec, (code) => {
      exitCode = code
    })
    try {
      process.emit("SIGINT", "SIGINT")
      // removeDockerContainer's exec calls are async; let them settle.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(rmCalls).toBe(1)
      expect(exitCode).toBe(130)
    } finally {
      uninstall()
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
    const uninstall = installContainerReaper(exec, () => {})
    uninstall()
    process.emit("SIGINT", "SIGINT")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rmCalls).toBe(0)
  })

  test("only reaps once even if both SIGINT and SIGTERM arrive", async () => {
    let rmCalls = 0
    const exec = execRouter({
      inspectId: async () => ({ stdout: "container123\n", stderr: "" }),
      rm: async () => {
        rmCalls++
        return { stdout: "", stderr: "" }
      },
    })
    let exitCalls = 0
    const uninstall = installContainerReaper(exec, () => {
      exitCalls++
    })
    try {
      process.emit("SIGINT", "SIGINT")
      process.emit("SIGTERM", "SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(rmCalls).toBe(1)
      expect(exitCalls).toBe(1)
    } finally {
      uninstall()
    }
  })
})
