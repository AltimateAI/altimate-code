# dbt_klaviyo v0.7.2
[PR #38](https://github.com/fivetran/dbt_klaviyo/pull/38) includes the following updates:

## Bug Fixes
- Removes `not_null` tests for `person_id` from `int_klaviyo__person_metrics` and `klaviyo__person_campaign_flow`. This is because Klaviyo can record events with deactivated profiles, resulting in null `person_id`s. Therefore models built off of tables with event-based grains may have null `person_id`s.

# dbt_klaviyo v0.7.1

## Dependency Updates
[PR #33](https://github.com/fivetran/dbt_klaviyo/pull/33) includes the following updates:
 - Corrected the package to reference the proper upstream `dbt_klaviyo_source` package dependency.

## Under the Hood:
[PR #34](https://github.com/fivetran/dbt_klaviyo/pull/34) includes the following updates:
- For Databricks compatibility, added the Catalog variable and updated the range to >=1.6.0,<2.0.0 in order to pass in integration testing.

# dbt_klaviyo v0.7.0

[PR #30](https://github.com/fivetran/dbt_klaviyo/pull/30) includes updates regarding the [September 2023](https://fivetran.com/docs/applications/klaviyo/changelog#september2023) changes to the Klaviyo connector.

## 🚨 Breaking Changes 🚨:
- We have removed and added respective fields following the new schema in the Klaviyo connector. In addition, we have removed the deprecated `integration` table and have instead passed the integration columns through `metric`. For more information, refer to the [source Klaviyo package](https://github.com/fivetran/dbt_klaviyo_source/blob/main/CHANGELOG.md), where most of these changes took place.


# dbt_klaviyo v0.6.0
## 🚨 Breaking Changes 🚨:
- We recommend running `dbt run --full-refresh` after upgrading to this version due to casting changes in the source package affecting incremental models.
## Bug Fixes
[PR #29](https://github.com/fivetran/dbt_klaviyo/pull/29) includes the following breaking changes:
- IDs in the upstream source package are now cast using `{{ dbt.type_string() }}` to prevent potential datatype conflicts. 
- Upstream `_fivetran_synced` is now cast using `{{ dbt.type_timestamp() }}` to prevent downstream datatype errors.

 ## Under the Hood:
[PR #26](https://github.com/fivetran/dbt_klaviyo/pull/26) includes the following updates:
- Incorporated the new `fivetran_utils.drop_schemas_automation` macro into the end of each Buildkite integration test job.
- Updated the pull request [templates](/.github).

# dbt_klaviyo v0.5.0

## 🚨 Breaking Changes 🚨:
[PR #23](https://github.com/fivetran/dbt_klaviyo/pull/23) includes the following breaking changes:
- Dispatch update for dbt-utils to dbt-core cross-db macros migration. Specifically `{{ dbt_utils.<macro> }}` have been updated to `{{ dbt.<macro> }}` for the below macros:
    - `any_value`
    - `bool_or`
    - `cast_bool_to_text`
    - `concat`
    - `date_trunc`
    - `dateadd`
    - `datediff`
    - `escape_single_quotes`
    - `except`
    - `hash`
    - `intersect`
    - `last_day`
    - `length`
    - `listagg`
    - `position`
    - `replace`
    - `right`
    - `safe_cast`
    - `split_part`
    - `string_literal`
    - `type_bigint`
    - `type_float`
    - `type_int`
    - `type_numeric`
    - `type_string`
    - `type_timestamp`
    - `array_append`
    - `array_concat`
    - `array_construct`
- For `current_timestamp` and `current_timestamp_in_utc` macros, the dispatch AND the macro names have been updated to the below, respectively:
    - `dbt.current_timestamp_backcompat`
    - `dbt.current_timestamp_in_utc_backcompat`
- `dbt_utils.surrogate_key` has also been updated to `dbt_utils.generate_surrogate_key`. Since the method for creating surrogate keys differ, we suggest all users do a `full-refresh` for the most accurate data. For more information, please refer to dbt-utils [release notes](https://github.com/dbt-labs/dbt-utils/releases) for this update.
- Dependencies on `fivetran/fivetran_utils` have been upgraded, previously `[">=0.3.0", "<0.4.0"]` now `[">=0.4.0", "<0.5.0"]`.

# dbt_klaviyo v0.4.2

## Under the Hood
- Ensures that the incremental strategy used by Postgres and Redshift adapters in the `klaviyo__events` and `int_klaviyo__event_attribution` models is `delete+insert` ([#9](https://github.com/fivetran/dbt_klaviyo/pull/22)). Newer versions of dbt introduced an error message if the provided incremental strategy is not `append` or `delete+insert` for these adapters.

# dbt_klaviyo v0.4.1
## Bug Fixes
- Incorporate the `try_cast` macro from [fivetran_utils](https://github.com/fivetran/dbt_fivetran_utils/tree/releases/v0.3.latest) to ensure that the `numeric_value` field in `klaviyo__person_campaign_flow` is the same data type as '0'. [Issue #17](https://github.com/fivetran/dbt_klaviyo/issues/17)

# dbt_klaviyo v0.4.0
🎉 dbt v1.0.0 Compatibility 🎉
## 🚨 Breaking Changes 🚨
- Adjusts the `require-dbt-version` to now be within the range [">=1.0.0", "<2.0.0"]. Additionally, the package has been updated for dbt v1.0.0 compatibility. If you are using a dbt version <1.0.0, you will need to upgrade in order to leverage the latest version of the package.
  - For help upgrading your package, I recommend reviewing this GitHub repo's Release Notes on what changes have been implemented since your last upgrade.
  - For help upgrading your dbt project to dbt v1.0.0, I recommend reviewing dbt-labs [upgrading to 1.0.0 docs](https://docs.getdbt.com/docs/guides/migration-guide/upgrading-to-1-0-0) for more details on what changes must be made.
- Upgrades the package dependency to refer to the latest `dbt_klaviyo_source`. Additionally, the latest `dbt_klaviyo_source` package has a dependency on the latest `dbt_fivetran_utils`. Further, the latest `dbt_fivetran_utils` package also has a dependency on `dbt_utils` [">=0.8.0", "<0.9.0"].
  - Please note, if you are installing a version of `dbt_utils` in your `packages.yml` that is not in the range above then you will encounter a package dependency error.
- The updates highlighted within the Bug Fixes section are changes to the incremental logic of the `klaviyo__events` table. As such, a `dbt run --full-refresh` will be needed after installing this version of the dbt_klaviyo package as a dependency within your `packages.yml`
- Accommodating the breaking change within the dbt_klaviyo_source package for the name change of the `union_schemas/datbases` variables to be `klaviyo_union_schemas/databases`.

## Bug Fixes
- Leverage the `unique_event_id` surrogate key from the `stg_klaviyo__events` model within the incremental logic of `int_klaviyo__event_attribution` and `klaviyo__events` to better account for the uniqueness of events across different connectors.

# dbt_klaviyo v0.3.0

## Features
- Allow for multiple sources by unioning source tables across multiple Klaviyo connectors.
([#11](https://github.com/fivetran/dbt_klaviyo/pull/11) & [#12](https://github.com/fivetran/dbt_klaviyo/pull/12))
  - Refer to the [README](https://github.com/fivetran/dbt_klaviyo#unioning-multiple-klaviyo-connectors) for more details.

## Bug Fixes
- Correct [README](https://github.com/fivetran/dbt_klaviyo#attribution-eligible-event-types) in pointing out that the `klaviyo__eligible_attribution_events` variable is case-SENSITIVE and must be in **all lowercase**.

## Under the Hood
- Unioning: The unioning occurs in the staging tmp models using the `fivetran_utils.union_data` macro. ([#8](https://github.com/fivetran/dbt_klaviyo_source/pull/8))
- Unique tests: Because columns that were previously used for unique tests may now have duplicate fields across multiple sources, these columns are combined with the new `source_relation` column for unique tests and tested using the `dbt_utils.unique_combination_of_columns` macro. ([#8](https://github.com/fivetran/dbt_klaviyo/pull/11))
- Source Relation column: To distinguish which source each record comes from, we added a new `source_relation` column in each staging and final model and applied the `fivetran_utils.source_relation` macro. ([#8](https://github.com/fivetran/dbt_klaviyo_source/pull/8))
    - The `source_relation` column is included in all joins and window function partition clauses in the transform package. Note that an event from one Klaviyo source will _never_ be attributed to an event from a different Klaviyo connector.

## Contributors
- [@pawelngei](https://github.com/pawelngei) [#11](https://github.com/fivetran/dbt_klaviyo/pull/11) and [#8](https://github.com/fivetran/dbt_klaviyo_source/pull/8)

# dbt_klaviyo v0.1.0 -> v0.3.0
Refer to the relevant release notes on the Github repository for specific details for the previous releases. Thank you!
