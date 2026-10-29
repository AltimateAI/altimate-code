import { describe, test, expect, afterEach } from "bun:test"
import { extractSshConfig, closeAllTunnels, openTunnelCount } from "../../src/altimate/native/connections/ssh-tunnel"

afterEach(() => {
  closeAllTunnels()
})

// ---------------------------------------------------------------------------
// extractSshConfig — pure function that extracts SSH tunnel config
// ---------------------------------------------------------------------------

describe("extractSshConfig", () => {
  test("returns null when no ssh_host is present", () => {
    const result = extractSshConfig({ type: "postgres", host: "db.example.com", port: 5432 })
    expect(result).toBeNull()
  })

  test("extracts full SSH config with all fields", () => {
    const result = extractSshConfig({
      type: "postgres",
      host: "db.internal",
      port: 5433,
      ssh_host: "bastion.example.com",
      ssh_port: 2222,
      ssh_user: "deployer",
      ssh_password: "secret",
    })
    expect(result).toEqual({
      ssh_host: "bastion.example.com",
      ssh_port: 2222,
      ssh_user: "deployer",
      ssh_password: "secret",
      ssh_private_key: undefined,
      host: "db.internal",
      port: 5433,
    })
  })

  test("applies defaults for ssh_port, ssh_user, host, port", () => {
    const result = extractSshConfig({
      type: "postgres",
      ssh_host: "bastion.example.com",
    })
    expect(result).not.toBeNull()
    expect(result!.ssh_port).toBe(22)
    expect(result!.ssh_user).toBe("root")
    expect(result!.host).toBe("127.0.0.1")
    expect(result!.port).toBe(5432)
  })

  test("throws when connection_string is used with SSH tunnel", () => {
    expect(() => extractSshConfig({
      type: "postgres",
      ssh_host: "bastion.example.com",
      connection_string: "postgresql://user:pass@host:5432/db",
    })).toThrow("Cannot use SSH tunnel with connection_string")
  })

  test("supports private key authentication", () => {
    const result = extractSshConfig({
      type: "snowflake",
      host: "db.internal",
      port: 443,
      ssh_host: "bastion.example.com",
      ssh_private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAA...",
    })
    expect(result).not.toBeNull()
    expect(result!.ssh_private_key).toBe("-----BEGIN OPENSSH PRIVATE KEY-----\nAAA...")
    expect(result!.ssh_password).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// closeAllTunnels — idempotent on empty state
// ---------------------------------------------------------------------------

describe("SSH tunnel state management", () => {
  test("closeAllTunnels is a no-op when nothing is open", () => {
    closeAllTunnels()
    closeAllTunnels()
    expect(openTunnelCount()).toBe(0)
  })
})
