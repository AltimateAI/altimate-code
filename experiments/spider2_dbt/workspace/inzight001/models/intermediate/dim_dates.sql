with date_dim as (
    {{ dbt_date.get_date_dimension('2019-01-01', '2023-12-31') }}
),

holidays as (
    select holiday_date
    from {{ ref('stg_be_holidays') }}
),

final as (
    select
        d.date_day,
        d.prior_date_day,
        d.next_date_day,
        d.prior_year_date_day,
        d.prior_year_over_year_date_day,
        d.day_of_week,
        d.day_of_week_iso,
        d.day_of_week_name,
        d.day_of_week_name_short,
        d.day_of_month,
        d.day_of_year,
        d.week_start_date,
        d.week_end_date,
        d.prior_year_week_start_date,
        d.prior_year_week_end_date,
        d.week_of_year,
        d.iso_week_start_date,
        d.iso_week_end_date,
        d.prior_year_iso_week_start_date,
        d.prior_year_iso_week_end_date,
        d.iso_week_of_year,
        d.prior_year_week_of_year,
        d.prior_year_iso_week_of_year,
        d.month_of_year,
        d.month_name,
        d.month_name_short,
        d.month_start_date,
        d.month_end_date,
        d.prior_year_month_start_date,
        d.prior_year_month_end_date,
        d.quarter_of_year,
        d.quarter_start_date,
        d.quarter_end_date,
        d.year_number,
        d.year_start_date,
        d.year_end_date,
        case
            when d.day_of_week_iso in (6, 7) then 'weekend'
            else 'weekday'
        end as day_type,
        case
            when h.holiday_date is not null then true
            else false
        end as is_holiday
    from date_dim d
    left join holidays h on d.date_day = h.holiday_date
    order by d.date_day asc
)

select * from final
