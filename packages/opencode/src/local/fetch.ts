import { createHash, timingSafeEqual } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import type { LlamaRecipeTier, ModelRecipe } from "./recipes"
import { ensureLocalDirectories, getLocalPaths, type LocalPaths } from "./paths"

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class MissingChecksumError extends Error {
  constructor(readonly checksum: string) {
    super(`Artifact checksum is not pinned (${checksum}). Replace the TODO_* recipe value before downloading.`)
    this.name = "MissingChecksumError"
  }
}

export class ChecksumMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`sha256 mismatch: expected ${expected}, got ${actual}`)
    this.name = "ChecksumMismatchError"
  }
}

export function requirePinnedSha256(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new MissingChecksumError(value)
  return value.toLowerCase()
}

export async function sha256File(file: string) {
  const hash = createHash("sha256")
  await pipeline(createReadStream(file), hash)
  return hash.digest("hex")
}

export async function verifySha256(file: string, expectedInput: string) {
  const expected = requirePinnedSha256(expectedInput)
  const actual = await sha256File(file)
  const left = Buffer.from(actual, "hex")
  const right = Buffer.from(expected, "hex")
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new ChecksumMismatchError(expected, actual)
  return actual
}

export interface DownloadProgress {
  received: number
  total?: number
  resumed: boolean
}

export async function downloadWithResume(input: {
  url: string
  destination: string
  sha256: string
  fetchImpl?: Fetch
  onProgress?: (progress: DownloadProgress) => void
}) {
  const expected = requirePinnedSha256(input.sha256)
  const fetchImpl = input.fetchImpl ?? fetch
  await fs.mkdir(path.dirname(input.destination), { recursive: true })

  try {
    const stat = await fs.stat(input.destination)
    const actual = await verifySha256(input.destination, expected)
    input.onProgress?.({ received: stat.size, total: stat.size, resumed: false })
    return { path: input.destination, sha256: actual, bytes: stat.size, resumed: false }
  } catch (error) {
    if (error instanceof ChecksumMismatchError) throw error
  }

  const partial = `${input.destination}.partial`
  const offset = await fs
    .stat(partial)
    .then((stat) => stat.size)
    .catch(() => 0)
  const headers = new Headers()
  if (offset > 0) headers.set("range", `bytes=${offset}-`)
  const response = await fetchImpl(input.url, { headers })

  if (response.status === 416 && offset > 0) {
    try {
      const actual = await verifySha256(partial, expected)
      await fs.rename(partial, input.destination)
      return { path: input.destination, sha256: actual, bytes: offset, resumed: true }
    } catch (error) {
      // A stale/oversized .partial that fails the pinned checksum must not
      // be left in place: every subsequent run would resume from the same
      // offset, get 416 again, and fail identically forever. Same cleanup
      // as the post-download mismatch path below.
      if (error instanceof ChecksumMismatchError) await fs.unlink(partial).catch(() => {})
      throw error
    }
  }
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${input.url}`)
  if (!response.body) throw new Error(`Download returned no response body: ${input.url}`)

  let append = offset > 0 && response.status === 206
  if (append) {
    const range = response.headers.get("content-range")?.match(/^bytes\s+(\d+)-/i)
    if (!range || Number(range[1]) !== offset) throw new Error("Download server returned an invalid Content-Range")
  }
  const receivedAtStart = append ? offset : 0
  // `?? NaN` (not a bare `Number(null)`, which is 0): a response without a
  // Content-Length header (chunked/gzip transfers) must report an unknown
  // total, not a total that equals whatever's already been received —
  // which would make `received` immediately exceed `total` as new bytes
  // arrive, corrupting progress percentages downstream.
  const length = Number(response.headers.get("content-length") ?? NaN)
  const total = Number.isFinite(length) && length >= 0 ? receivedAtStart + length : undefined
  let received = receivedAtStart
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      input.onProgress?.({ received, total, resumed: append })
      callback(null, chunk)
    },
  })
  input.onProgress?.({ received, total, resumed: append })
  await pipeline(
    Readable.fromWeb(response.body as never),
    progress,
    createWriteStream(partial, { flags: append ? "a" : "w" }),
  )

  try {
    const actual = await verifySha256(partial, expected)
    const stat = await fs.stat(partial)
    await fs.rename(partial, input.destination)
    return { path: input.destination, sha256: actual, bytes: stat.size, resumed: append }
  } catch (error) {
    if (error instanceof ChecksumMismatchError) await fs.unlink(partial).catch(() => {})
    throw error
  }
}

function encodePath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/")
}

export function huggingFaceArtifactUrl(input: {
  repo: string
  revision: string
  file: string
  env?: NodeJS.ProcessEnv
}) {
  const env = input.env ?? process.env
  const base = (env.ALTIMATE_LOCAL_HF_BASE_URL || "https://huggingface.co").replace(/\/+$/, "")
  return `${base}/${encodePath(input.repo)}/resolve/${encodeURIComponent(input.revision)}/${encodePath(input.file)}?download=true`
}

export async function fetchModelArtifacts(input: {
  model: ModelRecipe
  tier: LlamaRecipeTier
  mtp?: boolean
  paths?: LocalPaths
  env?: NodeJS.ProcessEnv
  fetchImpl?: Fetch
  onProgress?: (artifact: "model" | "mtp", progress: DownloadProgress) => void
}) {
  const env = input.env ?? process.env
  const paths = input.paths ?? getLocalPaths(env)
  await ensureLocalDirectories(paths)
  const directory = path.join(paths.models, input.model.id, input.model.revision)
  const modelPath = path.join(directory, path.basename(input.tier.file))
  const model = await downloadWithResume({
    url: huggingFaceArtifactUrl({
      repo: input.model.hf_repo,
      revision: input.model.revision,
      file: input.tier.file,
      env,
    }),
    destination: modelPath,
    sha256: input.tier.sha256,
    fetchImpl: input.fetchImpl,
    onProgress: (progress) => input.onProgress?.("model", progress),
  })

  const useMtp = input.mtp !== false && input.tier.mtp
  if (!useMtp) return { model, mtp: undefined }
  const mtpPath = path.join(directory, path.basename(useMtp.file))
  const mtp = await downloadWithResume({
    url: huggingFaceArtifactUrl({ repo: input.model.hf_repo, revision: input.model.revision, file: useMtp.file, env }),
    destination: mtpPath,
    sha256: useMtp.sha256,
    fetchImpl: input.fetchImpl,
    onProgress: (progress) => input.onProgress?.("mtp", progress),
  })
  return { model, mtp }
}
