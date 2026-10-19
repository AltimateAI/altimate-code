/**
 * SSH tunnel management for database connections.
 *
 * Uses the `ssh2` package (dynamic import). If ssh2 is not installed,
 * throws a clear error message.
 *
 * Tunnels are not keyed by connection name. Each `openTunnel()` call returns a
 * handle owned by the caller (the connection registry's connect attempt), and
 * only that handle closes it: an attempt that was superseded can never register
 * over, or close, a newer attempt's tunnel.
 */

import type { ConnectionConfig } from "@altimateai/drivers"
import type { Server, Socket } from "net"

export interface TunnelInfo {
  localPort: number
  close(): void
}

/** A tunnel being opened. `close()` works before or after `ready` settles and is idempotent. */
export interface TunnelHandle {
  /** Resolves once the local forwarding port listens; rejects on failure or when closed first. */
  readonly ready: Promise<TunnelInfo>
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

/** Every tunnel opened and not yet closed, for process-exit cleanup and `closeAllTunnels()`. */
const openTunnels = new Set<TunnelHandle>()

/** Clean up all tunnels on process exit. */
let cleanupRegistered = false
function ensureCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.once("exit", closeAllTunnels)
  process.once("SIGINT", () => {
    closeAllTunnels()
    process.exit(0)
  })
  process.once("SIGTERM", () => {
    closeAllTunnels()
    process.exit(0)
  })
}

/**
 * Open an SSH tunnel that forwards a local port to `config.host:config.port`.
 *
 * One terminal state covers every path: an error, a close before `ready`, or a
 * late `ready`/listen callback after either closes the client, the local server
 * and forwarded sockets, and never publishes a tunnel.
 */
export function openTunnel(config: SshConfig): TunnelHandle {
  let closed = false
  let client: any
  let server: Server | undefined
  const sockets = new Set<Socket>()
  let rejectReady: ((e: Error) => void) | undefined

  const close = () => {
    if (closed) return
    closed = true
    openTunnels.delete(handle)
    for (const socket of sockets) socket.destroy()
    try {
      server?.close()
    } catch {
      // ignore
    }
    try {
      client?.end()
    } catch {
      // ignore
    }
    rejectReady?.(new Error("SSH tunnel was closed before it was ready"))
  }

  const ready = (async (): Promise<TunnelInfo> => {
    let ssh2: any
    try {
      // @ts-expect-error — optional dependency
      ssh2 = await import("ssh2")
    } catch {
      throw new Error("SSH tunnel requires the ssh2 package. Run: bun add ssh2 @types/ssh2")
    }
    const net = await import("net")
    if (closed) throw new Error("SSH tunnel was closed before it was ready")
    ensureCleanup()

    return new Promise<TunnelInfo>((resolve, reject) => {
      rejectReady = reject
      client = new ssh2.Client()

      client.on("ready", () => {
        if (closed) return
        // Create a local TCP server that forwards to remote host:port via SSH
        server = net.createServer((localSocket) => {
          if (closed) {
            localSocket.destroy()
            return
          }
          sockets.add(localSocket)
          localSocket.on("close", () => sockets.delete(localSocket))
          client.forwardOut("127.0.0.1", 0, config.host, config.port, (err: Error | undefined, stream: any) => {
            if (err || closed) {
              localSocket.destroy()
              return
            }
            localSocket.pipe(stream).pipe(localSocket)
          })
        })

        server.on("error", (err: Error) => {
          reject(new Error(`SSH tunnel local server error: ${err.message}`))
          close()
        })

        server.listen(0, "127.0.0.1", () => {
          if (closed) return
          const addr = server?.address()
          const localPort = typeof addr === "object" && addr ? addr.port : 0
          resolve({ localPort, close })
        })
      })

      client.on("error", (err: Error) => {
        reject(new Error(`SSH connection error: ${err.message}`))
        close()
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
  })()

  const handle: TunnelHandle = { ready, close }
  openTunnels.add(handle)
  // Any failure ends in the terminal state; the caller still observes the rejection through `ready`.
  ready.catch(() => close())
  return handle
}

/** Close every open tunnel (process teardown and tests). */
export function closeAllTunnels(): void {
  for (const tunnel of [...openTunnels]) {
    try {
      tunnel.close()
    } catch {
      // best-effort
    }
  }
  openTunnels.clear()
}

/** Number of tunnels currently open or opening (diagnostics and tests). */
export function openTunnelCount(): number {
  return openTunnels.size
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
