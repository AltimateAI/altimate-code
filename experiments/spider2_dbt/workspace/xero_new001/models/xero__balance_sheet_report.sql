with general_ledger as (

    select *
    from {{ ref('xero__general_ledger') }}

), balance_sheet_accounts as (

    -- Filter to balance sheet accounts: assets, liabilities, equity
    select *
    from general_ledger
    where account_class in ('ASSET', 'LIABILITY', 'EQUITY')

), calendar_spine as (

    select *
    from {{ ref('xero__calendar_spine') }}

), account_months as (

    -- Get all distinct account + source_relation combinations
    select distinct
        account_id,
        account_name,
        account_code,
        account_class,
        account_type,
        source_relation
    from balance_sheet_accounts

), monthly_journal_totals as (

    -- Aggregate net_amount per account per month
    select
        date_trunc('month', journal_date) as date_month,
        account_id,
        source_relation,
        sum(net_amount) as period_net_amount

    from balance_sheet_accounts
    group by 1, 2, 3

), spine_with_accounts as (

    -- Cross join accounts with calendar spine to get every month for every account
    select
        calendar_spine.date_month,
        account_months.account_id,
        account_months.account_name,
        account_months.account_code,
        account_months.account_class,
        account_months.account_type,
        account_months.source_relation

    from calendar_spine
    cross join account_months

), joined as (

    select
        spine_with_accounts.date_month,
        spine_with_accounts.account_name,
        spine_with_accounts.account_code,
        spine_with_accounts.account_class,
        spine_with_accounts.account_id,
        spine_with_accounts.account_type,
        coalesce(monthly_journal_totals.period_net_amount, 0) as period_net_amount,
        spine_with_accounts.source_relation

    from spine_with_accounts
    left join monthly_journal_totals
        on spine_with_accounts.date_month = monthly_journal_totals.date_month
        and spine_with_accounts.account_id = monthly_journal_totals.account_id
        and spine_with_accounts.source_relation = monthly_journal_totals.source_relation

), cumulative_balance as (

    -- Calculate the running cumulative balance for each account over time
    select
        date_month,
        account_name,
        account_code,
        account_class,
        account_id,
        account_type,
        source_relation,
        sum(period_net_amount) over (
            partition by account_id, source_relation
            order by date_month
            rows between unbounded preceding and current row
        ) as net_amount

    from joined

)

select
    date_month,
    account_name,
    account_code,
    account_class,
    account_id,
    account_type,
    net_amount,
    source_relation

from cumulative_balance
