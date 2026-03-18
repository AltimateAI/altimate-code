/**
 * SSH tunnel management for database connections.
 *
 * Uses the `ssh2` package (dynamic import). If ssh2 is not installed,
 * throws a clear error message.
 */

import type { ConnectionConfig } from "@altimateai/drivers"

export interface TunnelInfo {
  localPort: number
  close(): void
}

export interface SshConfig {
  ssh_host: string
  ssh_port?: number
  ssh_user?: string
  ssh_password?: string
  ssh_private_key?: string
  host: string
  port: number
}

/** Active tunnels keyed by connection name. */
const activeTunnels = new Map<string, TunnelInfo>()

/** Clean up all tunnels on process exit. */
let cleanupRegistered = false
function ensureCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  const cleanup = () => {
    for (const [, tunnel] of activeTunnels) {
      try {
        tunnel.close()
      } catch {
        // best-effort cleanup
      }
    }
    activeTunnels.clear()
  }
  process.once("exit", cleanup)
  process.once("SIGINT", () => {
    cleanup()
    process.exit(0)
  })
  process.once("SIGTERM", () => {
    cleanup()
    process.exit(0)
  })
}

/**
 * Start an SSH tunnel for a connection.
 * Returns a TunnelInfo with the local port to connect to.
 */
export async function startTunnel(
  name: string,
  config: SshConfig,
): Promise<TunnelInfo> {
  // Close existing tunnel for this name
  const existing = activeTunnels.get(name)
  if (existing) {
    existing.close()
    activeTunnels.delete(name)
  }

  let ssh2: any
  try {
    // @ts-expect-error — optional dependency
    ssh2 = await import("ssh2")
  } catch {
    throw new Error(
      "SSH tunnel requires the ssh2 package. Run: bun add ssh2 @types/ssh2",
    )
  }

  ensureCleanup()

  const net = await import("net")

  return new Promise<TunnelInfo>((resolve, reject) => {
    const client = new ssh2.Client()

    client.on("ready", () => {
      // Create a local TCP server that forwards to remote host:port via SSH
      const server = net.createServer((localSocket) => {
        client.forwardOut(
          "127.0.0.1",
          0,
          config.host,
          config.port,
          (err: Error | undefined, stream: any) => {
            if (err) {
              localSocket.destroy()
              return
            }
            localSocket.pipe(stream).pipe(localSocket)
          },
        )
      })

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address()
        const localPort =
          typeof addr === "object" && addr ? addr.port : 0

        const tunnelInfo: TunnelInfo = {
          localPort,
          close() {
            try {
              server.close()
            } catch {
              // ignore
            }
            try {
              client.end()
            } catch {
              // ignore
            }
            activeTunnels.delete(name)
          },
        }

        activeTunnels.set(name, tunnelInfo)
        resolve(tunnelInfo)
      })

      server.on("error", (err: Error) => {
        client.end()
        reject(new Error(`SSH tunnel local server error: ${err.message}`))
      })
    })

    client.on("error", (err: Error) => {
      reject(new Error(`SSH connection error: ${err.message}`))
    })

    const connectOptions: Record<string, unknown> = {
      host: config.ssh_host,
      port: config.ssh_port ?? 22,
      username: config.ssh_user ?? "root",
    }

    if (config.ssh_private_key) {
      connectOptions.privateKey = config.ssh_private_key
    } else if (config.ssh_password) {
      connectOptions.password = config.ssh_password
    }

    client.connect(connectOptions)
  })
}

/** Get an active tunnel by connection name. */
export function getActiveTunnel(name: string): TunnelInfo | undefined {
  return activeTunnels.get(name)
}

/** Close a specific tunnel by name. */
export function closeTunnel(name: string): void {
  const tunnel = activeTunnels.get(name)
  if (tunnel) {
    tunnel.close()
    activeTunnels.delete(name)
  }
}

/** Close all active tunnels. */
export function closeAllTunnels(): void {
  for (const [, tunnel] of activeTunnels) {
    try {
      tunnel.close()
    } catch {
      // best-effort
    }
  }
  activeTunnels.clear()
}

/**
 * Extract SSH config from a connection config, if SSH tunneling is configured.
 * Returns null if no SSH config present.
 */
export function extractSshConfig(
  config: ConnectionConfig,
): SshConfig | null {
  if (!config.ssh_host) return null

  if (config.connection_string) {
    throw new Error(
      "Cannot use SSH tunnel with connection_string. Use host/port/database instead.",
    )
  }

  return {
    ssh_host: config.ssh_host as string,
    ssh_port: (config.ssh_port as number) ?? 22,
    ssh_user: (config.ssh_user as string) ?? "root",
    ssh_password: config.ssh_password as string | undefined,
    ssh_private_key: config.ssh_private_key as string | undefined,
    host: (config.host as string) ?? "127.0.0.1",
    port: (config.port as number) ?? 5432,
  }
}
