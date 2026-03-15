with npi_source as (

    select
          npi
        , healthcare_provider_taxonomy_code_1
        , healthcare_provider_primary_taxonomy_switch_1
        , healthcare_provider_taxonomy_code_2
        , healthcare_provider_primary_taxonomy_switch_2
        , healthcare_provider_taxonomy_code_3
        , healthcare_provider_primary_taxonomy_switch_3
        , healthcare_provider_taxonomy_code_4
        , healthcare_provider_primary_taxonomy_switch_4
        , healthcare_provider_taxonomy_code_5
        , healthcare_provider_primary_taxonomy_switch_5
        , healthcare_provider_taxonomy_code_6
        , healthcare_provider_primary_taxonomy_switch_6
        , healthcare_provider_taxonomy_code_7
        , healthcare_provider_primary_taxonomy_switch_7
        , healthcare_provider_taxonomy_code_8
        , healthcare_provider_primary_taxonomy_switch_8
        , healthcare_provider_taxonomy_code_9
        , healthcare_provider_primary_taxonomy_switch_9
        , healthcare_provider_taxonomy_code_10
        , healthcare_provider_primary_taxonomy_switch_10
        , healthcare_provider_taxonomy_code_11
        , healthcare_provider_primary_taxonomy_switch_11
        , healthcare_provider_taxonomy_code_12
        , healthcare_provider_primary_taxonomy_switch_12
        , healthcare_provider_taxonomy_code_13
        , healthcare_provider_primary_taxonomy_switch_13
        , healthcare_provider_taxonomy_code_14
        , healthcare_provider_primary_taxonomy_switch_14
        , healthcare_provider_taxonomy_code_15
        , healthcare_provider_primary_taxonomy_switch_15
    from {{ source('nppes', 'npi') }}

),

-- Unpivot all 15 taxonomy slots into rows, keeping position and switch
unpivoted as (

    select npi, '1' as taxonomy_col, healthcare_provider_taxonomy_code_1 as taxonomy_code, healthcare_provider_primary_taxonomy_switch_1 as taxonomy_switch from npi_source
    union all
    select npi, '2', healthcare_provider_taxonomy_code_2, healthcare_provider_primary_taxonomy_switch_2 from npi_source
    union all
    select npi, '3', healthcare_provider_taxonomy_code_3, healthcare_provider_primary_taxonomy_switch_3 from npi_source
    union all
    select npi, '4', healthcare_provider_taxonomy_code_4, healthcare_provider_primary_taxonomy_switch_4 from npi_source
    union all
    select npi, '5', healthcare_provider_taxonomy_code_5, healthcare_provider_primary_taxonomy_switch_5 from npi_source
    union all
    select npi, '6', healthcare_provider_taxonomy_code_6, healthcare_provider_primary_taxonomy_switch_6 from npi_source
    union all
    select npi, '7', healthcare_provider_taxonomy_code_7, healthcare_provider_primary_taxonomy_switch_7 from npi_source
    union all
    select npi, '8', healthcare_provider_taxonomy_code_8, healthcare_provider_primary_taxonomy_switch_8 from npi_source
    union all
    select npi, '9', healthcare_provider_taxonomy_code_9, healthcare_provider_primary_taxonomy_switch_9 from npi_source
    union all
    select npi, '10', healthcare_provider_taxonomy_code_10, healthcare_provider_primary_taxonomy_switch_10 from npi_source
    union all
    select npi, '11', healthcare_provider_taxonomy_code_11, healthcare_provider_primary_taxonomy_switch_11 from npi_source
    union all
    select npi, '12', healthcare_provider_taxonomy_code_12, healthcare_provider_primary_taxonomy_switch_12 from npi_source
    union all
    select npi, '13', healthcare_provider_taxonomy_code_13, healthcare_provider_primary_taxonomy_switch_13 from npi_source
    union all
    select npi, '14', healthcare_provider_taxonomy_code_14, healthcare_provider_primary_taxonomy_switch_14 from npi_source
    union all
    select npi, '15', healthcare_provider_taxonomy_code_15, healthcare_provider_primary_taxonomy_switch_15 from npi_source

),

-- Keep only non-null taxonomy codes
with_codes as (

    select
          npi
        , cast(taxonomy_col as integer) as taxonomy_col
        , taxonomy_code
        , taxonomy_switch
    from unpivoted
    where taxonomy_code is not null
      and taxonomy_code != ''

),

-- Join with specialty mapping to get Medicare specialty and description
with_specialty as (

    select
          u.npi
        , u.taxonomy_col
        , u.taxonomy_code
        , u.taxonomy_switch
        , sm.medicare_specialty_code
        , sm.description
    from with_codes u
    left join {{ ref('specialty_mapping') }} sm
        on u.taxonomy_code = sm.taxonomy_code

),

-- Determine primary flag:
-- 1. If the provider has any switch = 'Y', the row with switch = 'Y' is primary
-- 2. If no switch is 'Y' for a provider, use the first taxonomy code by position (lowest taxonomy_col)
flagged as (

    select
          npi
        , taxonomy_col
        , taxonomy_code
        , taxonomy_switch
        , medicare_specialty_code
        , description
        -- A provider has a primary taxonomy when at least one row has switch = 'Y'
        , max(case when taxonomy_switch = 'Y' then 1 else 0 end)
            over (partition by npi) as has_primary_switch
        -- Rank by position to find first taxonomy when no Y switch exists
        , row_number() over (
            partition by npi
            order by taxonomy_col asc
          ) as position_rank
    from with_specialty

),

-- Build description fallback from NUCC when Medicare specialty mapping is missing
nucc_fallback as (

    select
          "Code" as taxonomy_code
        , coalesce(
              nullif("Specialization", '')
            , nullif("Classification", '')
          ) as nucc_description
    from {{ source('nppes', 'nucc_taxonomy') }}

),

-- Re-join to get NUCC description as fallback
with_fallback as (

    select
          f.npi
        , f.taxonomy_col
        , f.taxonomy_code
        , f.taxonomy_switch
        , f.medicare_specialty_code
        , coalesce(f.description, nf.nucc_description) as description
        , f.has_primary_switch
        , f.position_rank
    from flagged f
    left join nucc_fallback nf
        on f.taxonomy_code = nf.taxonomy_code

)

select
      npi
    , taxonomy_code
    , medicare_specialty_code
    , description
    -- primary_flag = 1 when:
    --   a) Provider has a 'Y' switch and this row's switch is 'Y', OR
    --   b) Provider has no 'Y' switch and this is the first taxonomy by position
    , case
        when has_primary_switch = 1 and taxonomy_switch = 'Y' then 1
        when has_primary_switch = 0 and position_rank = 1 then 1
        else 0
      end as primary_flag
from with_fallback
