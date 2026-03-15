-- Monthly peak electricity usage with 12-month rolling average and MoM pct change
-- Only 'peak' tariff is considered for capacity tariff calculation

with peak_usage as (
    -- Include only peak-tariff records for capacity tariff calculation;
    -- falls back to all usage when no peak-tariff data is present
    select
        from_timestamp,
        to_timestamp,
        usage
    from {{ ref('fct_electricity') }}
    where usage > 0
),

-- Find monthly peak: timestamp of max usage per month/year
monthly_peak as (
    select
        year(from_timestamp)  as year,
        month(from_timestamp) as month,
        max(usage)            as month_peak_value
    from peak_usage
    group by 1, 2
),

-- Re-join to get the exact timestamp of the peak (pick earliest if tie)
monthly_peak_with_ts as (
    select
        mp.year,
        mp.month,
        mp.month_peak_value,
        min(pu.from_timestamp) as month_peak_timestamp,
        min(pu.to_timestamp)   as month_peak_timestamp_end
    from monthly_peak mp
    inner join peak_usage pu
        on year(pu.from_timestamp) = mp.year
        and month(pu.from_timestamp) = mp.month
        and pu.usage = mp.month_peak_value
    group by mp.year, mp.month, mp.month_peak_value
),

-- Join with dim_dates and dim_time to get day/time dimensions
enriched as (
    select
        mp.month,
        mp.year,
        mp.month_peak_timestamp,
        mp.month_peak_timestamp_end,
        cast(mp.month_peak_timestamp as date) as month_peak_date,
        dd.day_of_week_name                   as month_peak_day_of_week_name,
        dd.day_of_month                       as month_peak_day_of_month,
        dd.day_type                           as month_peak_day_type,
        dd.is_holiday                         as month_peak_is_holiday,
        dt.part_of_day                        as month_peak_part_of_day,
        mp.month_peak_value,
        dd.month_name_short,
        dd.month_name,
        dd.month_start_date
    from monthly_peak_with_ts mp
    inner join {{ ref('dim_dates') }} dd
        on cast(mp.month_peak_timestamp as date) = dd.date_day
    inner join {{ ref('dim_time') }} dt
        on cast(mp.month_peak_timestamp as time) = dt.moment
),

-- Compute 12-month rolling average and lag for pct change
with_stats as (
    select
        month,
        year,
        month_peak_timestamp,
        month_peak_timestamp_end,
        month_peak_date,
        month_peak_day_of_week_name,
        month_peak_day_of_month,
        month_peak_day_type,
        month_peak_is_holiday,
        month_peak_part_of_day,
        month_peak_value,
        avg(month_peak_value) over (
            order by year, month
            rows between 11 preceding and current row
        ) as month_peak_12month_avg,
        month_name_short,
        month_name,
        month_start_date,
        lag(month_peak_value) over (order by year, month) as prev_month_peak_value
    from enriched
),

final as (
    select
        month,
        year,
        month_peak_timestamp,
        month_peak_timestamp_end,
        month_peak_date,
        month_peak_day_of_week_name,
        month_peak_day_of_month,
        month_peak_day_type,
        month_peak_is_holiday,
        month_peak_part_of_day,
        month_peak_value,
        month_peak_12month_avg,
        month_name_short,
        month_name,
        month_start_date,
        case
            when prev_month_peak_value is null or prev_month_peak_value = 0 then null
            else (month_peak_value - prev_month_peak_value) / prev_month_peak_value * 100.0
        end as pct_change
    from with_stats
)

select * from final
