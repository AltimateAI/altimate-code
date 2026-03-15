-- Calculates the total book value of shares using the average mid price for each ticker.
select
    ps.tt_key,
    ps.ticker,
    ps.ts,
    ps.shares,
    ps.shares * bq.avg_mid_pr as value
from {{ ref('positions_shares') }} ps
join {{ ref('bar_quotes') }} bq
    on ps.ticker = bq.ticker
    and ps.ts = bq.ts
