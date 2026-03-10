# Testing Guidelines

## Unit Tests (Vitest)

**CRITICAL**: Use vitest for all tests. Put tests next to the code (e.g. src/\*.test.ts)

```typescript
import { describe, it, expect } from 'vitest';

describe('Feature Name', () => {
  it('should do something', () => {
    expect(true).toBe(true);
  });

  it('should handle async operations', async () => {
    const result = await someAsyncFunction();
    expect(result).toBeDefined();
  });
});
```

**Best Practices:**
- Use `describe` blocks to group related tests
- Use `it` for individual test cases
- Use `expect` for assertions
- Tests run with `npm test` (runs `vitest run`)

❌ **Do not write unit tests for:**
- SQL files under `config/queries/` - little value in testing static SQL
- Types associated with queries - these are just schema definitions

## Smoke Test (Playwright)

The template includes a smoke test at `tests/smoke.spec.ts` that verifies the app loads correctly.

**⚠️ MUST UPDATE after customizing the app:**
- The heading selector checks for `'Minimal Databricks App'` — change it to match your app's actual title
- The text assertion checks for `'hello world'` — update or remove it to match your app's content
- Failing to update these will cause the smoke test to fail on `databricks apps validate`

```typescript
// tests/smoke.spec.ts - update these selectors:
// ⚠️ PLAYWRIGHT STRICT MODE: each selector must match exactly ONE element.
// Use { exact: true }, .first(), or role-based selectors. See "Playwright Strict Mode" below.

// ❌ Template default - will fail after customization
await expect(page.getByRole('heading', { name: 'Minimal Databricks App' })).toBeVisible();
await expect(page.getByText('hello world')).toBeVisible();

// ✅ Update to match YOUR app
await expect(page.getByRole('heading', { name: 'Your App Title' })).toBeVisible();
await expect(page.locator('h1').first()).toBeVisible({ timeout: 30000 });  // Or just check any h1
```

**What the smoke test does:**
- Opens the app
- Waits for data to load (SQL query results)
- Verifies key UI elements are visible
- Captures screenshots and console logs to `.smoke-test/` directory
- Always captures artifacts, even on test failure

## Playwright Strict Mode

Playwright uses strict mode by default — selectors matching multiple elements WILL FAIL.

### Selector Priority (use in this order)

1. ✅ `getByRole('heading', { name: 'Your App Title' })` — headings (most reliable)
2. ✅ `getByRole('button', { name: 'Submit' })` — interactive elements
3. ✅ `getByText('Unique text', { exact: true })` — exact match for unique strings
4. ⚠️ `getByText('Common text').first()` — last resort for repeated text
5. ❌ `getByText('Revenue')` — NEVER without `exact` or `.first()` (strict mode will fail)

**Common mistake**: text like "Revenue" may appear in a heading, a card, AND a description. Always verify your selector targets exactly ONE element.

```typescript
// ❌ FAILS if "Revenue" appears in multiple places (heading + card + description)
await expect(page.getByText('Revenue')).toBeVisible();

// ✅ Use role-based selectors for headings
await expect(page.getByRole('heading', { name: 'Revenue Dashboard' })).toBeVisible();

// ✅ Use exact matching
await expect(page.getByText('Revenue', { exact: true })).toBeVisible();

// ✅ Use .first() as last resort
await expect(page.getByText('Revenue').first()).toBeVisible();
```

**Keep smoke tests simple:**
- Only verify that the app loads and displays initial data
- Wait for key elements to appear (page title, main content)
- Capture artifacts for debugging
- Run quickly (< 5 seconds)

**For extended E2E tests:**
- Create separate test files in `tests/` directory (e.g., `tests/user-flow.spec.ts`)
- Use `npm run test:e2e` to run all Playwright tests
- Keep complex user flows, interactions, and edge cases out of the smoke test
