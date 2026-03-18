# Documentation Standards

## Model Descriptions

A good model description answers four questions:

1. **What**: What business entity or metric does this represent?
2. **Why**: Who uses it and for what purpose?
3. **How**: Key transformations (joins, filters, aggregations)
4. **Grain**: What does one row represent?

### Good Example
```yaml
description: >
  Daily revenue by product category. One row per category per day.
  Joins staged orders with product dimensions, calculates gross and net revenue.
  Used by the finance team for P&L reporting and the marketing team for
  campaign attribution.
```

### Bad Example
```yaml
description: "This model contains daily revenue data."
```

## Column Descriptions

### Primary Keys
State that it's a primary key and where it originates:
```yaml
- name: order_id
  description: "Primary key. Unique identifier for each order, sourced from the orders table in Stripe."
```

### Foreign Keys
State what it references:
```yaml
- name: customer_id
  description: "Foreign key to dim_customers. The customer who placed this order."
```

### Calculated Columns
Include the formula:
```yaml
- name: net_revenue
  description: "Gross revenue minus refunds and discounts. Formula: gross_amount - refund_amount - discount_amount. Can be negative."
```

### Status/Category Columns
List the possible values:
```yaml
- name: order_status
  description: "Current order status. Values: pending, shipped, delivered, cancelled, refunded."
```

### Timestamps
State what event they represent:
```yaml
- name: shipped_at
  description: "Timestamp when the order was shipped. NULL if not yet shipped. UTC timezone."
```

## Doc Blocks (Shared Definitions)

For definitions reused across multiple models, create doc blocks:

```markdown
-- docs/shared_definitions.md
{% docs customer_id %}
Unique identifier for a customer. Sourced from the customers table
in the CRM system. Used as the primary join key across all
customer-related models.
{% enddocs %}
```

Reference in YAML:
```yaml
- name: customer_id
  description: "{{ doc('customer_id') }}"
```

## Anti-Patterns

| Anti-Pattern | Why It's Bad | Better Approach |
|-------------|-------------|-----------------|
| `"The order ID"` | Just restates the column name | Describe origin and business meaning |
| `"See code"` | Defeats the purpose of docs | Summarize the logic |
| `""` (empty) | Missing documentation | Write something, even if brief |
| Technical jargon only | Business users can't understand | Lead with business meaning, add technical detail after |

## Official Documentation

- **dbt documentation**: https://docs.getdbt.com/docs/build/documentation
- **Doc blocks**: https://docs.getdbt.com/docs/build/documentation#using-docs-blocks
