with

doctors as (
    select * from {{ ref('stg_doctors') }}
),

specialties as (
    select * from {{ ref('stg_doc_specialties') }}
),

final as (

    select
        doctors.doctor_id,
        doctors.npi,
        doctors.practice_id,
        doctors.first_name,
        doctors.last_name,
        doctors.doctor_name,
        doctors.billing_address,
        doctors.zip_code,
        doctors.state,
        doctors.country,
        doctors.created_at,
        doctors.last_logged_in_at,
        specialties.specialty_category,
        specialties.specialty_name

    from doctors
    left join specialties
        on doctors.doctor_id = specialties.doctor_id

)

select * from final
