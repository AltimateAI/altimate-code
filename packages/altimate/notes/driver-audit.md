# Driver install-path audit

2026-10-15. Offline audit of the v2 spike and installed v1 packages. No packages were installed and no lifecycle scripts were run.

**Blocking cases first:** legacy `duckdb@1.4.4` needs an install script. Keep the spike's replacement, `@duckdb/node-api`. Databricks can fail on compressed CloudFetch results because its optional `lz4` addon needs compilation. DuckDB's Linux musl support is not established by the available files. Do not promise that target yet.

**Verdicts: 10 OK as-is, 3 OK with change, 0 driver-wide BLOCKED.** The changes are Databricks result options, Oracle's shared-module mutation, and an explicit DuckDB platform policy pending musl verification. These verdicts concern SDK delivery and the inspected driver paths. They do not certify live connections or every authentication mode.

There is also a common packaging prerequisite. The spike declares only `@duckdb/node-api` in `packages/drivers/package.json:13`. Its plugin currently dispatches only to DuckDB (`packages/altimate/src/server.ts:38`). Declare the selected SDKs in the eventual published package and add driver dispatch. The old optional dependency list is not inherited from the fork. Arborist disables scripts at `packages/util/src/npm.ts:219` and `:225`.

| Driver | Imported npm package and exact lock version | Loading | Native/install finding | Installed closure, MiB | Verdict |
| --- | --- | --- | --- | ---: | --- |
| Databricks | `@databricks/sql@1.16.0` | Optional, dynamic | Optional `lz4@0.6.5` needs `node-gyp`; optional prebuilt kernel is not selected | 37.27; 18.80 without optional branches | **OK with change:** disable CloudFetch and LZ4 on every statement |
| DuckDB | `@duckdb/node-api@1.4.4-r.1` from spike lock; fork instead locks `duckdb@1.4.4` | Dynamic; static import is type-only | Required platform binary delivered through optional npm packages; no scripts | 106.03 on darwin-arm64 | **OK with change:** retain new API; gate musl or supply validated musl binaries |
| Oracle | `oracledb@6.10.0` | Optional, dynamic | Bundled Thick binaries; install hook is unnecessary for JS Thin | 4.14 | **OK with change:** remove shared export mutation; check Thin mode |
| BigQuery | `@google-cloud/bigquery@8.3.1` | Optional, dynamic | No native or install-hook offenders | 12.09 | **OK as-is** |
| ClickHouse | `@clickhouse/client@1.21.0` | Optional, dynamic | No native or install-hook offenders | 0.68 | **OK as-is** |
| MongoDB | `mongodb@6.21.0` | Optional, dynamic | Native feature peers are absent and optional | 7.35 base | **OK as-is** for ordinary auth and no native compression |
| MySQL | `mysql2@3.14.4`, subpath `mysql2/promise` | Optional, dynamic | No native or install-hook offenders | 1.34 | **OK as-is** |
| PostgreSQL | `pg@8.22.0` | Optional, dynamic | `pg-native` is absent and optional; normal Pool is JS | 0.44 | **OK as-is** |
| Redshift | `pg@8.22.0` | Optional, dynamic | Same JS Pool and closure as PostgreSQL | 0.44, shared with PostgreSQL | **OK as-is** |
| Snowflake | `snowflake-sdk@2.4.3` | Optional, dynamic | Bundled native minicore has a caught-load fallback; no install hooks | 72.39 | **OK as-is** |
| SQLite | No npm package; builtin `bun:sqlite` | Static inside driver module | Native SQLite belongs to Bun, not the plugin's npm tree | 0 incremental npm | **OK as-is** in Bun |
| SQL Server | `mssql@12.5.5`; conditional `@azure/identity@4.13.1` | Optional, dynamic | Default Tedious implementation is JS; no native ODBC dependency | 46.45 | **OK as-is** |
| Trino | `trino-client@0.2.9` | Optional, dynamic | No native or install-hook offenders | 2.85 | **OK as-is** |

## Method and evidence paths

Source paths without a prefix are relative to this spike. `V` means `/Users/anandgupta/codebase/altimate-code`. `S` means `/Users/anandgupta/codebase/altimate-code-v2-spike`. `V/bun.lock` supplies exact SDK versions, except for the new DuckDB API, which exists only in `S/bun.lock`.

“Optional” in the loading column describes the deferred loader and its missing-package handling. It does not mean the spike currently declares that SDK in `optionalDependencies`.

The workspace dependency links were stale for BigQuery, ClickHouse, Databricks, PostgreSQL, Snowflake and SQL Server. They selected 8.1.1, 1.18.3, 1.13.0, 8.20.0, 2.4.0 and 12.5.0 respectively. The exact locked versions also exist in the installed `.bun` store. This audit uses those exact versions.

The dependency walk read package manifests recursively. It followed required dependencies, present optional dependencies and required peers using each package's actual filesystem resolution. It excluded development dependencies and optional peers from base sizes. MongoDB's available optional peers were checked separately. No required dependency edge was missing. Uninstalled foreign-platform optional packages were recorded, not treated as broken installations.

Each closure was scanned for `binding.gyp`, `.node` files, native installer dependencies (`node-pre-gyp`, `prebuild-install`, `node-gyp-build`, `node-gyp`), and `preinstall`/`install`/`postinstall` hooks. All positive findings are listed below. Build, prepare and prepack scripts alone are not consumer-install requirements when the compiled entry is already distributed.

Sizes sum logical file bytes in unique real package directories, excluding nested `node_modules` from each package's own size. They include distributed source, types, docs and installed binaries. They are not compressed download sizes or filesystem allocation sizes. Shared dependencies are counted once per driver, so the rows must not be added together. Host-platform sizes are not estimates for every other platform. Databricks includes an already-built local LZ4 payload that a fresh script-free install would not produce.

Installed-file evidence supports the packaging conclusions; it does not independently authenticate registry tarball contents. Other-platform payloads that are absent locally need a later registry check. Cross-platform binary execution needs the corresponding Bun hosts. No such checks used the network here. Codebase graph access was unavailable under the tool approval policy, so discovery used local source and manifests.

Installed package aliases used in the file:line references below:

```text
BQ = V/node_modules/.bun/@google-cloud+bigquery@8.3.1+759ce506b1ed1a42/node_modules/@google-cloud/bigquery
CH = V/node_modules/.bun/@clickhouse+client@1.21.0/node_modules/@clickhouse/client
DBX = V/node_modules/.bun/@databricks+sql@1.16.0+790ea5f46940ef6d/node_modules/@databricks/sql
LZ4 = V/node_modules/.bun/lz4@0.6.5/node_modules/lz4
DBXBIN = V/node_modules/.bun/@databricks+databricks-sql-kernel-darwin-arm64@0.2.0/node_modules/@databricks/databricks-sql-kernel-darwin-arm64
DUCK = S/node_modules/.bun/@duckdb+node-api@1.4.4-r.1/node_modules/@duckdb/node-api
DUCKB = S/node_modules/.bun/@duckdb+node-bindings@1.4.4-r.1/node_modules/@duckdb/node-bindings
DUCKBIN = S/node_modules/.bun/@duckdb+node-bindings-darwin-arm64@1.4.4-r.1/node_modules/@duckdb/node-bindings-darwin-arm64
OLD = V/packages/drivers/node_modules/duckdb
ORA = V/node_modules/.bun/oracledb@6.10.0/node_modules/oracledb
MONGO = V/packages/drivers/node_modules/mongodb
MYSQL = V/node_modules/.bun/mysql2@3.14.4/node_modules/mysql2
PG = V/node_modules/.bun/pg@8.22.0+51226add061828f6/node_modules/pg
SF = V/node_modules/.bun/snowflake-sdk@2.4.3+302f8eed98f6f908/node_modules/snowflake-sdk
MSSQL = V/node_modules/.bun/mssql@12.5.5+759ce506b1ed1a42/node_modules/mssql
TEDIOUS = V/node_modules/.bun/tedious@19.2.1+759ce506b1ed1a42/node_modules/tedious
TRINO = V/node_modules/.bun/trino-client@0.2.9/node_modules/trino-client
```

## Databricks

- Loads `@databricks/sql` at `packages/drivers/src/databricks.ts:10`. Exact version: `V/bun.lock:873`. The installed closure has 116 packages.
- **Offender: optional `lz4@0.6.5`.** It declares `gypfile` and `install: node-gyp rebuild` (`LZ4/package.json:25`, `:56`). `LZ4/binding.gyp:4` and `:16` build `xxhash.node` and `lz4.node` using NAN headers. Both built files exist locally. They are not evidence of shipped prebuilts. There are no per-platform prebuilt dependencies for LZ4. The normal entry unconditionally requires native modules (`LZ4/lib/utils.js:4`, `:40`), so its JS decoder is not a usable native-free mode through that entry.
- **Other native packages: optional SQL kernel `0.2.0`.** `DBX/package.json:94` and `V/bun.lock:857` list `@databricks/databricks-sql-kernel-` packages for `darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl`, and `win32-x64-msvc`, plus Windows arm64. The installed Darwin arm64 package explicitly includes `index.darwin-arm64.node` and has no install hook (`DBXBIN/package.json:10`). Other payloads are absent locally and need registry/platform verification.
- Our driver passes host, path and token, without `useKernel` (`packages/drivers/src/databricks.ts:29`). The SDK therefore chooses JS Thrift (`DBX/dist/DBSQLClient.js:560`). The kernel is not required for this path. Its switch is internal, not a public typed option (`:556`), so enabling it is not the preferred minimal fix.
- Missing or unloadable LZ4 is caught (`DBX/dist/utils/lz4.js:5`). However, CloudFetch and LZ4 default to enabled (`DBX/dist/DBSQLClient.js:108`). CloudFetch advertisement does not depend on working LZ4 (`DBX/dist/thrift-backend/ThriftSessionBackend.js:136`). Compressed CloudFetch results then throw without it (`DBX/dist/result/CloudFetchResultHandler.js:44`). This is a concrete conditional failure, not a claim that every query fails.
- **Change:** pass `{ useCloudFetch: false, useLZ4Compression: false }` to all statement calls at `packages/drivers/src/databricks.ts:58`, `:77`, `:89` and `:107`. This retains JS Thrift and covers metadata queries too. No npm native binary is then needed on any requested target. Validate this behavior against a live warehouse later.
- Host APIs: HTTP(S), streams, events and Buffer through Thrift/node-fetch. The unused kernel loader uses `process.report` and an `ldd` subprocess fallback to choose GNU/musl (`DBX/native/kernel/index.js:16`). Its Bun compatibility remains untested.

## DuckDB

- Runtime loading is lazy at `packages/drivers/src/duckdb.ts:61`; line 2 is type-only. `S/bun.lock:1703` pins `@duckdb/node-api@1.4.4-r.1`, which requires `@duckdb/node-bindings@1.4.4-r.1`. This package is absent from the fork lock. The fork's `duckdb@1.4.4` is a different API (`V/bun.lock:1835`).
- **Required native payload:** one `@duckdb/node-bindings-<platform>@1.4.4-r.1`. These packages are optional only in npm metadata. The loader requires the matching binary without a JS fallback (`DUCKB/duckdb.js:1`). No install hook or native build helper occurs in the new API's installed three-package closure.
- Advertised payloads are `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` and `win32-x64` (`DUCKB/package.json:7`; `S/bun.lock:1705`). The Darwin arm64 package contains `duckdb.node` and `libduckdb.dylib`, about 105.54 MiB together. Its manifest has OS/CPU constraints and no install script (`DUCKBIN/package.json:1`).
- **Linux libc gap:** the loader checks OS and architecture only. It has no musl branch, and no musl-specific package is listed. Only Darwin arm64 is installed here. Neither the Linux glibc baseline nor musl compatibility can be established from these files (`DUCKB/duckdb.js:1`; `DUCK/README.md:23`). This is unverified support, not proof that musl cannot work.
- **Change:** keep the new API and explicitly gate musl support until the Linux payloads and Bun execution are checked. If musl is required and those binaries fail, ship suitable prebuilt bindings or choose another delivery path. Do not fall back to compiling during plugin installation.
- **Blocked alternative:** legacy `duckdb@1.4.4` has `binding.gyp`, an installed `lib/binding/duckdb.node`, and `install: node-pre-gyp install --fallback-to-build` (`OLD/package.json:7`, `:19`). Required build/delivery helpers are `@mapbox/node-pre-gyp@2.0.3`, `node-gyp@9.4.1` and `node-addon-api` (`OLD/package.json:9`). The local binary does not prove fresh script-free delivery. Its old installed closure is roughly 121 MiB. The spike has already made the necessary API migration.
- Bun must load the native addon and accompanying shared library. The driver also uses timers, AbortSignal, BigInt, typed arrays and filesystem guards. Missing platform bindings become a driver-load error; there is no pure-JS DuckDB mode in this package.

## Oracle

- Loads `oracledb@6.10.0` dynamically (`packages/drivers/src/oracle.ts:10`; `V/bun.lock:2439`). It has no runtime npm dependencies. Its single-package size is 4.14 MiB.
- **Offender: `oracledb` itself.** It has `install: node package/install.js` (`ORA/package.json:32`) and five `.node` files under `build/Release`. The script checks viability and prints instructions; it does not fetch or compile the binaries (`ORA/package/install.js:83`, `:93`, `:125`). Skipping it does not prevent Thin mode.
- The bundled Thick binaries cover Darwin arm64/x64, Linux arm64/x64 and Windows x64. Linux files contain glibc version references; no separate musl binaries are present. Thick also needs Oracle Client libraries installed outside npm. Its full platform support is not a prerequisite for our JS Thin path (`ORA/package/prunebinaries.js:28`).
- Pool creation initializes Thin when `initOracleClient()` was not called (`ORA/lib/oracledb.js:673`). Native loading happens through `_initCLib` during Thick initialization (`:844`). Our driver creates an ordinary pool and never calls that method (`packages/drivers/src/oracle.ts:24`). Thin avoids native addons on every requested Bun platform.
- **Change for the shared host:** remove `oracledb.initOracleClient = undefined` at `packages/drivers/src/oracle.ts:14`. It mutates a shared module export and does not restore Thin if another consumer already initialized Thick. Check the SDK's mode and return a clear error if Thin is unavailable. Internal Thick state survives the mutation (`ORA/lib/oracledb.js:858`, `:865`). This is a host-process issue, not an install-script requirement.
- Thin uses Node net/TLS/http/timers (`ORA/lib/thin/sqlnet/ntTcp.js:29`), crypto (`ORA/lib/thin/protocol/encryptDecrypt.js:30`) and zlib (`ORA/lib/thin/sqlnet/networkSession.js:28`). Live Thin authentication was not tested.

## BigQuery

- Loads `@google-cloud/bigquery@8.3.1` dynamically (`packages/drivers/src/bigquery.ts:10`; `V/bun.lock:977`). Its 49-package closure has no native or install-hook offenders.
- Distributed `build/src` is the package entry (`BQ/package.json:15`). A prepare/build command exists, but consumers do not need to compile it. Required dependencies begin at `BQ/package.json:54`.
- The driver uses ordinary `BigQuery` and `client.query` (`packages/drivers/src/bigquery.ts:17`, `:54`). This is the REST/HTTPS path, not a native gRPC addon (`BQ/build/src/bigquery.js:101`, `:124`, `:134`). Node crypto, streams and credential-file access matter in Bun (`:28`).
- The same JS closure serves Darwin arm64/x64, Linux x64/arm64 glibc/musl and Windows x64. No per-platform npm binary is needed. Live auth remains untested. **OK as-is.**

## ClickHouse

- Loads `@clickhouse/client@1.21.0` dynamically (`packages/drivers/src/clickhouse.ts:68`; `V/bun.lock:847`). Its two-package closure includes only `@clickhouse/client-common@1.21.0` as a dependency (`CH/package.json:46`).
- No native or install-hook offenders. `simdjson` is a dev dependency, not a shipped runtime requirement (`CH/package.json:49`).
- Uses Node HTTP/HTTPS, streams, zlib and crypto (`CH/dist/connection/node_http_connection.js:8`, `node_https_connection.js:8`, `compression.js:9`, `node_base_connection.js:8`). All requested platforms use the same JS packages. **OK as-is.**

## MongoDB

- Loads `mongodb@6.21.0` dynamically (`packages/drivers/src/mongodb.ts:134`; `V/bun.lock:2323`). Its 12-package base closure has no native or install-hook offenders. Direct dependencies are SASLprep, BSON and connection-string handling (`MONGO/package.json:27`).
- **Optional native feature peers:** `kerberos` for GSSAPI, `snappy` and `@mongodb-js/zstd` for compression, and `mongodb-client-encryption` for client encryption. All four are absent locally, with no resolved version entry in this lockfile. Only peer ranges are available (`MONGO/package.json:32`, `:41`). Their scripts and binary platforms cannot be audited offline. They are not required for the driver's normal path.
- The driver sets ordinary MongoClient timeout/TLS/replica-set options (`packages/drivers/src/mongodb.ts:213`, `:234`). SDK defaults select no compression and ordinary SCRAM authentication (`MONGO/lib/connection_string.js:572`; `MONGO/lib/cmap/auth/mongo_credentials.js:10`). Builtin zlib is also available without an npm addon.
- A supplied URI is passed through (`packages/drivers/src/mongodb.ts:196`), so users can request unavailable native features. Missing peers raise explicit `MongoMissingDependencyError` when used (`MONGO/lib/deps.js:26`, `:38`, `:73`, `:110`; `MONGO/lib/cmap/wire_protocol/compression.js:41`). Package import success does not certify those URI options.
- Available optional peers for AWS/GCP auth and SOCKS were also walked; no native/install offenders were found. Including those installed branches gives about 24.62 MiB. This is separate from the default closure.
- Node TCP/TLS, DNS/SRV, crypto and zlib are the relevant Bun interfaces (`MONGO/lib/cmap/connect.js:9`; `MONGO/lib/connection_string.js:6`; `MONGO/lib/cmap/auth/scram.js:5`). **OK as-is** for ordinary auth and no native compression on all requested platforms. New native feature support needs package and platform checks.

## MySQL

- Loads subpath `mysql2/promise`, package `mysql2@3.14.4` (`packages/drivers/src/mysql.ts:10`; `V/bun.lock:2339`). The subpath is exported in `MYSQL/package.json:40`.
- The ordinary JS pool is constructed at `packages/drivers/src/mysql.ts:38`. Its 12-package closure has no native or install-hook offenders (`MYSQL/package.json:48` lists runtime dependencies).
- Uses Node net/TLS/timers/streams, crypto and zlib (`MYSQL/lib/base/connection.js:18`; `MYSQL/lib/auth_41.js:27`; `MYSQL/lib/compressed_protocol.js:6`). No per-platform npm binaries are needed on any requested target. **OK as-is.**

## PostgreSQL

- Loads `pg@8.22.0` and selects ordinary Pool (`packages/drivers/src/postgres.ts:10`, `:12`, `:43`; `V/bun.lock:2493`). The 14-package closure has no native or install-hook offenders.
- `pg-cloudflare` is an optional JS dependency. `pg-native` is an optional peer, absent locally and without a resolved version entry in this lockfile (`PG/package.json:52`, `:55`). Our driver does not request `.native`.
- **Host environment caveat:** keep `NODE_PG_FORCE_NATIVE` unset. `PG/lib/index.js:39` switches to the native implementation when it is set. Otherwise the JS Client is used; the native getter is lazy (`:37`, `:52`). An inherited force flag can turn the absent optional peer into an import failure.
- Node net/TLS and crypto/WebCrypto are relevant (`PG/lib/stream.js:20`; `PG/lib/crypto/utils.js:1`, `:18`). The JS mode works without platform packages across all requested targets. Native peer artifacts need a separate audit only if that mode is deliberately added. **OK as-is.**

## Redshift

- Loads the same `pg@8.22.0`, not a separate Redshift SDK (`packages/drivers/src/redshift.ts:11`; `V/bun.lock:2493`). It selects ordinary Pool at line 13 and creates it at line 41.
- It shares PostgreSQL's exact closure, absence of native/install offenders, optional `pg-native` caveat and Node APIs. The 0.44 MiB is shared when both drivers are installed. No native platform package is required. **OK as-is.**

## Snowflake

- Loads `snowflake-sdk@2.4.3` dynamically (`packages/drivers/src/snowflake.ts:189`; `V/bun.lock:2707`). The exact installed closure has 195 packages.
- **Sole native offender: the SDK itself.** `SF/dist/lib/minicore/binaries` contains nine `sf_mini_core_0.0.1.<target>.node` files. Targets include Darwin arm64/x64, Linux arm64/x64 GNU and musl, and Windows x64 MSVC, plus Windows arm64/ia32. File inspection identified Mach-O, ELF and PE binaries. All requested target payloads are present on disk.
- There is no `binding.gyp`, install/preinstall/postinstall hook or native installer dependency in this closure. Scripts are at `SF/package.json:80`; the distributed entry already exists at `:74`. This uses bundled binaries, not per-platform optional npm packages (`SF/dist/lib/minicore/minicore.js:38`). Registry tarball byte verification remains a later network check.
- Minicore is optional for the inspected query path. Its loader catches missing or unloadable binaries and records the failure; `SNOWFLAKE_DISABLE_MINICORE` skips it (`SF/dist/lib/minicore/minicore.js:17`, `:21`, `:29`). The driver leaves it enabled and relies on that existing fallback. Its observed uses supply version/status metadata (`SF/dist/lib/services/sf.js:945`, `:958`, `:1045`).
- GNU/musl detection uses filesystem data, `process.report` and subprocess fallbacks (`SF/dist/lib/telemetry/libc_details.js:4`, `:65`, `:93`). Driver code also uses filesystem key reads, crypto, browser spawning and temporary process-wide stdout/stderr replacement (`packages/drivers/src/snowflake.ts:22`, `:614`, `:627`; `packages/drivers/src/sign-in.ts:1`). Those affect the shared host and deserve integration coverage, but do not require install scripts. **OK as-is** for delivery, including the existing native-load fallback.

## SQLite

- Statically imports `Database` from `bun:sqlite` (`packages/drivers/src/sqlite.ts:6`). There is no npm SDK version or closure. Neither `sqlite3` nor `better-sqlite3` is used.
- Native SQLite is part of the Bun host on its supported targets. Plugin installation needs no binary download or build. Plain Node cannot evaluate this module unchanged.
- Database creation and statements are synchronous despite the async connector interface (`packages/drivers/src/sqlite.ts:24`, `:34`, `:64`, `:73`). Long queries can block the shared host. File guards use Node filesystem/URL APIs (`packages/drivers/src/file-store.ts:15`). **OK as-is** in Bun.

## SQL Server

- Dynamically loads `mssql@12.5.5` and conditionally `@azure/identity@4.13.1` (`packages/drivers/src/sqlserver.ts:78`, `:169`; `V/bun.lock:2333`, `:763`). The 74-package closure includes identity through required `tedious@19.2.1`.
- No native or install-hook offenders. `MSSQL/index.js:3` selects Tedious; runtime dependencies are at `MSSQL/package.json:36`. The driver never imports `mssql/msnodesqlv8`. A distributed adapter file does not make the native `msnodesqlv8` package a dependency.
- `native-duplexpair@1.0.0` is pure JS despite its name (`V/node_modules/.bun/native-duplexpair@1.0.0/node_modules/native-duplexpair/index.js:2`). No ODBC or platform binary is required on any requested target.
- The existing driver works around Bun Azure credential behavior by acquiring a raw token and falling back to `az account get-access-token` (`packages/drivers/src/sqlserver.ts:131`, `:169`, `:188`, `:212`). That fallback needs Azure CLI at runtime. It is unrelated to npm install scripts.
- Relevant Node APIs are child_process/execFile, util/promisify, TCP/TLS, DNS, crypto and streams (`packages/drivers/src/sqlserver.ts:196`; `TEDIOUS/lib/connection.js:7`). Authentication paths still need live Bun testing. **OK as-is.**

## Trino

- Loads `trino-client@0.2.9` dynamically (`packages/drivers/src/trino.ts:91`; `V/bun.lock:2833`). `TRINO/package.json:46` declares `axios@1.13.2`.
- Its 24-package closure has no native or install-hook offenders. It uses Axios and Node HTTPS agents (`TRINO/dist/index.js:56`, `:57`, `:113`). Basic/Bearer authentication is handled in JS (`packages/drivers/src/trino.ts:102`, `:127`).
- All requested platforms use the same JS closure. No per-platform package is required. **OK as-is.**

## Lazy loading and missing dependencies

`index.ts` statically re-exports every driver module (`packages/drivers/src/index.ts:19`). It is not itself a lazy module registry. Most SDKs remain lazy because their driver calls `loadOptionalDriver` only when its exported `connect` function runs. SQLite is the exception: importing the barrel evaluates its static `bun:sqlite` import. DuckDB's static SDK import is type-only. The current plugin avoids the barrel and dynamically imports the DuckDB subpath (`packages/altimate/src/server.ts:38`).

`loadOptionalDriver` tries dynamic import first (`packages/drivers/src/resolve.ts:632`). On failure it searches managed storage, wrapper/NODE_PATH roots, the executable and this package's location (`:376`). File fallback prefers `createRequire`, then uses dynamic import for ESM (`:586`, `:614`). A successful ambient import wins over managed storage; the managed root is first only within fallback search.

A genuinely absent SDK becomes `DriverNotInstalledError` with the package and install guidance (`:88`, `:661`). A found SDK with a missing transitive dependency or unloadable `.node` becomes a load failure that retains the underlying message (`:666`, `:696`, `:726`). It is not silently reported as simply absent. This cleanly rejects a connection for a missing DuckDB platform binding. It cannot recover from a native process crash.

SDK-internal optional features differ. Snowflake catches minicore load failure. MongoDB reports missing native peers when their feature is used. Databricks catches LZ4 import failure but may fail later while fetching compressed results. Therefore, import success is not a full native readiness test.

`isDriverInstalled` only checks resolution (`packages/drivers/src/resolve.ts:794`). The install success check does the same (`:1645`). Both can report success with a missing native payload. A v2 readiness check should actually load the selected SDK and exercise its required local binary path.

The legacy managed installer is a separate path from Arborist. `npmInstallArgs` has no `--ignore-scripts` and receives unversioned names (`packages/drivers/src/resolve.ts:44`, `:1087`, `:1109`, `:1616`). Its error text also recommends ordinary `npm install` (`:107`). Do not reuse it unchanged as a v2 repair path: use pinned, script-free delivery and update the guidance. Otherwise it bypasses the premise of this audit and can install versions different from those inspected.

## Verification limits

The audit read source, lockfiles and installed package trees. Small offline import/constructor checks passed for the exact ClickHouse, MySQL, PostgreSQL and Trino packages on Bun 1.3.14 / darwin-arm64. An in-memory `bun:sqlite` query also passed. No database connections, network requests or database files were created by those checks.

Still required before release: inspect absent platform tarballs, settle DuckDB libc support, test native payloads under the shipping Bun versions, and run real authentication/query checks. Databricks needs a compressed-result regression check after changing its statement options. These are follow-up verification needs, not claims that the checks passed.
