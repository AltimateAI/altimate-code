with crosswalk as (

    select
          medicare_specialty_code
        , medicare_provider_supplier_type_description
        , provider_taxonomy_code
    from {{ source('nppes', 'medicare_specialty_crosswalk') }}

),

nucc as (

    select
          "Code"             as taxonomy_code
        , "Specialization"   as specialization
        , "Classification"   as classification
    from {{ source('nppes', 'nucc_taxonomy') }}

),

-- Join crosswalk with NUCC to get full specialty context
joined as (

    select
          n.taxonomy_code
        , c.medicare_specialty_code
        , c.medicare_provider_supplier_type_description
        , n.specialization
        , n.classification
    from nucc n
    left join crosswalk c
        on n.taxonomy_code = c.provider_taxonomy_code

),

-- Deduplicate: when multiple Medicare specialties map to the same taxonomy code,
-- prioritize the most specific one by preferring codes whose description matches
-- the NUCC specialization (most specific) over classification, then higher code as tiebreak
deduped as (

    select
          taxonomy_code
        , medicare_specialty_code
        , medicare_provider_supplier_type_description
        , specialization
        , classification
        , row_number() over (
            partition by taxonomy_code
            order by
              -- Prefer description that matches specialization (most specific NUCC level)
              case
                when specialization is not null
                  and specialization != ''
                  and lower(medicare_provider_supplier_type_description)
                      like '%' || lower(split_part(specialization, ' ', 1)) || '%'
                then 0
                -- Then prefer description that matches classification
                when classification is not null
                  and classification != ''
                  and lower(medicare_provider_supplier_type_description)
                      like '%' || lower(split_part(classification, ' ', 1)) || '%'
                then 1
                else 2
              end asc,
              medicare_specialty_code desc  -- higher code = more specific as tiebreak
          ) as rn
    from joined
    -- Only include rows with a Medicare specialty code mapping
    where medicare_specialty_code is not null

)

select
      taxonomy_code
    , medicare_specialty_code
    -- Description: Medicare provider type description where available,
    -- otherwise fall back to NUCC specialization or classification
    , coalesce(
          medicare_provider_supplier_type_description
        , nullif(specialization, '')
        , nullif(classification, '')
      ) as description
from deduped
where rn = 1
