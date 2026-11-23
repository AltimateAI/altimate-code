// Connection profiles, env files, package-registry, git, cloud, Docker and Kubernetes credential
// stores, service-account and OAuth client keys, key material and Terraform variables. Matched on the file name.
const CREDENTIAL_FILE = new RegExp(
  "(^|/)(" +
    [
      // profiles.yml, dbt_profiles.yml, profiles-ci.yml, profiles.yml.example; not a model's
      // schema file such as customer_profiles.yml
      "(dbt[_-]?)?profiles([._-][^/]*)?\\.ya?ml(\\.[^/]*)?",
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
      "\\.aws/credentials",
      "\\.docker/config\\.json",
      "kubeconfig",
      "secrets?\\.(ya?ml|json)",
      "client_secret[^/]*\\.json",
      "[^/]+\\.(pem|key|p12|pfx|p8|tfvars|tfvars\\.json)",
    ].join("|") +
    ")$",
  "i",
)

/**
 * A path whose name says it may hold credentials. A changed file named so, now or before a
 * rename, is not sent to the AI lane, and the verifier neither reads it (either side) nor shows its grep hits.
 */
export function isCredentialPath(path: string): boolean {
  return CREDENTIAL_FILE.test(path)
}

const CREDENTIAL_CONTENT = /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY(?: BLOCK)?-----|"type"\s*:\s*"service_account"/

/** Text that carries a private key (PEM, OpenSSH or PGP armor) or a cloud service-account key, whatever the file is called. */
export function holdsCredentials(text: string): boolean {
  return CREDENTIAL_CONTENT.test(text)
}
