# dbt_klaviyo_source v0.7.1
[PR #22](https://github.com/fivetran/dbt_klaviyo_source/pull/22) introduces the following updates:

## 🪲 Bug Fixes 🪛
- [There were errors customers were encountering](https://github.com/fivetran/dbt_klaviyo_source/issues/20) where numeric values were not being recognized in `property_value`, leading to database errors.
- To solve for that, we created the `remove_string_from_numeric` macro to be used in `stg_klaviyo__event`, which conducts the following operations:
  - We cast `property_value` as a string.
  - We then used a `regex_replace` function to retain only numerical values in these strings across all destinations (i.e. 0-9 values and .).
  - Finally we cast back to a numeric to ensure `numeric_value` is that particular data type.
  
## 🚘 Under the Hood 🚘
- Cast `property_value` in the `integration_tests/dbt_project.yml` to  ensure the field was originally being cast as a string or varchar data type for testing purposes.
- Updated the `event` seed file to test for values that aren't numerics.
- Updated the pull request template.
- Included auto-releaser GitHub Actions workflow to automate future releases.

## Contributors
- [@vnguyen12](https://github.com/vnguyen12) [#21](https://github.com/fivetran/dbt_klaviyo_source/pull/21)

# dbt_klaviyo_source v0.7.0
[PR #18](https://github.com/fivetran/dbt_klaviyo_source/pull/18/) includes updates regarding the [September 2023](https://fivetran.com/docs/applications/klaviyo/changelog#september2023) changes to the Klaviyo connector.

## 🚨 Breaking Changes 🚨:

- As the `integration` table has been deprecated, we removed the `stg_klaviyo__integration` model, and instead have passed the integration columns through `stg_klaviyo__metric`. 

- We have removed these deprecated columns from the following tables:

| **Table**                          | **Column**                                                                                                                                                                                                                             |
|--------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| CAMPAIGN | is_segmented
| FLOW | customer_filter
| FLOW | trigger

- We have added these columns from the following tables and renamed them:

| **Table**       | **Column**  | **New Name**       |
| :---        |    :----:   |          ---: |
| CAMPAIGN | archived | is_archived
| CAMPAIGN | scheduled | scheduled_at
| FLOW | archived | is_archived
| FLOW | trigger_type | trigger_type
| PERSON | last_event_date | last_event_date
| METRIC | integration_name | integration_name
| METRIC | integration_category | integration_category

For more information on the fields, refer to [our docs](https://fivetran.github.io/dbt_klaviyo_source/#!/model/model.klaviyo_source).

## Under the Hood:
- We removed the Snowflake-specific logic in place for passing through the `trigger` field in the Flow table as it was a reserved word. Now that the `trigger` field has been deprecated, we have also removed the associated logic in the package. 
- We removed the not_null test for `email` in the `stg_klaviyo__person` model. This is because for the most recent schema, the only primary key is `person_id` rather than `email`, and `email` may not be present.

# dbt_klaviyo_source v0.6.0
## 🚨 Breaking Changes 🚨:
- This change is made breaking due to impact on incremental models in the downstream transformation package. 
## Bug Fixes
[PR #17](https://github.com/fivetran/dbt_klaviyo_source/pull/17) includes the following breaking changes:
- IDs used in downstream joins or coalesce functions are now cast using `{{ dbt.type_string() }}` to prevent potential datatype conflicts. 
- `_fivetran_synced` is now cast using `{{ dbt.type_timestamp() }}` to prevent downstream datatype errors.

## Under the Hood:
[PR #16](https://github.com/fivetran/dbt_klaviyo_source/pull/16) includes the following updates:
- Incorporated the new `fivetran_utils.drop_schemas_automation` macro into the end of each Buildkite integration test job.
- Updated the pull request [templates](/.github).

# dbt_klaviyo_source v0.5.0

## 🚨 Breaking Changes 🚨:
[PR #15](https://github.com/fivetran/dbt_klaviyo_source/pull/15) includes the following breaking changes:
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

# dbt_klaviyo_source v0.4.1
## Updates
- Updates `dbt-labs/spark_utils` package in `packages.yml` from `[">=0.2.0", "<0.3.0"]` to `[">=0.3.0", "<0.4.0"]`.

# dbt_klaviyo_source v0.4.0
🎉 dbt v1.0.0 Compatibility 🎉
## 🚨 Breaking Changes 🚨
- Adjusts the `require-dbt-version` to now be within the range [">=1.0.0", "<2.0.0"]. Additionally, the package has been updated for dbt v1.0.0 compatibility. If you are using a dbt version <1.0.0, you will need to upgrade in order to leverage the latest version of the package.
  - For help upgrading your package, I recommend reviewing this GitHub repo's Release Notes on what changes have been implemented since your last upgrade.
  - For help upgrading your dbt project to dbt v1.0.0, I recommend reviewing dbt-labs [upgrading to 1.0.0 docs](https://docs.getdbt.com/docs/guides/migration-guide/upgrading-to-1-0-0) for more details on what changes must be made.
- Upgrades the package dependency to refer to the latest `dbt_fivetran_utils`. The latest `dbt_fivetran_utils` package also has a dependency on `dbt_utils` [">=0.8.0", "<0.9.0"].
  - Please note, if you are installing a version of `dbt_utils` in your `packages.yml` that is not in the range above then you will encounter a package dependency error.
- The `union_schemas` and `union_databases` variables have been replaced with `klaviyo_union_schemas` and `klaviyo_union_databases` respectively. This allows for multiple packages with the union ability to be used and not locked to a single variable that is used across packages.
## Under the Hood
- Added a surrogate key within `stg_klaviyo__event` to capture unique combination of `event_id` and `source_relation` columns. This will be used in downstream incremental models configurations.

# dbt_klaviyo_source v0.3.0

## Features
- Allow for multiple sources by unioning source tables across multiple Klaviyo connectors.
([#8](https://github.com/fivetran/dbt_klaviyo_source/pull/8) & [#9](https://github.com/fivetran/dbt_klaviyo_source/pull/9))
  - Refer to the [README](https://github.com/fivetran/dbt_klaviyo_source#unioning-multiple-klaviyo-connectors) for more details.

## Under the Hood
- Unioning: The unioning occurs in the tmp models using the `fivetran_utils.union_data` macro. ([#8](https://github.com/fivetran/dbt_klaviyo_source/pull/8))
- Unique tests: Because columns that were previously used for unique tests may now have duplicate fields across multiple sources, these columns are combined with the new `source_relation` column for unique tests and tested using the `dbt_utils.unique_combination_of_columns` macro. ([#8](https://github.com/fivetran/dbt_klaviyo_source/pull/8))
- Source Relation column: To distinguish which source each field comes from, we added a new `source_relation` column in each staging model and applied the `fivetran_utils.source_relation` macro. ([#8](https://github.com/fivetran/dbt_klaviyo_source/pull/8))

## Contributors
- [@pawelngei](https://github.com/pawelngei) [#8](https://github.com/fivetran/dbt_klaviyo_source/pull/8)

# dbt_klaviyo_source v0.1.0 -> v0.3.0
Refer to the relevant release notes on the Github repository for specific details for the previous releases. Thank you!
