import { AsyncLocalStorage } from "node:async_hooks"

export interface Credentials {
  altimateUrl: string
  altimateInstanceName: string
  altimateApiKey: string
  mcpServerUrl?: string
}

const credentials = new AsyncLocalStorage<Credentials>()

/** Pin every API/index operation in a bounded external-client request to one account. */
export function withCredentials<T>(snapshot: Credentials, run: () => Promise<T>): Promise<T> {
  return credentials.run(Object.freeze({ ...snapshot }), run)
}

export function currentCredentials(): Credentials | undefined {
  return credentials.getStore()
}
