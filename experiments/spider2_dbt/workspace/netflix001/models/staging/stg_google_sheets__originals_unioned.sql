WITH dramas AS (
    SELECT * FROM {{ ref('base_google_sheets__original_dramas') }}
),

comedies AS (
    SELECT * FROM {{ ref('base_google_sheets__original_comedies') }}
),

docuseries AS (
    SELECT * FROM {{ ref('base_google_sheets__original_docuseries') }}
),

unioned AS (
    -- Union all three genres together; genre column already set in base models
    -- Explicitly alias Seasons/Runtime/etc to enforce lowercase column names
    SELECT
        title        AS title,
        'Drama'      AS genre,
        category_id,
        seasons      AS seasons,
        runtime      AS runtime,
        status       AS status,
        premiere     AS premiere,
        updated_at   AS updated_at
    FROM dramas
    WHERE title IS NOT NULL
      AND title NOT LIKE 'Awaiting release'

    UNION ALL

    SELECT
        title        AS title,
        'Comedy'     AS genre,
        category_id,
        seasons      AS seasons,
        runtime      AS runtime,
        status       AS status,
        premiere     AS premiere,
        updated_at   AS updated_at
    FROM comedies
    WHERE title IS NOT NULL
      AND title NOT LIKE 'Awaiting release'

    UNION ALL

    SELECT
        title        AS title,
        'Docuseries' AS genre,
        category_id,
        seasons      AS seasons,
        runtime      AS runtime,
        status       AS status,
        premiere     AS premiere,
        updated_at   AS updated_at
    FROM docuseries
    WHERE title IS NOT NULL
      AND title NOT LIKE 'Awaiting release'
),

cleaned AS (
    SELECT
        -- Remove footnote references like [16][24] then strip asterisks used as Wikipedia emphasis markers
        TRIM(
            regexp_replace(
                regexp_replace(title, '\[[^\]]*\]', '', 'g'),
                '\*', '', 'g'
            )
        )                                                           AS title,
        genre,
        category_id,
        seasons                                                     AS seasons,
        runtime                                                     AS runtime,
        status                                                      AS renewal_status,
        -- Parse "Month D, YYYY" format into a proper DATE
        CAST(TRY_STRPTIME(premiere, '%B %-d, %Y') AS DATE)         AS premiere_date,
        YEAR(TRY_STRPTIME(premiere, '%B %-d, %Y'))                 AS premiere_year,
        LPAD(CAST(MONTH(TRY_STRPTIME(premiere, '%B %-d, %Y')) AS VARCHAR), 2, '0')
                                                                    AS premiere_month,
        LPAD(CAST(DAY(TRY_STRPTIME(premiere, '%B %-d, %Y')) AS VARCHAR), 2, '0')
                                                                    AS premiere_day,
        -- Coalesce NULL updated_at with the dataset extraction date (max non-null date in source)
        CAST(
            COALESCE(updated_at, (
                SELECT MAX(updated_at)
                FROM (
                    SELECT updated_at FROM {{ ref('base_google_sheets__original_dramas') }}
                    UNION ALL
                    SELECT updated_at FROM {{ ref('base_google_sheets__original_comedies') }}
                    UNION ALL
                    SELECT updated_at FROM {{ ref('base_google_sheets__original_docuseries') }}
                ) AS all_dates
            ))
        AS TIMESTAMP)                                               AS updated_at_utc
    FROM unioned
)

SELECT * FROM cleaned
