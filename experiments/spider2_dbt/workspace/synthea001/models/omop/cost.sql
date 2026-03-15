WITH all_costs AS (
    SELECT * FROM {{ ref('int__cost_condition') }}
    UNION ALL
    SELECT * FROM {{ ref('int__cost_drug_exposure_1') }}
    UNION ALL
    SELECT * FROM {{ ref('int__cost_drug_exposure_2') }}
    UNION ALL
    SELECT * FROM {{ ref('int__cost_procedure') }}
)

SELECT
    row_number() OVER (ORDER BY cost_event_id) AS cost_id
    , amount_allowed
    , cost_domain_id
    , cost_event_id
    , cost_type_concept_id
    , currency_concept_id
    , drg_concept_id
    , drg_source_value
    , paid_by_patient
    , paid_by_payer
    , paid_by_primary
    , paid_dispensing_fee
    , paid_ingredient_cost
    , paid_patient_coinsurance
    , paid_patient_copay
    , paid_patient_deductible
    , payer_plan_period_id
    , revenue_code_concept_id
    , revenue_code_source_value
    , total_charge
    , total_cost
    , total_paid
FROM all_costs
