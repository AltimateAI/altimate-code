
with base as (

    select * 
    from {{ ref('stg_klaviyo__campaign_tmp') }}

),

fields as (

    select
        {{
            fivetran_utils.fill_staging_columns(
                source_columns=adapter.get_columns_in_relation(ref('stg_klaviyo__campaign_tmp')),
                staging_columns=get_campaign_columns()
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
        campaign_type,
        created as created_at,
        email_template_id,
        from_email,
        from_name,
        cast(id as {{ dbt.type_string() }} ) as campaign_id,
        name as campaign_name,
        send_time as scheduled_to_send_at,
        sent_at,
        coalesce(status, lower(status_label)) as status,
        status_id,
        subject,
        updated as updated_at,
        archived as is_archived,
        scheduled as scheduled_at,
        source_relation

    from fields

    where not coalesce(_fivetran_deleted, false)
)

select * from final
