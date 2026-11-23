// Connection profiles, env files, package-registry and git credential stores, cloud
// service-account keys, key material and Terraform variables. Matched on the file name.
const CREDENTIAL_FILE = new RegExp(
  "(^|/)(" +
    [
      "profiles\\.ya?ml",
      "\\.env[^/]*", // .env, .env.local, .env-prod, .envrc
      "[^/]+\\.env", // prod.env
      "\\.netrc",
      "\\.pgpass",
      "\\.npmrc",
      "\\.pypirc",
      "\\.git-credentials",
      "id_(rsa|dsa|ecdsa|ed25519)",
      "keyfile[^/]*\\.json",
      "[^/]*service[^/]*account[^/]*\\.json",
      "credentials[^/]*\\.json",
      "[^/]+\\.(pem|key|p12|pfx|p8|tfvars|tfvars\\.json)",
    ].join("|") +
    ")$",
  "i",
)

/** A path whose name says it may hold credentials; the AI lane and the verifier never read or show it. */
export function isCredentialPath(path: string): boolean {
  return CREDENTIAL_FILE.test(path)
}

const CREDENTIAL_CONTENT = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|"type"\s*:\s*"service_account"/

/** Text that carries a private key or a cloud service-account key, whatever the file is called. */
export function holdsCredentials(text: string): boolean {
  return CREDENTIAL_CONTENT.test(text)
}
