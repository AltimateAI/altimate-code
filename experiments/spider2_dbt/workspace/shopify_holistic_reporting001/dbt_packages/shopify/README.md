<p align="center">
    <a alt="License"
        href="https://github.com/fivetran/dbt_shopify/blob/main/LICENSE">
        <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" /></a>
    <a alt="dbt-core">
        <img src="https://img.shields.io/badge/dbt_Core™_version->=1.3.0_<2.0.0-orange.svg" /></a>
    <a alt="Maintained?">
        <img src="https://img.shields.io/badge/Maintained%3F-yes-green.svg" /></a>
    <a alt="PRs">
        <img src="https://img.shields.io/badge/Contributions-welcome-blueviolet" /></a>
    <a alt="Fivetran Quickstart Compatible"
        href="https://fivetran.com/docs/transformations/dbt/quickstart">
        <img src="https://img.shields.io/badge/Fivetran_Quickstart_Compatible%3F-yes-green.svg" /></a>
</p>

# Shopify Transformation dbt Package ([Docs](https://fivetran.github.io/dbt_shopify/))

## What does this dbt package do?

This package models Shopify data from [Fivetran's connector](https://fivetran.com/docs/applications/shopify). It uses data in the format described by [this ERD](https://fivetran.com/docs/applications/shopify#schemainformation) and builds off the output of our [Shopify source package](https://github.com/fivetran/dbt_shopify_source).

The main focus of the package is to transform the core object tables into analytics-ready models, including a cohort model to understand how your customers are behaving over time.

<!--section="shopify_transformation_model"-->
The following table provides a detailed list of all tables materialized within this package by default.
> TIP: See more details about these tables in the package's [dbt docs site](https://fivetran.github.io/dbt_shopify/#!/overview/shopify).

| **Table**                 | **Description**                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [shopify__customer_cohorts](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__customer_cohorts)  | Each record represents the monthly performance of a customer (based on `customer_id`), including fields for the month of their 'cohort'.    |
| [shopify__customers](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__customers)        | Each record represents a distinct `customer_id`, with additional dimensions like lifetime value and number of orders.            |
| [shopify__customer_email_cohorts](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__customer_email_cohorts)  | Each record represents the monthly performance of a customer (based on `email`), including fields for the month of their 'cohort'.    |
| [shopify__customer_emails](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__customer_emails.sql)        | Each record represents a distinct customer `email`, with additional dimensions like lifetime value and number of orders.            |
| [shopify__orders](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__orders)           | Each record represents an order, with additional dimensions like whether it is a new or repeat purchase.           |
| [shopify__order_lines](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__order_lines)     | Each record represents an order line item, with additional dimensions like how many items were refunded.           |
| [shopify__products](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__products)         | Each record represents a product, with additional dimensions like most recent order date and order volume.         |
| [shopify__transactions](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__transactions)     | Each record represents a transaction with additional calculations to handle exchange rates.                        |
| [shopify__daily_shop](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__daily_shop)     | Each record represents a day of activity for each of your shops, conveyed by a suite of daily metrics about customers, orders, abandoned checkouts, fulfillment events, and more.                        |
| [shopify__discounts](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__discounts)     | Each record represents a unique discount, enriched with information about its associated `price_rule`and metrics regarding orders and abandoned checkouts.                        |
| [shopify__inventory_levels](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__inventory_levels)     | Each record represents an inventory level (unique pairing of inventory items and locations), enriched with information about its products, orders, and fulfillments.                        |
| [shopify__line_item_enhanced](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__line_item_enhanced)       | This model constructs a comprehensive, denormalized analytical table that enables reporting on key revenue, customer, and product metrics from your billing platform. It’s designed to align with the schema of the `*__line_item_enhanced` model found in Shopify, Recharge, Stripe, Zuora, and Recurly, offering standardized reporting across various billing platforms. To see the kinds of insights this model can generate, explore example visualizations in the [Fivetran Billing Model Streamlit App](https://fivetran-billing-model.streamlit.app/). Visit the app for more details.  |

### Example Visualizations
Curious what these tables can do? Check out example visualizations from the [shopify__line_item_enhanced](https://fivetran.github.io/dbt_shopify/#!/model/model.shopify.shopify__line_item_enhanced) table in the [Fivetran Billing Model Streamlit App](https://fivetran-billing-model.streamlit.app/), and see how you can use these tables in your own reporting. Below is a screenshot of an example report—explore the app for more.

<p align="center">
<a href="https://fivetran-billing-model.streamlit.app/">
    <img src="https://raw.githubusercontent.com/fivetran/dbt_shopify/main/images/streamlit_example.png" alt="Streamlit Billing Model App" width="75%">
</a>
</p>

<!--section-end-->

## How do I use the dbt package?

### Step 1: Prerequisites
To use this dbt package, you must have the following:

- At least one Fivetran Shopify connector syncing data into your destination.
- One of the following destinations:
  - [BigQuery](https://fivetran.com/docs/destinations/bigquery)
  - [Snowflake](https://fivetran.com/docs/destinations/snowflake)
  - [Redshift](https://fivetran.com/docs/destinations/redshift)
  - [PostgreSQL](https://fivetran.com/docs/destinations/postgresql)
  - [Databricks](https://fivetran.com/docs/destinations/databricks) with [Databricks Runtime](https://docs.databricks.com/en/compute/index.html#databricks-runtime)

### Step 2: Install the package (skip if also using the `shopify_holistic_reporting` package)
If you are **not** using the [Shopify Holistic reporting package](https://github.com/fivetran/dbt_shopify_holistic_reporting), include the following shopify package version in your `packages.yml` file:
> TIP: Check [dbt Hub](https://hub.getdbt.com/) for the latest installation instructions or [read the dbt docs](https://docs.getdbt.com/docs/package-management) for more information on installing packages.
```yml
packages:
  - package: fivetran/shopify
    version: [">=0.13.0", "<0.14.0"] # we recommend using ranges to capture non-breaking changes automatically
```

Do **NOT** include the `shopify_source` package in this file. The transformation package itself has a dependency on it and will install the source package as well.

#### Databricks dispatch configuration
If you are using a Databricks destination with this package, you must add the following (or a variation of the following) dispatch configuration within your `dbt_project.yml`. This is required in order for the package to accurately search for macros within the `dbt-labs/spark_utils` then the `dbt-labs/dbt_utils` packages respectively.
```yml
dispatch:
  - macro_namespace: dbt_utils
    search_order: ['spark_utils', 'dbt_utils']
```

### Step 3: Define database and schema variables
#### Single connector
By default, this package runs using your destination and the `shopify` schema. If this is not where your Shopify data is (for example, if your Shopify schema is named `shopify_fivetran`), add the following configuration to your root `dbt_project.yml` file:

```yml
# dbt_project.yml

vars:
    shopify_database: your_database_name
    shopify_schema: your_schema_name
```
#### Union multiple connectors
If you have multiple Shopify connectors in Fivetran and would like to use this package on all of them simultaneously, we have provided functionality to do so. The package will union all of the data together and pass the unioned table into the transformations. You will be able to see which source it came from in the `source_relation` column of each model. To use this functionality, you will need to set either the `shopify_union_schemas` OR `shopify_union_databases` variables (cannot do both) in your root `dbt_project.yml` file:

```yml
# dbt_project.yml

vars:
    shopify_union_schemas: ['shopify_usa','shopify_canada'] # use this if the data is in different schemas/datasets of the same database/project
    shopify_union_databases: ['shopify_usa','shopify_canada'] # use this if the data is in different databases/projects but uses the same schema name
```
> NOTE: The native `source.yml` connection set up in the package will not function when the union schema/database feature is utilized. Although the data will be correctly combined, you will not observe the sources linked to the package models in the Directed Acyclic Graph (DAG). This happens because the package includes only one defined `source.yml`.

To connect your multiple schema/database sources to the package models, follow the steps outlined in the [Union Data Defined Sources Configuration](https://github.com/fivetran/dbt_fivetran_utils/tree/releases/v0.4.latest#union_data-source) section of the Fivetran Utils documentation for the union_data macro. This will ensure a proper configuration and correct visualization of connections in the DAG.

### Step 4: Enable `fulfillment_event` data

The package takes into consideration that not every Shopify connector may have `fulfillment_event` data enabled. However, this table does hold valuable information that is leveraged in the `shopify__daily_shop` model. `fulfillment_event` data is **disabled by default**.

Add the following variable to your `dbt_project.yml` file to enable the modeling of fulfillment events:
```yml
# dbt_project.yml

vars:
    shopify_using_fulfillment_event: true # false by default
```

### Step 5: Setting your timezone
By default, the data in your Shopify schema is in UTC. However, you may want reporting to reflect a specific timezone for more realistic analysis or data validation.

To convert the timezone of **all** timestamps in the package, update the `shopify_timezone` variable to your target zone in [IANA tz Database format](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones):
```yml
# dbt_project.yml

vars:
    shopify_timezone: "America/New_York" # Replace with your timezone
```

> **Note**: This will only **numerically** convert timestamps to your target timezone. They will however have a "UTC" appended to them. This is a current limitation of the dbt-date `convert_timezone` [macro](https://github.com/calogica/dbt-date#convert_timezone-column-target_tznone-source_tznone) we leverage.

### (Optional) Step 6: Additional configurations
<details open><summary>Expand/Collapse details</summary>

#### Enabling Standardized Billing Model
This package contains the `shopify__line_item_enhanced` model which constructs a comprehensive, denormalized analytical table that enables reporting on key revenue, subscription, customer, and product metrics from your billing platform. It’s designed to align with the schema of the `*__line_item_enhanced` model found in Recurly, Recharge, Stripe, Shopify, and Zuora, offering standardized reporting across various billing platforms. To see the kinds of insights this model can generate, explore example visualizations in the [Fivetran Billing Model Streamlit App](https://fivetran-billing-model.streamlit.app/). For the time being, this model is disabled by default. If you would like to enable this model you will need to adjust the `shopify__standardized_billing_model_enabled` variable to be `true` within your `dbt_project.yml`:

```yml
vars:
  shopify__standardized_billing_model_enabled: true # false by default.
```
    
#### Passing Through Additional Fields
This package includes all source columns defined in the macros folder. You can add more columns using our pass-through column variables. These variables allow for the pass-through fields to be aliased (`alias`) and casted (`transform_sql`) if desired, but not required. Datatype casting is configured via a sql snippet within the `transform_sql` key. You may add the desired sql while omitting the `as field_name` at the end and your custom pass-though fields will be casted accordingly. Use the below format for declaring the respective pass-through variables:

```yml
# dbt_project.yml

vars:
  shopify_source:
    customer_pass_through_columns:
      - name: "customer_custom_field"
        alias: "customer_field"
    order_line_refund_pass_through_columns:
      - name: "unique_string_field"
        alias: "field_id"
        transform_sql: "cast(field_id as string)"
    order_line_pass_through_columns:
      - name: "that_field"
    order_pass_through_columns:
      - name: "sub_field"
        alias: "subsidiary_field"
    product_pass_through_columns:
      - name: "this_field"
    product_variant_pass_through_columns:
      - name: "new_custom_field"
        alias: "custom_field"
```

#### Adding Metafields
In [May 2021](https://fivetran.com/docs/applications/shopify/changelog#may2021) the Shopify connector included support for the [metafield resource](https://shopify.dev/api/admin-rest/2023-01/resources/metafield). If you would like to take advantage of these metafields, this package offers corresponding mapping models which append these metafields to the respective source object for the following tables: collection, customer, order, product_image, product, product_variant, shop. If enabled, these models will materialize as `shopify__[object]_metafields` for each respective supported object. To enable these metafield mapping models, you may use the following configurations within your `dbt_project.yml`.
>**Note**: These metafield models will contain all the same records as the corresponding staging models with the exception of the metafield columns being added.

```yml
vars:
  shopify_using_all_metafields: True ## False by default. Will enable ALL metafield models. FYI - This will override all other metafield variables.
  shopify_using_collection_metafields: True ## False by default. Will enable ONLY the collection metafield model.
  shopify_using_customer_metafields: True ## False by default. Will enable ONLY the customer metafield model.
  shopify_using_order_metafields: True ## False by default. Will enable ONLY the order metafield model.
  shopify_using_product_metafields: True ## False by default. Will enable ONLY the product metafield model.
  shopify_using_product_image_metafields: True ## False by default. Will enable ONLY the product image metafield model.
  shopify_using_product_variant_metafields: True ## False by default. Will enable ONLY the product variant metafield model.
  shopify_using_shop_metafields: True ## False by default. Will enable ONLY the shop metafield model.
```

#### Changing the Build Schema
By default this package will build the Shopify staging models within a schema titled (<target_schema> + `_stg_shopify`) and the Shopify final models within a schema titled (<target_schema> + `_shopify`) in your target database. If this is not where you would like your modeled Shopify data to be written to, add the following configuration to your `dbt_project.yml` file:

```yml
# dbt_project.yml

models:
  shopify:
    +schema: my_new_schema_name # leave blank for just the target_schema
  shopify_source:
    +schema: my_new_schema_name # leave blank for just the target_schema
```

#### Change the source table references
If an individual source table has a different name than the package expects, add the table name as it appears in your destination to the respective variable:

> IMPORTANT: See this project's [`dbt_project.yml`](https://github.com/fivetran/dbt_shopify_source/blob/main/dbt_project.yml) variable declarations to see the expected names.

```yml
# dbt_project.yml

vars:
    shopify_<default_source_table_name>_identifier: your_table_name 
```

##### Lookback Window
Records from the source can sometimes arrive late. Since several of the models in this package are incremental, by default we look back 7 days to ensure late arrivals are captured while avoiding the need for frequent full refreshes. While the frequency can be reduced, we still recommend running `dbt --full-refresh` periodically to maintain data quality of the models. For more information on our incremental decisions, see the [Incremental Strategy section](https://github.com/fivetran/dbt_shopify/blob/main/DECISIONLOG.md#incremental-strategy) of the DECISIONLOG.

To change the default lookback window, add the following variable to your `dbt_project.yml` file:

```yml
vars:
  shopify:
    lookback_window: number_of_days # default is 7
```

##### Change the calendar start date
Our date-based models start at `2019-01-01` by default. To customize the start date, add the following variable to your `dbt_project.yml` file:

```yml
vars:
  shopify:
    shopify__calendar_start_date: 'yyyy-mm-dd' # default is 2019-01-01
```

</details>


### (Optional) Step 7: Orchestrate your models with Fivetran Transformations for dbt Core™
<details><summary>Expand for details</summary>
<br>
    
Fivetran offers the ability for you to orchestrate your dbt project through [Fivetran Transformations for dbt Core™](https://fivetran.com/docs/transformations/dbt). Learn how to set up your project for orchestration through Fivetran in our [Transformations for dbt Core setup guides](https://fivetran.com/docs/transformations/dbt#setupguide).
</details>


## Does this package have dependencies?
This dbt package is dependent on the following dbt packages. These dependencies are installed by default within this package. For more information on the following packages, refer to the [dbt hub](https://hub.getdbt.com/) site.
> IMPORTANT: If you have any of these dependent packages in your own `packages.yml` file, we highly recommend that you remove them from your root `packages.yml` to avoid package version conflicts.
    
```yml
packages:
    - package: fivetran/shopify_source
      version: [">=0.12.0", "<0.13.0"]

    - package: fivetran/fivetran_utils
      version: [">=0.4.0", "<0.5.0"]

    - package: dbt-labs/dbt_utils
      version: [">=1.0.0", "<2.0.0"]

    - package: calogica/dbt_date
      version: [">=0.9.0", "<1.0.0"]
      
    - package: dbt-labs/spark_utils
      version: [">=0.3.0", "<0.4.0"]
```
## How is this package maintained and can I contribute?
### Package Maintenance
The Fivetran team maintaining this package _only_ maintains the latest version of the package. We highly recommend you stay consistent with the [latest version](https://hub.getdbt.com/fivetran/shopify/latest/) of the package and refer to the [CHANGELOG](https://github.com/fivetran/dbt_shopify/blob/main/CHANGELOG.md) and release notes for more information on changes across versions.

### Contributions
A small team of analytics engineers at Fivetran develops these dbt packages. However, the packages are made better by community contributions.

We highly encourage and welcome contributions to this package. Check out [this dbt Discourse article](https://discourse.getdbt.com/t/contributing-to-a-dbt-package/657) on the best workflow for contributing to a package.

## Are there any resources available?
- If you have questions or want to reach out for help, see the [GitHub Issue](https://github.com/fivetran/dbt_shopify/issues/new/choose) section to find the right avenue of support for you.
- If you would like to provide feedback to the dbt package team at Fivetran or would like to request a new dbt package, fill out our [Feedback Form](https://www.surveymonkey.com/r/DQ7K7WW).
