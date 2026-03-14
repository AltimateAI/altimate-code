# Write Snowflake UDFs

Use the Knowledge Hub to create guidance for LLMs to build Snowflake UDFs with best practices, examples, and auto-generated documentation.

## Overview

Writing consistent, well-documented Snowflake UDFs across a team is challenging without shared standards. This example shows how to create a Knowledge Hub artifact that guides LLMs in generating UDFs that follow your organization's best practices.

## Workflow

### 1. Set up the Knowledge Hub guide

Create a Knowledge Hub artifact titled "Snowflake UDFs For LLMs" containing:

- Your organization's UDF naming conventions
- Best practices for input validation and error handling
- Code style guidelines (e.g., always include `COMMENT` clauses)
- Example UDFs demonstrating the patterns

### 2. Prompt the agent

With the Knowledge Hub loaded, prompt the agent:

```
Create a set of UDFs that validate user emails and phone numbers
for my user table in Snowflake
```

### 3. Generated UDFs

The agent generates well-structured UDFs following your Knowledge Hub patterns:

| UDF | Description |
|---|---|
| `validate_email(email VARCHAR)` | Validates email format using regex patterns |
| `validate_email_domain(email VARCHAR)` | Validates email and categorizes the domain type |
| `validate_phone(phone_number VARCHAR)` | Checks phone number format and length |
| `format_phone_number(phone_number VARCHAR)` | Formats numbers with country code |
| `validate_username(username VARCHAR)` | Validates usernames by length and character rules |
| `mask_pii(value VARCHAR)` | Masks personally identifiable information for safe display |

### 4. Auto-generated documentation

The agent also produces a `README.md` summarizing all UDFs with:

- Function signatures and return types
- Usage examples for each UDF
- Edge case behavior
- Dependencies between functions

## Key features

| Feature | Description |
|---|---|
| **Knowledge Hub** | Ensures generated UDFs follow your team's conventions |
| **Batch generation** | Creates multiple related UDFs in a single pass |
| **Auto-documentation** | Generates README and inline comments automatically |
| **Best practices** | Includes input validation, error handling, and PII masking by default |

## Try it

See the full interactive walkthrough on the [Datamates documentation site](https://datamates-docs.myaltimate.com/examples/write-snowflake-udfs/).
