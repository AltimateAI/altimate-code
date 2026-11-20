const enc = new TextEncoder()

function header(name: string, value: string): Uint8Array {
  const n = enc.encode(name)
  const v = enc.encode(value)
  const out = new Uint8Array(1 + n.length + 1 + 2 + v.length)
  out[0] = n.length
  out.set(n, 1)
  out[1 + n.length] = 7 // header value type: string
  new DataView(out.buffer).setUint16(2 + n.length, v.length, false)
  out.set(v, 4 + n.length)
  return out
}

/** Encode one `application/vnd.amazon.eventstream` message frame carrying a JSON payload. */
export function eventStreamFrame(eventType: string, payload: unknown): Uint8Array {
  const headers = [
    header(":event-type", eventType),
    header(":content-type", "application/json"),
    header(":message-type", "event"),
  ]
  const headersLen = headers.reduce((a, h) => a + h.length, 0)
  const body = enc.encode(JSON.stringify(payload))
  const total = 12 + headersLen + body.length + 4
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, total, false)
  dv.setUint32(4, headersLen, false)
  dv.setUint32(8, Bun.hash.crc32(out.subarray(0, 8)) as number, false)
  let off = 12
  for (const h of headers) {
    out.set(h, off)
    off += h.length
  }
  out.set(body, off)
  dv.setUint32(total - 4, Bun.hash.crc32(out.subarray(0, total - 4)) as number, false)
  return out
}
