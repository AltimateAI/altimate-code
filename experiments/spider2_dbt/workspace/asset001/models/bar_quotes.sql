-- Aggregates and computes average bid, ask, and mid prices for each ticker on a daily basis.
select
    date,
    concat(ticker, ts) as tt_key,
    ts,
    ticker,
    avg(bid_pr) as avg_bid_pr,
    avg(ask_pr) as avg_ask_pr,
    avg((bid_pr + ask_pr) / 2.0) as avg_mid_pr
from {{ ref('stg_quotes') }}
group by
    date,
    ts,
    ticker
