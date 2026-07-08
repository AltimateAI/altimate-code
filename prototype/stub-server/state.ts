// Altimate Code onboarding prototype — stub-server state machine.
//
// Models one sign-in session per device flow. The device-auth wire contract
// mirrors packages/opencode/src/account/index.ts exactly (standard OAuth device
// grant); the instance/provisioning steps are modeled as bearer-authenticated
// follow-up calls after the token arrives, the same way account/index.ts models
// its own /api/user and /api/orgs follow-ups.
//
// Session lifecycle:
//   pending -> authorized(email)            (web sign-in flips this)
//   [token minted on first poll once authorized]
//   instance: none -> provisioning -> ready(api_key)   (bearer follow-ups)

export const PROVISION_DELAY_MS = 8_000

export type SessionStatus = "pending" | "authorized"
export type InstanceStatus = "none" | "provisioning" | "ready"

export interface Session {
  deviceCode: string
  userCode: string
  clientId: string
  status: SessionStatus
  email?: string
  suggestedInstance?: string
  accessToken?: string
  refreshToken?: string
  instance?: string
  instanceStatus: InstanceStatus
  provisionReadyAt?: number
  apiKey?: string
  createdAt: number
}

export interface PendingEmail {
  userCode: string
  email: string
  verified: boolean
}

const byDevice = new Map<string, Session>()
const byUser = new Map<string, string>() // userCode -> deviceCode
const byToken = new Map<string, string>() // accessToken -> deviceCode
const byRefresh = new Map<string, string>() // refreshToken -> deviceCode
const pendingEmails = new Map<string, PendingEmail>() // userCode -> pending email

// Seed the collision demo: "acme" is already taken, so priya@acme.com's
// suggested instance ("acme") collides once and the CLI offers "acme-2".
const takenInstances = new Set<string>(["acme"])

const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
])

const VALID_TENANT_REGEX = /^[a-z_][a-z0-9_-]*$/

function rand(len: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let out = ""
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

function randLower(len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

export function userCodeFormat(): string {
  // Matches the [A-Z0-9]{4}-[A-Z0-9]{4,5} shape the TUI already recognizes.
  return `${rand(4)}-${rand(4)}`
}

export function isPersonalEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? ""
  return PERSONAL_EMAIL_DOMAINS.has(domain)
}

export function suggestedInstanceFromEmail(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? ""
  const base = domain.split(".")[0] ?? "workspace"
  const cleaned = base.replace(/[^a-z0-9_-]/g, "")
  return VALID_TENANT_REGEX.test(cleaned) ? cleaned : "workspace"
}

export function isInstanceTaken(name: string): boolean {
  return takenInstances.has(name.toLowerCase())
}

export function claimInstance(name: string): void {
  takenInstances.add(name.toLowerCase())
}

export function createSession(clientId: string): Session {
  const deviceCode = `dev_${randLower(24)}`
  const userCode = userCodeFormat()
  const session: Session = {
    deviceCode,
    userCode,
    clientId,
    status: "pending",
    instanceStatus: "none",
    createdAt: Date.now(),
  }
  byDevice.set(deviceCode, session)
  byUser.set(userCode, deviceCode)
  return session
}

export function getByDevice(deviceCode: string): Session | undefined {
  return byDevice.get(deviceCode)
}

export function getByUser(userCode: string): Session | undefined {
  const deviceCode = byUser.get(userCode.toUpperCase().trim())
  return deviceCode ? byDevice.get(deviceCode) : undefined
}

export function getByToken(accessToken: string): Session | undefined {
  const deviceCode = byToken.get(accessToken)
  return deviceCode ? byDevice.get(deviceCode) : undefined
}

export function getByRefresh(refreshToken: string): Session | undefined {
  const deviceCode = byRefresh.get(refreshToken)
  return deviceCode ? byDevice.get(deviceCode) : undefined
}

/** Flip a session to authorized once the user finishes web sign-in. */
export function authorize(session: Session, email: string): void {
  session.status = "authorized"
  session.email = email
  session.suggestedInstance = suggestedInstanceFromEmail(email)
}

/** Standard OAuth: mint (or return existing) bearer + refresh token. */
export function mintToken(session: Session): { access: string; refresh: string } {
  if (!session.accessToken) {
    session.accessToken = `at_${randLower(32)}`
    session.refreshToken = `rt_${randLower(32)}`
    byToken.set(session.accessToken, session.deviceCode)
    byRefresh.set(session.refreshToken, session.deviceCode)
  }
  return { access: session.accessToken!, refresh: session.refreshToken! }
}

export function rotateToken(session: Session): { access: string; refresh: string } {
  if (session.accessToken) byToken.delete(session.accessToken)
  if (session.refreshToken) byRefresh.delete(session.refreshToken)
  session.accessToken = `at_${randLower(32)}`
  session.refreshToken = `rt_${randLower(32)}`
  byToken.set(session.accessToken, session.deviceCode)
  byRefresh.set(session.refreshToken, session.deviceCode)
  return { access: session.accessToken, refresh: session.refreshToken }
}

export function startProvisioning(session: Session, name: string): void {
  session.instance = name
  session.instanceStatus = "provisioning"
  session.provisionReadyAt = Date.now() + PROVISION_DELAY_MS
  claimInstance(name)
}

/** Returns the current instance status, minting the API key on first ready. */
export function pollInstance(session: Session): { status: InstanceStatus; instance?: string; apiKey?: string } {
  if (session.instanceStatus === "provisioning" && session.provisionReadyAt && Date.now() >= session.provisionReadyAt) {
    session.instanceStatus = "ready"
    session.apiKey = `alt_proto_${randLower(28)}`
  }
  return { status: session.instanceStatus, instance: session.instance, apiKey: session.apiKey }
}

export function recordPendingEmail(userCode: string, email: string): void {
  pendingEmails.set(userCode.toUpperCase().trim(), { userCode: userCode.toUpperCase().trim(), email, verified: false })
}

export function listPendingEmails(): PendingEmail[] {
  return [...pendingEmails.values()]
}

export function markEmailVerified(userCode: string): PendingEmail | undefined {
  const pending = pendingEmails.get(userCode.toUpperCase().trim())
  if (pending) pending.verified = true
  return pending
}
