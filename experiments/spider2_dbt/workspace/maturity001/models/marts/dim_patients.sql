with

patients as (
    select * from {{ ref('stg_patients') }}
),

final as (

    select
        patient_id,
        practice_id,
        first_name,
        last_name,
        patient_name,
        billing_address,
        zip_code,
        state,
        country,
        email,
        is_diabetic,
        is_test,
        date_of_birth,
        created_at,
        last_logged_in_at

    from patients

)

select * from final
