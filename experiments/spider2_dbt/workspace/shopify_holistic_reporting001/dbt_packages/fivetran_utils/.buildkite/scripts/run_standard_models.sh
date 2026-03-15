#!/bin/bash

set -euo pipefail

apt-get update
apt-get install libsasl2-dev

python3 -m venv venv
. venv/bin/activate
pip install --upgrade pip setuptools
pip install -r integration_tests/requirements.txt
mkdir -p ~/.dbt
cp integration_tests/ci/sample.profiles.yml ~/.dbt/profiles.yml

db=$1
echo `pwd`
cd integration_tests
dbt deps ## Install all packages needed

shift ## Skips the first argument (warehouse) and moves to only looking at the package arguments

for package in "$@" ## Iterates over all non warehouse arguments
do
    echo -e "\ncompiling "$package"\n"
    cd dbt_packages/$package/integration_tests/
    dbt deps
    ## Post dbt 1.7.0 we need to edit the package-lock.yml instead of the packages.yml
    awk '/name: fivetran_utils/ {print "  - local: ../../../../\n    name: fivetran_utils"; skip=1; next} skip && /^  -/ {skip=0} !skip' package-lock.yml > temp.yml && mv temp.yml package-lock.yml
    dbt deps
    fivetran_utils_version=$(grep "^version:" dbt_packages/fivetran_utils/dbt_project.yml | awk '{print $2}')
    echo -e "\nUsing fivetran_utils version: "$fivetran_utils_version"\n"
    if [ "$package" = "linkedin" ]; then
        value_to_replace=$(grep ""$package"_ads_schema:" dbt_project.yml | awk '{ print $2 }')
        perl -i -pe "s/(schema: |dataset: ).*/\1$value_to_replace/" ~/.dbt/profiles.yml
    elif [ "$package" = "ad_reporting" ]; then
        value_to_replace=$(grep "google_ads_schema:" dbt_project.yml | awk '{ print $2 }')
        perl -i -pe "s/(schema: |dataset: ).*/\1$value_to_replace/" ~/.dbt/profiles.yml
    elif [ "$package" = "app_reporting" ]; then
        value_to_replace=$(grep "google_play_schema:" dbt_project.yml | awk '{ print $2 }')
        perl -i -pe "s/(schema: |dataset: ).*/\1$value_to_replace/" ~/.dbt/profiles.yml
    elif [ "$package" = "shopify_holistic_reporting" ]; then
        value_to_replace=$(grep "shopify_schema:" dbt_project.yml | awk '{ print $2 }')
        perl -i -pe "s/(schema: |dataset: ).*/\1$value_to_replace/" ~/.dbt/profiles.yml
    elif [ "$package" = "social_media_reporting" ]; then
        perl -i -pe "s/(schema: |dataset: ).*/\1social_media_rollup_integration_tests/" ~/.dbt/profiles.yml
    elif [ "$package" = "fivetran_log" ]; then
        value_to_replace=$(grep "fivetran_platform_schema:" dbt_project.yml | awk '{ print $2 }')
        perl -i -pe "s/(schema: |dataset: ).*/\1$value_to_replace/" ~/.dbt/profiles.yml
    else
        value_to_replace=$(grep ""$package"_schema:" dbt_project.yml | awk '{ print $2 }')
        perl -i -pe "s/(schema: |dataset: ).*/\1$value_to_replace/" ~/.dbt/profiles.yml
    fi
    dbt seed --target "$db"
    if [ "$package" = "ad_reporting" ]; then
        dbt run --target "$db" --vars '{ad_reporting__facebook_ads_enabled: true, facebook_ads__using_demographics_country: true, facebook_ads__using_demographics_region: true, ad_reporting__google_ads_enabled: true, ad_reporting__amazon_ads_enabled: false, ad_reporting__apple_search_ads_enabled: false, ad_reporting__linkedin_ads_enabled: true, ad_reporting__microsoft_ads_enabled: false, ad_reporting__pinterest_ads_enabled: false, ad_reporting__reddit_ads_enabled: false, ad_reporting__snapchat_ads_enabled: false, ad_reporting__tiktok_ads_enabled: false, ad_reporting__twitter_ads_enabled: false}'
    else
        dbt run --target "$db"
    fi
    dbt run-operation fivetran_utils.drop_schemas_automation --target "$db"
    cd ../../../
done