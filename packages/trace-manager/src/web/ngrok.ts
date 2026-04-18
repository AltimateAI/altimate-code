export async function startNgrokTunnel(port: number): Promise<string> {
  try {
    // @ts-ignore — optional dependency, not installed at dev time
    const ngrok = await import("@ngrok/ngrok")
    const listener = await (ngrok as any).default.connect({
      addr: port,
      authtoken_from_env: true,
    })
    const url = listener.url()
    return url
  } catch {
    // Fallback: try the ngrok CLI binary
    const proc = Bun.spawn(["ngrok", "http", String(port), "--log=stdout", "--log-format=json"], {
      stdout: "pipe",
      stderr: "pipe",
    })

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ngrok timed out")), 15_000)
      const reader = proc.stdout.getReader()

      async function readLines() {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = new TextDecoder().decode(value)
          for (const line of text.split("\n")) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line)
              if (parsed.url) {
                clearTimeout(timeout)
                resolve(parsed.url)
                return
              }
            } catch {}
          }
        }
      }
      readLines().catch(reject)
    })
  }
}
