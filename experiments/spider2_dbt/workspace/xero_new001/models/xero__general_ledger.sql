with journal_lines as (

    select *
    from {{ var('journal_line') }}

), journals as (

    select *
    from {{ var('journal') }}

), accounts as (

    select *
    from {{ var('account') }}

), invoices as (

    select *
    from {{ var('invoice') }}

), bank_transactions as (

    select *
    from {{ var('bank_transaction') }}

), credit_notes as (

    select *
    from {{ var('credit_note') }}

), contacts as (

    select *
    from {{ var('contact') }}

), joined as (

    select
        journal_lines.journal_line_id,
        journals.journal_id,
        journals.created_date_utc,
        journals.journal_date,
        journals.journal_number,
        journals.reference,
        journals.source_id,
        journals.source_type,
        journal_lines.account_code,
        journal_lines.account_id,
        journal_lines.account_name,
        journal_lines.account_type,
        journal_lines.description,
        journal_lines.gross_amount,
        journal_lines.net_amount,
        journal_lines.tax_amount,
        journal_lines.tax_name,
        journal_lines.tax_type,
        accounts.account_class,

        -- invoice_id when source is invoice-based
        case
            when journals.source_type in ('ACCREC', 'ACCPAY')
                then journals.source_id
            else null
        end as invoice_id,

        -- bank_transaction_id when source is bank transaction
        case
            when journals.source_type in ('CASHREC', 'CASHPAID')
                then journals.source_id
            else null
        end as bank_transaction_id,

        -- bank_transfer_id when source is a transfer
        case
            when journals.source_type = 'TRANSFER'
                then journals.source_id
            else null
        end as bank_transfer_id,

        -- manual_journal_id when source is manual journal
        case
            when journals.source_type = 'MANJOURNAL'
                then journals.source_id
            else null
        end as manual_journal_id,

        -- payment_id when source is a payment type
        case
            when journals.source_type in ('ACCPAYPAYMENT', 'ACCRECPAYMENT', 'APCREDITPAYMENT')
                then journals.source_id
            else null
        end as payment_id,

        -- credit_note_id when source is a credit note
        case
            when journals.source_type = 'ACCPAYCREDIT'
                then journals.source_id
            else null
        end as credit_note_id,

        -- resolve contact_id from invoices, bank transactions, or credit notes
        coalesce(
            invoices.contact_id,
            bank_transactions.contact_id,
            credit_notes.contact_id
        ) as contact_id,

        contacts.contact_name,

        journal_lines.source_relation

    from journal_lines
    inner join journals
        on journal_lines.journal_id = journals.journal_id
        and journal_lines.source_relation = journals.source_relation
    left join accounts
        on journal_lines.account_id = accounts.account_id
        and journal_lines.source_relation = accounts.source_relation
    left join invoices
        on journals.source_id = invoices.invoice_id
        and journals.source_relation = invoices.source_relation
        and journals.source_type in ('ACCREC', 'ACCPAY')
    left join bank_transactions
        on journals.source_id = bank_transactions.bank_transaction_id
        and journals.source_relation = bank_transactions.source_relation
        and journals.source_type in ('CASHREC', 'CASHPAID')
    left join credit_notes
        on journals.source_id = credit_notes.credit_note_id
        and journals.source_relation = credit_notes.source_relation
        and journals.source_type = 'ACCPAYCREDIT'
    left join contacts
        on coalesce(
            invoices.contact_id,
            bank_transactions.contact_id,
            credit_notes.contact_id
        ) = contacts.contact_id
        and journal_lines.source_relation = contacts.source_relation

)

select *
from joined
