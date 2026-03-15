with constructors as (
  select constructorId as constructor_id,
         constructorRef as constructor_ref,
         name as constructor_name,
         nationality as constructor_nationality,
         url as constructor_url
    from {{ source('f1_dataset', 'constructors') }}
)

select *
  from constructors