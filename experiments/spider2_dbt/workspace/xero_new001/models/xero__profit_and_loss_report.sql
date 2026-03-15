with general_ledger as (

    select *
    from {{ ref('xero__general_ledger') }}

), pl_accounts as (

    -- Filter to revenue and expense accounts only (P&L accounts)
    select *
    from general_ledger
    where account_class in ('REVENUE', 'EXPENSE')

), monthly_aggregated as (

    select
        date_trunc('month', journal_date) as date_month,
        account_id,
        account_name,
        account_code,
        account_type,
        account_class,
        source_relation,
        sum(net_amount) as net_amount

    from pl_accounts
    group by 1, 2, 3, 4, 5, 6, 7

)

select
    {{ dbt_utils.generate_surrogate_key(['date_month', 'account_id', 'source_relation']) }} as profit_and_loss_id,
    date_month,
    account_id,
    account_name,
    account_code,
    account_type,
    account_class,
    net_amount,
    source_relation

from monthly_aggregated
