-- Staging model: clean raw COVID-19 case data
-- Converts date_rep from DD/MM/YYYY string to DATE, casts numeric fields

SELECT
    strptime(date_rep, '%d/%m/%Y')::DATE AS date_rep,
    cases::INTEGER                        AS cases,
    deaths::INTEGER                       AS deaths,
    geo_id
FROM {{ source('raw_covid', 'raw_covid__cases') }}
