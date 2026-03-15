/*
Table that unions accounts payable (bills) and accounts receivable (invoices) with
supplier/customer details, payment status, balance, overdue days, and financial info.
*/

with bill_join as (

    select *
    from {{ ref('int_quickbooks__bill_join') }}
),

invoice_join as (

    select *
    from {{ ref('int_quickbooks__invoice_join') }}
),

vendors as (

    select *
    from {{ ref('stg_quickbooks__vendor') }}
),

customers as (

    select *
    from {{ ref('stg_quickbooks__customer') }}
),

departments as (

    select *
    from {{ ref('stg_quickbooks__department') }}
),

{% if var('using_address', True) %}
addresses as (

    select *
    from {{ ref('stg_quickbooks__address') }}
),
{% endif %}

bills_enhanced as (

    select
        bill_join.transaction_type,
        bill_join.transaction_id,
        bill_join.source_relation,
        bill_join.doc_number,
        cast(null as {{ dbt.type_string() }}) as estimate_id,
        departments.name as department_name,
        'vendor' as transaction_with,
        vendors.display_name as customer_vendor_name,
        vendors.balance as customer_vendor_balance,

        {% if var('using_address', True) %}
        addresses.city as customer_vendor_address_city,
        addresses.country as customer_vendor_address_country,
        coalesce(addresses.address_1, addresses.address_2) as customer_vendor_address_line,
        {% else %}
        cast(null as {{ dbt.type_string() }}) as customer_vendor_address_city,
        cast(null as {{ dbt.type_string() }}) as customer_vendor_address_country,
        cast(null as {{ dbt.type_string() }}) as customer_vendor_address_line,
        {% endif %}

        cast(vendors.web_url as {{ dbt.type_string() }}) as customer_vendor_website,
        cast(null as {{ dbt.type_string() }}) as delivery_type,
        cast(null as {{ dbt.type_string() }}) as estimate_status,
        bill_join.total_amount,
        bill_join.total_converted_amount,
        cast(null as {{ dbt.type_numeric() }}) as estimate_total_amount,
        cast(null as {{ dbt.type_numeric() }}) as estimate_total_converted_amount,
        bill_join.current_balance,
        bill_join.total_current_payment,
        bill_join.total_current_converted_payment,
        bill_join.due_date,
        case
            when bill_join.current_balance > 0 and bill_join.due_date < current_date
                then true
            else false
        end as is_overdue,
        case
            when bill_join.due_date is not null
                then {{ dbt.datediff('bill_join.due_date', 'coalesce(bill_join.recent_payment_date, current_date)', 'day') }}
            else null
        end as days_overdue,
        bill_join.initial_payment_date,
        bill_join.recent_payment_date

    from bill_join

    left join vendors
        on bill_join.vendor_id = vendors.vendor_id
        and bill_join.source_relation = vendors.source_relation

    left join departments
        on bill_join.department_id = departments.department_id
        and bill_join.source_relation = departments.source_relation

    {% if var('using_address', True) %}
    left join addresses
        on vendors.billing_address_id = addresses.address_id
        and vendors.source_relation = addresses.source_relation
    {% endif %}
),

invoices_enhanced as (

    select
        invoice_join.transaction_type,
        invoice_join.transaction_id,
        invoice_join.source_relation,
        invoice_join.doc_number,
        invoice_join.estimate_id,
        departments.name as department_name,
        'customer' as transaction_with,
        customers.display_name as customer_vendor_name,
        customers.balance as customer_vendor_balance,

        {% if var('using_address', True) %}
        addresses.city as customer_vendor_address_city,
        addresses.country as customer_vendor_address_country,
        coalesce(addresses.address_1, addresses.address_2) as customer_vendor_address_line,
        {% else %}
        cast(null as {{ dbt.type_string() }}) as customer_vendor_address_city,
        cast(null as {{ dbt.type_string() }}) as customer_vendor_address_country,
        cast(null as {{ dbt.type_string() }}) as customer_vendor_address_line,
        {% endif %}

        cast(customers.website as {{ dbt.type_string() }}) as customer_vendor_website,
        invoice_join.delivery_type,
        invoice_join.estimate_status,
        invoice_join.total_amount,
        invoice_join.total_converted_amount,
        invoice_join.estimate_total_amount,
        invoice_join.estimate_total_converted_amount,
        invoice_join.current_balance,
        invoice_join.total_current_payment,
        invoice_join.total_current_converted_payment,
        invoice_join.due_date,
        case
            when invoice_join.current_balance > 0 and invoice_join.due_date < current_date
                then true
            else false
        end as is_overdue,
        case
            when invoice_join.due_date is not null
                then {{ dbt.datediff('invoice_join.due_date', 'coalesce(invoice_join.recent_payment_date, current_date)', 'day') }}
            else null
        end as days_overdue,
        invoice_join.initial_payment_date,
        invoice_join.recent_payment_date

    from invoice_join

    left join customers
        on invoice_join.customer_id = customers.customer_id
        and invoice_join.source_relation = customers.source_relation

    left join departments
        on invoice_join.department_id = departments.department_id
        and invoice_join.source_relation = departments.source_relation

    {% if var('using_address', True) %}
    left join addresses
        on invoice_join.billing_address_id = addresses.address_id
        and invoice_join.source_relation = addresses.source_relation
    {% endif %}
),

final as (

    select * from bills_enhanced

    union all

    select * from invoices_enhanced
)

select *
from final
