
with base as (

    select * 
    from {{ ref('stg_klaviyo__person_tmp') }}

),

fields as (

    select
        {{
            fivetran_utils.fill_staging_columns(
                source_columns=adapter.get_columns_in_relation(ref('stg_klaviyo__person_tmp')),
                staging_columns=get_person_columns()
            )
        }}
        {{ fivetran_utils.source_relation(
            union_schema_variable='klaviyo_union_schemas', 
            union_database_variable='klaviyo_union_databases') 
        }}
    from base
),

final as (
    
    select 
        cast(id as {{ dbt.type_string() }} ) as person_id,
        address_1,
        address_2,
        city,
        country,
        zip,
        created as created_at,
        email,
        first_name || ' ' || last_name as full_name,
        latitude,
        longitude,
        organization,
        phone_number,
        region, -- state in USA
        timezone,
        title,
        updated as updated_at,
        last_event_date,
        source_relation
        
        {{ fivetran_utils.fill_pass_through_columns('klaviyo__person_pass_through_columns') }}

    from fields
    where not coalesce(_fivetran_deleted, false)
)

select * from final