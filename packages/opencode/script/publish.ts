#!/usr/bin/env bun
import { $ } from "bun"
import fs from "fs"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

// NAPI native modules that must be installed alongside the CLI binary.
// These cannot be embedded in Bun's single-file executable — the JS loader
// dynamically require()s platform-specific .node binaries at runtime.
const altimateCoreDep = (pkg.dependencies as Record<string, string>)["@altimateai/altimate-core"]
if (!altimateCoreDep) {
  console.error("Missing required dependency: @altimateai/altimate-core in package.json")
  process.exit(1)
}
const runtimeDependencies: Record<string, string> = {
  "@altimateai/altimate-core": altimateCoreDep,
}

const driverPeerDependencies: Record<string, string> = {
  pg: ">=8",
  "snowflake-sdk": ">=1",
  "@google-cloud/bigquery": ">=8",
  "@databricks/sql": ">=1",
  mysql2: ">=3",
  mssql: ">=11",
  oracledb: ">=6",
  duckdb: ">=1",
  "@clickhouse/client": ">=1",
  "trino-client": ">=0.2",
}

const driverPeerDependenciesMeta: Record<string, { optional: true }> = Object.fromEntries(
  Object.keys(driverPeerDependencies).map((k) => [k, { optional: true as const }]),
)

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("**/package.json").scanSync({ cwd: "./dist" })) {
  const pkg = await Bun.file(`./dist/${filepath}`).json()
  // Skip synthesized package.json files (e.g. dbt-tools) that lack name/version
  if (!pkg.name || !pkg.version) continue
  binaries[pkg.name] = pkg.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]

// Build dbt-tools so we can bundle it alongside the CLI
console.log("Building dbt-tools...")
await $`bun run build`.cwd("../dbt-tools")
console.log("dbt-tools built successfully")

/**
 * Copy common assets (bin, skills, dbt-tools, postinstall, license, changelog)
 * into a target dist directory. Shared by scoped and unscoped packages.
 */
async function copyAssets(targetDir: string) {
  await $`cp -r ./bin ${targetDir}/bin`
  await $`cp -r ../../.opencode/skills ${targetDir}/skills`
  await $`cp ./script/postinstall.mjs ${targetDir}/postinstall.mjs`
  // Bundle dbt-tools: copy its bin wrapper + only the files it actually needs.
  // The full dist/ contains ~220 MB of .node native binaries from altimate-core
  // that bun copies as transitive build artifacts but dbt-tools never loads.
  await $`mkdir -p ${targetDir}/dbt-tools/bin`
  await $`cp ../dbt-tools/bin/altimate-dbt ${targetDir}/dbt-tools/bin/altimate-dbt`
  await $`mkdir -p ${targetDir}/dbt-tools/dist`
  await $`cp ../dbt-tools/dist/index.js ${targetDir}/dbt-tools/dist/`
  // node_python_bridge.py must live next to index.js — the patched __dirname
  // resolves to this directory at runtime (see copy-python.ts)
  await $`cp ../dbt-tools/dist/node_python_bridge.py ${targetDir}/dbt-tools/dist/`
  // A package.json with "type": "module" must be present so Node loads
  // dist/index.js as ESM instead of CJS. We synthesize a minimal one rather
  // than copying the full source package.json (which contains devDependencies
  // with Bun catalog: versions that would confuse vulnerability scanners).
  await Bun.file(`${targetDir}/dbt-tools/package.json`).write(JSON.stringify({ type: "module" }, null, 2) + "\n")
  if (fs.existsSync("../dbt-tools/dist/altimate_python_packages")) {
    await $`cp -r ../dbt-tools/dist/altimate_python_packages ${targetDir}/dbt-tools/dist/`
  }
  await Bun.file(`${targetDir}/LICENSE`).write(await Bun.file("../../LICENSE").text())
  await Bun.file(`${targetDir}/CHANGELOG.md`).write(await Bun.file("../../CHANGELOG.md").text())
}

await $`mkdir -p ./dist/${pkg.name}`
await copyAssets(`./dist/${pkg.name}`)
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${pkg.name}/CHANGELOG.md`).write(await Bun.file("../../CHANGELOG.md").text())

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      bin: {
        altimate: "./bin/altimate",
        "altimate-code": "./bin/altimate-code",
      },
      scripts: {
        postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      dependencies: runtimeDependencies,
      optionalDependencies: binaries,
      peerDependencies: driverPeerDependencies,
      peerDependenciesMeta: driverPeerDependenciesMeta,
    },
    null,
    2,
  ),
)

// Verify npm auth before publishing
console.log("Verifying npm authentication...")
const npmrcPath = process.env.NPM_CONFIG_USERCONFIG || "~/.npmrc"
console.log(`NPM_CONFIG_USERCONFIG=${npmrcPath}`)
try {
  const whoami = await $`npm whoami`.text()
  console.log(`npm whoami: ${whoami.trim()}`)
} catch (e: any) {
  console.error("npm whoami failed — auth may be misconfigured:", e?.stderr || e)
  process.exit(1)
}

const tasks = Object.entries(binaries).map(async ([name]) => {
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(`./dist/${name}`)
  }
  await $`bun pm pack`.cwd(`./dist/${name}`)
  // Retry up to 3 times — npm returns transient 404s when multiple scoped
  // packages under the same org are published concurrently.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(`./dist/${name}`)
      break
    } catch (e: any) {
      const isRetryable = String(e?.stderr ?? e).includes("E404") || String(e?.stderr ?? e).includes("ETIMEDOUT")
      if (isRetryable && attempt < 3) {
        console.warn(`npm publish ${name} attempt ${attempt} failed (retryable), retrying in ${attempt * 5}s...`)
        await Bun.sleep(attempt * 5000)
      } else {
        throw e
      }
    }
  }
})
await Promise.all(tasks)
await $`cd ./dist/${pkg.name} && bun pm pack && npm publish *.tgz --access public --tag ${Script.channel}`

// Publish unscoped `altimate-code` wrapper package so users can `npm i -g altimate-code`
const unscopedName = "altimate-code"
const unscopedDir = `./dist/${unscopedName}`
try {
  await $`mkdir -p ${unscopedDir}`
  await copyAssets(unscopedDir)
  await Bun.file(`${unscopedDir}/README.md`).write(await Bun.file("../../README.md").text())
  await Bun.file(`${unscopedDir}/package.json`).write(
    JSON.stringify(
      {
        name: unscopedName,
        description: "The AI-native data engineering agent for the terminal",
        repository: {
          type: "git",
          url: "git+https://github.com/AltimateAI/altimate-code.git",
        },
        homepage: "https://github.com/AltimateAI/altimate-code#readme",
        bugs: "https://github.com/AltimateAI/altimate-code/issues",
        bin: {
          altimate: "./bin/altimate",
          "altimate-code": "./bin/altimate-code",
        },
        scripts: {
          postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
        },
        version: version,
        license: pkg.license,
        dependencies: runtimeDependencies,
        optionalDependencies: binaries,
        peerDependencies: driverPeerDependencies,
        peerDependenciesMeta: driverPeerDependenciesMeta,
      },
      null,
      2,
    ),
  )
  await $`cd ${unscopedDir} && bun pm pack && npm publish *.tgz --access public --tag ${Script.channel}`
} catch (e) {
  console.error("Unscoped package publish failed:", e)
  process.exit(1)
}

// Docker (non-fatal — requires buildx multi-platform setup)
try {
  const image = "ghcr.io/altimateai/altimate-code"
  const platforms = "linux/amd64,linux/arm64"
  const tags = [`${image}:${version}`, `${image}:${Script.channel}`]
  const tagFlags = tags.flatMap((t) => ["-t", t])
  await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
} catch (e) {
  console.warn("Docker publish failed (non-fatal):", e)
}

// registries
if (!Script.preview) {
  // Calculate SHA values. Archive names follow the standalone-binary scheme
  // (`altimate-<target>.{tar.gz,zip}`) — see build.ts archive step.
  const arm64Sha = await $`sha256sum ./dist/altimate-linux-arm64.tar.gz | cut -d' ' -f1`
    .text()
    .then((x) => x.trim())
  const x64Sha = await $`sha256sum ./dist/altimate-linux-x64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const macX64Sha = await $`sha256sum ./dist/altimate-darwin-x64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
  const macArm64Sha = await $`sha256sum ./dist/altimate-darwin-arm64.zip | cut -d' ' -f1`
    .text()
    .then((x) => x.trim())

  const [pkgver, _subver = ""] = Script.version.split(/(-.*)/, 2)

  // AUR (non-fatal — requires AUR SSH key setup)
  try {
    const binaryPkgbuild = [
      "# Maintainer: AltimateAI",
      "",
      "pkgname='altimate-code-bin'",
      `pkgver=${pkgver}`,
      `_subver=${_subver}`,
      "options=('!debug' '!strip')",
      "pkgrel=1",
      "pkgdesc='The AI coding agent built for the terminal.'",
      "url='https://github.com/AltimateAI/altimate-code'",
      "arch=('aarch64' 'x86_64')",
      "license=('MIT')",
      "provides=('altimate-code')",
      "conflicts=('altimate-code')",
      "depends=('ripgrep')",
      "",
      `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/AltimateAI/altimate-code/releases/download/v\${pkgver}\${_subver}/altimate-linux-arm64.tar.gz")`,
      `sha256sums_aarch64=('${arm64Sha}')`,

      `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/AltimateAI/altimate-code/releases/download/v\${pkgver}\${_subver}/altimate-linux-x64.tar.gz")`,
      `sha256sums_x86_64=('${x64Sha}')`,
      "",
      "package() {",
      '  install -Dm755 ./altimate "${pkgdir}/usr/bin/altimate"',
      '  ln -sf altimate "${pkgdir}/usr/bin/altimate-code"',
      "}",
      "",
    ].join("\n")

    for (const [pkg, pkgbuild] of [["altimate-code-bin", binaryPkgbuild]]) {
      for (let i = 0; i < 30; i++) {
        try {
          await $`rm -rf ./dist/aur-${pkg}`
          await $`git clone ssh://aur@aur.archlinux.org/${pkg}.git ./dist/aur-${pkg}`
          await $`cd ./dist/aur-${pkg} && git checkout master`
          await Bun.file(`./dist/aur-${pkg}/PKGBUILD`).write(pkgbuild)
          await $`cd ./dist/aur-${pkg} && makepkg --printsrcinfo > .SRCINFO`
          await $`cd ./dist/aur-${pkg} && git add PKGBUILD .SRCINFO`
          await $`cd ./dist/aur-${pkg} && git commit -m "Update to v${Script.version}"`
          await $`cd ./dist/aur-${pkg} && git push`
          break
        } catch (e) {
          continue
        }
      }
    }
  } catch (e) {
    console.warn("AUR publish failed (non-fatal):", e)
  }

  // Homebrew formula (non-fatal — requires homebrew-tap repo)
  try {
    const homebrewFormula = [
      "# typed: false",
      "# frozen_string_literal: true",
      "",
      "class AltimateCode < Formula",
      `  desc "The AI coding agent built for the terminal."`,
      `  homepage "https://github.com/AltimateAI/altimate-code"`,
      `  version "${Script.version.split("-")[0]}"`,
      "",
      `  depends_on "ripgrep"`,
      "",
      "  on_macos do",
      "    if Hardware::CPU.intel?",
      `      url "https://github.com/AltimateAI/altimate-code/releases/download/v${Script.version}/altimate-darwin-x64.zip"`,
      `      sha256 "${macX64Sha}"`,
      "",
      "      def install",
      '        bin.install "altimate"',
      '        bin.install_symlink "altimate" => "altimate-code"',
      "      end",
      "    end",
      "    if Hardware::CPU.arm?",
      `      url "https://github.com/AltimateAI/altimate-code/releases/download/v${Script.version}/altimate-darwin-arm64.zip"`,
      `      sha256 "${macArm64Sha}"`,
      "",
      "      def install",
      '        bin.install "altimate"',
      '        bin.install_symlink "altimate" => "altimate-code"',
      "      end",
      "    end",
      "  end",
      "",
      "  on_linux do",
      "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
      `      url "https://github.com/AltimateAI/altimate-code/releases/download/v${Script.version}/altimate-linux-x64.tar.gz"`,
      `      sha256 "${x64Sha}"`,
      "      def install",
      '        bin.install "altimate"',
      '        bin.install_symlink "altimate" => "altimate-code"',
      "      end",
      "    end",
      "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
      `      url "https://github.com/AltimateAI/altimate-code/releases/download/v${Script.version}/altimate-linux-arm64.tar.gz"`,
      `      sha256 "${arm64Sha}"`,
      "      def install",
      '        bin.install "altimate"',
      '        bin.install_symlink "altimate" => "altimate-code"',
      "      end",
      "    end",
      "  end",
      "end",
      "",
      "",
    ].join("\n")

    const token = process.env.GITHUB_TOKEN
    if (!token) {
      console.warn("GITHUB_TOKEN is required to update homebrew tap, skipping")
    } else {
      const tap = `https://x-access-token:${token}@github.com/AltimateAI/homebrew-tap.git`
      await $`rm -rf ./dist/homebrew-tap`
      await $`git clone ${tap} ./dist/homebrew-tap`
      await Bun.file("./dist/homebrew-tap/altimate-code.rb").write(homebrewFormula)
      await $`cd ./dist/homebrew-tap && git add altimate-code.rb`
      await $`cd ./dist/homebrew-tap && git commit -m "Update to v${Script.version}"`
      await $`cd ./dist/homebrew-tap && git push`
    }
  } catch (e) {
    console.warn("Homebrew publish failed (non-fatal):", e)
  }
}
