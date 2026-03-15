-- Mart model: COVID-19 cases by country and report date
-- Joins cleaned case data with country codes for human-readable country names

SELECT
    stg.cases,
    stg.deaths,
    cc.country,
    stg.date_rep AS report_date
FROM {{ ref('stg_covid__cases') }} AS stg
INNER JOIN {{ ref('ref__country_codes') }} AS cc
    ON stg.geo_id = cc.alpha_2code
