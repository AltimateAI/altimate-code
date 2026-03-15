WITH unioned AS (
    SELECT * FROM {{ ref('stg_google_sheets__originals_unioned') }}
),

-- Map category_id to category name (Drama=1, Comedy=2, Docuseries=3)
-- Source table categories are scraped Wikipedia nav links, so we derive the mapping from category_id
dim_categories AS (
    SELECT 1 AS category_id, 'Drama'      AS category
    UNION ALL
    SELECT 2 AS category_id, 'Comedy'     AS category
    UNION ALL
    SELECT 3 AS category_id, 'Docuseries' AS category
),

joined AS (
    SELECT
        unioned.title,
        unioned.premiere_date,
        -- Premiere status: Current if premiered on/before today, else Upcoming
        CASE
            WHEN unioned.premiere_date <= CURRENT_DATE THEN 'Current'
            ELSE 'Upcoming'
        END                         AS premiere_status,
        unioned.genre,
        dim_categories.category     AS category,
        unioned.seasons,
        unioned.runtime,
        unioned.renewal_status,
        unioned.premiere_year,
        unioned.premiere_month,
        unioned.premiere_day,
        unioned.updated_at_utc
    FROM unioned
    LEFT JOIN dim_categories
        ON unioned.category_id = dim_categories.category_id
)

SELECT * FROM joined
