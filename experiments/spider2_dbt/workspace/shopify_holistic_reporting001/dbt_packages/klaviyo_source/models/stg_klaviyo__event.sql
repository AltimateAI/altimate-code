
with base as (

    select * 
    from {{ ref('stg_klaviyo__event_tmp') }}

),

fields as (

    select
        {{
            fivetran_utils.fill_staging_columns(
                source_columns=adapter.get_columns_in_relation(ref('stg_klaviyo__event_tmp')),
                staging_columns=get_event_columns()
            )
        }}
        {{ fivetran_utils.source_relation(
            union_schema_variable='klaviyo_union_schemas', 
            union_database_variable='klaviyo_union_databases') 
        }}
    from base
),

rename as (
    
    select 
        _variation as variation_id,
        cast(campaign_id as {{ dbt.type_string() }} ) as campaign_id,
        cast(timestamp as {{ dbt.type_timestamp() }} ) as occurred_at,
        cast(flow_id as {{ dbt.type_string() }} ) as flow_id,
        flow_message_id,
        cast(id as {{ dbt.type_string() }} ) as event_id,
        cast(metric_id as {{ dbt.type_string() }} ) as metric_id,
        cast(person_id as {{ dbt.type_string() }} ) as person_id,
        type,
        uuid,
        {{ klaviyo_source.remove_string_from_numeric('property_value') }} as numeric_value,
        cast(_fivetran_synced as {{ dbt.type_timestamp() }} ) as _fivetran_synced,
        source_relation
        {{ fivetran_utils.fill_pass_through_columns('klaviyo__event_pass_through_columns') }}

    from fields
    where not coalesce(_fivetran_deleted, false)
),

final as (
    
    select 
        *,
        cast( {{ dbt.date_trunc('day', 'occurred_at') }} as date) as occurred_on,
        {{ dbt_utils.generate_surrogate_key(['event_id', 'source_relation']) }} as unique_event_id

    from rename

)

select * from final
